import type { Database } from '@opentradie/database';
import { dispatchOutbox } from './outbox.js';
import type { PostgresJobQueue, TaskHandler } from './job-queue.js';

/**
 * The background worker loop shared by apps/worker and the in-process API worker. A database
 * error in one iteration (connection terminated, server restarting, connections refused) must
 * not end the loop: the iteration counts as idle, the loop waits and retries, and the pool
 * reconnects on the next checkout. Leased tasks whose run was interrupted are retried or
 * reclaimed after their lease expires.
 */
export async function runWorkerLoop(options: {
  db: Database;
  queue: PostgresJobQueue;
  workerId: string;
  handlers: Record<string, TaskHandler>;
  /** Dispatch the transactional outbox each iteration (false when another process does). */
  dispatch?: boolean;
  shouldStop: () => boolean;
  idleMs?: number;
  leaseMs?: number;
}): Promise<void> {
  const idleMs = options.idleMs ?? 2_000;
  while (!options.shouldStop()) {
    const dispatched =
      options.dispatch === false
        ? 0
        : await dispatchOutbox(options.db, options.queue).catch(() => 0);
    const processed = await options.queue
      .runOnce(
        options.workerId,
        options.handlers,
        options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs },
      )
      .catch(() => 0);
    if (processed === 0 && dispatched === 0 && !options.shouldStop())
      await new Promise((resolve) => setTimeout(resolve, idleMs));
  }
}
