import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from '@opentradie/database';

export interface Task<P = Record<string, unknown>> {
  id: string;
  tenantId: string;
  kind: string;
  payload: P;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string;
}

export interface EnqueueInput {
  tenantId: string;
  kind: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  runAt?: Date;
  maxAttempts?: number;
}

export type TaskHandler = (task: Task, context: { db: Database }) => Promise<void>;

/** Permanent failures skip remaining retries (e.g. invalid payload, policy denial). */
export class PermanentTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentTaskError';
  }
}

const taskColumns =
  'id, tenant_id AS "tenantId", kind, payload, idempotency_key AS "idempotencyKey", attempts, max_attempts AS "maxAttempts", lease_owner AS "leaseOwner"';

/**
 * Postgres-backed durable queue: at-least-once delivery, leasing with SKIP LOCKED, bounded
 * retries with exponential backoff, and a failure record per attempt. Handlers must be idempotent.
 */
export class PostgresJobQueue {
  constructor(
    private readonly db: Database,
    private readonly options: { baseRetryDelayMs?: number; maxRetryDelayMs?: number } = {},
  ) {}

  /** Enqueue inside the caller's transaction when given one, so work and its follow-up commit together. */
  async enqueue(input: EnqueueInput, client: Queryable = this.db.pool): Promise<{ id: string; created: boolean }> {
    if (!/^[a-z][a-z0-9_.]{1,63}$/.test(input.kind)) throw new Error('Invalid task kind.');
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new Error('Invalid task idempotency key.');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO scheduled_tasks(id,tenant_id,kind,payload,idempotency_key,run_at,max_attempts)
       VALUES($1,$2,$3,$4,$5,coalesce($6::timestamptz, now()),$7)
       ON CONFLICT (tenant_id,kind,idempotency_key) DO NOTHING RETURNING id`,
      [randomUUID(), input.tenantId, input.kind, JSON.stringify(input.payload), input.idempotencyKey, input.runAt?.toISOString() ?? null, input.maxAttempts ?? 5],
    );
    if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
    const existing = await client.query<{ id: string }>('SELECT id FROM scheduled_tasks WHERE tenant_id=$1 AND kind=$2 AND idempotency_key=$3', [
      input.tenantId,
      input.kind,
      input.idempotencyKey,
    ]);
    return { id: existing.rows[0]!.id, created: false };
  }

  /** Lease ready tasks, including tasks whose previous lease expired (crashed worker). */
  async lease(workerId: string, options: { limit?: number; leaseMs?: number; kinds?: readonly string[] } = {}): Promise<Task[]> {
    await this.expireExhaustedLeases();
    const result = await this.db.pool.query<Task>(
      `UPDATE scheduled_tasks SET status='leased', attempts=attempts+1, lease_owner=$1,
         lease_expires_at=now() + ($2::integer * interval '1 millisecond')
       WHERE id IN (
         SELECT id FROM scheduled_tasks
         WHERE attempts < max_attempts
           AND ((status='pending' AND run_at <= now()) OR (status='leased' AND lease_expires_at < now()))
           AND ($4::text[] IS NULL OR kind = ANY($4::text[]))
         ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT $3)
       RETURNING ${taskColumns}`,
      [workerId, options.leaseMs ?? 30_000, options.limit ?? 10, options.kinds ? [...options.kinds] : null],
    );
    return result.rows;
  }

  async complete(task: Task): Promise<boolean> {
    const result = await this.db.pool.query(
      "UPDATE scheduled_tasks SET status='completed', completed_at=now(), lease_owner=NULL, lease_expires_at=NULL, last_error=NULL WHERE id=$1 AND status='leased' AND lease_owner=$2",
      [task.id, task.leaseOwner],
    );
    return result.rowCount === 1;
  }

  async fail(task: Task, error: unknown): Promise<'retry' | 'failed' | 'lost_lease'> {
    const message = safeErrorMessage(error);
    const permanent = error instanceof PermanentTaskError;
    const base = this.options.baseRetryDelayMs ?? 1_000;
    const delay = Math.min(base * 2 ** Math.max(0, task.attempts - 1), this.options.maxRetryDelayMs ?? 300_000);
    const result = await this.db.pool.query<{ status: 'pending' | 'failed' }>(
      `UPDATE scheduled_tasks SET
         status = CASE WHEN $3 OR attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
         run_at = now() + ($4::integer * interval '1 millisecond'),
         lease_owner=NULL, lease_expires_at=NULL, last_error=$5
       WHERE id=$1 AND status='leased' AND lease_owner=$2 RETURNING status`,
      [task.id, task.leaseOwner, permanent, delay, message],
    );
    if (!result.rows[0]) return 'lost_lease';
    await this.db.pool.query('INSERT INTO scheduled_task_failures(tenant_id,task_id,attempt,error) VALUES($1,$2,$3,$4)', [
      task.tenantId,
      task.id,
      task.attempts,
      message,
    ]);
    return result.rows[0].status === 'failed' ? 'failed' : 'retry';
  }

  /** A task whose final attempt's lease expired is failed, with the lost lease recorded. */
  private async expireExhaustedLeases(): Promise<void> {
    await this.db.pool.query(
      `WITH expired AS (
         UPDATE scheduled_tasks SET status='failed', lease_owner=NULL, lease_expires_at=NULL, last_error='Lease expired on final attempt.'
         WHERE status='leased' AND lease_expires_at < now() AND attempts >= max_attempts
         RETURNING id, tenant_id, attempts)
       INSERT INTO scheduled_task_failures(tenant_id,task_id,attempt,error)
       SELECT tenant_id, id, attempts, 'Lease expired on final attempt.' FROM expired`,
    );
  }

  /** Lease and run one batch. Returns how many tasks were processed. */
  async runOnce(workerId: string, handlers: Record<string, TaskHandler>, options: { limit?: number; leaseMs?: number } = {}): Promise<number> {
    const tasks = await this.lease(workerId, { ...options, kinds: Object.keys(handlers) });
    for (const task of tasks) {
      try {
        await handlers[task.kind]!(task, { db: this.db });
        await this.complete(task);
      } catch (error) {
        await this.fail(task, error);
      }
    }
    return tasks.length;
  }
}

/** Failure records hold an error class and short message only: never payloads or provider responses. */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 500);
  return 'Unknown error';
}
