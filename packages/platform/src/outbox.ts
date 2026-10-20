import { transaction, type Database } from '@opentradie/database';
import type { PostgresJobQueue } from './job-queue.js';

/**
 * Transactional outbox dispatcher (ADR 0012, ADR 0023). Copies undispatched event_outbox rows
 * into the job queue, using `outbox:<id>` as the task idempotency key: dispatching the same row
 * twice (a crash between enqueue and marking it dispatched) still yields one task. Rows are
 * claimed with SKIP LOCKED, so several workers may dispatch concurrently.
 */
export async function dispatchOutbox(
  db: Database,
  queue: PostgresJobQueue,
  options: { limit?: number; maxAttempts?: number } = {},
): Promise<number> {
  return transaction(db, async (client) => {
    const pending = await client.query<{
      id: string;
      tenantId: string;
      topic: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT id,tenant_id AS "tenantId",topic,payload FROM event_outbox
       WHERE dispatched_at IS NULL ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED LIMIT $1`,
      [options.limit ?? 50],
    );
    for (const row of pending.rows) {
      const task = await queue.enqueue(
        {
          tenantId: row.tenantId,
          kind: row.topic,
          payload: { ...row.payload, outboxId: row.id },
          idempotencyKey: `outbox:${row.id}`,
          maxAttempts: options.maxAttempts ?? 8,
        },
        client,
      );
      await client.query(
        'UPDATE event_outbox SET dispatched_at=now(), attempts=attempts+1, task_id=$2 WHERE id=$1',
        [row.id, task.id],
      );
    }
    return pending.rows.length;
  });
}
