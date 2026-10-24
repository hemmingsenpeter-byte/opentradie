import pg from 'pg';
import { PostgresJobQueue, runWorkerLoop, type TaskHandler } from '@opentradie/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { createTestContext, TENANT_A, type TestContext } from '../helpers/app.js';

/**
 * Database failure recovery against real PostgreSQL. A separate admin connection terminates every
 * backend of the test database (what a server restart or failover does to an open pool) and, in
 * the last test, refuses new connections for a while. The API must keep serving (503 while the
 * database is gone, 200 after), and the shared worker loop must survive and finish a task that
 * was running when its connection died, with exactly one effect.
 */
describe('database connection loss and recovery', () => {
  let ctx: TestContext;
  let owner: string;
  let admin: pg.Client;
  let databaseName: string;

  const terminateAll = () =>
    admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [databaseName],
    );
  const health = () => ctx.app.inject({ method: 'GET', url: '/health' });
  async function eventually<T>(
    probe: () => Promise<T>,
    ok: (value: T) => boolean,
    timeoutMs = 5_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T | undefined;
    while (Date.now() < deadline) {
      last = await probe().catch(() => undefined as T);
      if (last !== undefined && ok(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('condition not reached before timeout');
  }
  const healthOk = () =>
    eventually(health, (response) => response.statusCode === 200).then((r) => JSON.parse(r.body));

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await ctx.login('owner');
    databaseName = new URL(ctx.url).pathname.slice(1);
    admin = new pg.Client({ connectionString: inject('adminDatabaseUrl') });
    await admin.connect();
    await ctx.db.pool.query(
      'CREATE TABLE recovery_effects (task_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now())',
    );
  });
  afterAll(async () => {
    await admin?.query(`ALTER DATABASE ${databaseName} ALLOW_CONNECTIONS true`).catch(() => {});
    await admin?.end();
    await ctx?.close();
  });

  it('serves /health and authenticated mutations again after every pool connection is killed', async () => {
    const before = await health();
    expect(before.statusCode).toBe(200);
    // Fill the pool so there are several open connections to kill.
    await Promise.all(Array.from({ length: 5 }, () => ctx.db.pool.query('SELECT 1')));
    const killed = await terminateAll();
    expect(killed.rowCount).toBeGreaterThan(0);

    // The next request may see a dead connection (503) or a fresh one (200); it never crashes.
    const immediate = await health();
    expect([200, 503]).toContain(immediate.statusCode);
    const recovered = await healthOk();
    expect(recovered.database.status).toBe('ok');

    // The session survives (it is a signed cookie checked against the database).
    const created = await eventually(
      () => ctx.send('POST', '/api/customers', owner, { name: 'Recovery Customer (synthetic)' }),
      (response) => response.status === 201,
    );
    expect(created.body.name).toBe('Recovery Customer (synthetic)');
    const audit = await ctx.db.pool.query(
      'SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=$1 AND entity_id=$2',
      [TENANT_A, created.body.id],
    );
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });

  it('worker loop survives losing its connection mid-task and completes it with one effect', async () => {
    const queue = new PostgresJobQueue(ctx.db, { baseRetryDelayMs: 0 });
    const { id } = await queue.enqueue({
      tenantId: TENANT_A,
      kind: 'test.recovery_effect',
      idempotencyKey: 'mid-task-kill',
      payload: {},
    });
    let attempts = 0;
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    const handlers: Record<string, TaskHandler> = {
      'test.recovery_effect': async (task, { db }) => {
        attempts++;
        if (attempts === 1) {
          started();
          // A long query that the termination interrupts: the connection dies mid-task.
          await db.pool.query('SELECT pg_sleep(30)');
        }
        await db.pool.query('INSERT INTO recovery_effects(task_id) VALUES($1)', [task.id]);
      },
    };
    let stop = false;
    const loop = runWorkerLoop({
      db: ctx.db,
      queue,
      workerId: 'recovery-worker',
      handlers,
      dispatch: false,
      shouldStop: () => stop,
      idleMs: 50,
    });
    try {
      await inFlight;
      await eventually(
        () =>
          admin.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND query LIKE 'SELECT pg_sleep%'",
            [databaseName],
          ),
        (result) => (result.rowCount ?? 0) > 0,
      );
      await terminateAll();
      const done = await eventually(
        () => ctx.db.pool.query('SELECT status, attempts FROM scheduled_tasks WHERE id=$1', [id]),
        (result) => result.rows[0]?.status === 'completed',
        10_000,
      );
      expect(done.rows[0].attempts).toBe(2);
    } finally {
      stop = true;
      await loop;
    }
    const effects = await ctx.db.pool.query(
      'SELECT count(*)::int AS n FROM recovery_effects WHERE task_id=$1',
      [id],
    );
    expect(effects.rows[0].n).toBe(1);
    const failures = await ctx.db.pool.query(
      'SELECT error FROM scheduled_task_failures WHERE task_id=$1',
      [id],
    );
    expect(failures.rows).toHaveLength(1);
  });

  it('reports 503 while the database refuses connections, and API and worker recover after', async () => {
    const queue = new PostgresJobQueue(ctx.db, { baseRetryDelayMs: 0 });
    let effects = 0;
    const handlers: Record<string, TaskHandler> = {
      'test.recovery_blocked': async (task, { db }) => {
        await db.pool.query('INSERT INTO recovery_effects(task_id) VALUES($1)', [task.id]);
        effects++;
      },
    };
    let stop = false;
    let loop: Promise<void> | undefined;
    try {
      await admin.query(`ALTER DATABASE ${databaseName} ALLOW_CONNECTIONS false`);
      await terminateAll();
      const down = await eventually(health, (response) => response.statusCode === 503);
      const body = JSON.parse(down.body);
      expect(body.status).toBe('unavailable');
      expect(body.database.status).not.toBe('ok');
      // The worker loop keeps running through refused connections instead of exiting.
      loop = runWorkerLoop({
        db: ctx.db,
        queue,
        workerId: 'blocked-worker',
        handlers,
        dispatch: true,
        shouldStop: () => stop,
        idleMs: 50,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await health()).statusCode).toBe(503);
    } finally {
      await admin.query(`ALTER DATABASE ${databaseName} ALLOW_CONNECTIONS true`);
    }
    try {
      const recovered = await healthOk();
      expect(recovered.database.status).toBe('ok');
      const { id } = await queue.enqueue({
        tenantId: TENANT_A,
        kind: 'test.recovery_blocked',
        idempotencyKey: 'after-outage',
        payload: {},
      });
      await eventually(
        () => ctx.db.pool.query('SELECT status FROM scheduled_tasks WHERE id=$1', [id]),
        (result) => result.rows[0]?.status === 'completed',
      );
      expect(effects).toBe(1);
      const created = await eventually(
        () => ctx.send('POST', '/api/customers', owner, { name: 'After Outage (synthetic)' }),
        (response) => response.status === 201,
      );
      expect(created.body.name).toBe('After Outage (synthetic)');
    } finally {
      stop = true;
      await loop;
    }
  });
});
