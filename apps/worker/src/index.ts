import { hostname } from 'node:os';
import { createDatabase, databaseStatus } from '@opentradie/database';
import {
  claimInstallation,
  createEmbeddingProvider,
  createTaskHandlers,
  loadRuntimeConfig,
  PostgresJobQueue,
} from '@opentradie/platform';

/** Standalone background worker: leases tasks from the Postgres queue. Run with RUN_WORKER=false on the API. */
async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const db = createDatabase(config.databaseUrl, { max: 4 });
  const status = await databaseStatus(db);
  if (status.status !== 'ok') throw new Error('Database unavailable or not migrated.');
  await claimInstallation(db, {
    installationId: config.installationId,
    profile: config.profile,
    gatewayUrl: config.agent.mode === 'openclaw' ? config.agent.url : null,
  });
  const queue = new PostgresJobQueue(db);
  const handlers = createTaskHandlers({
    queue,
    privacyMode: config.privacyMode,
    embeddingProvider: createEmbeddingProvider(config.embedding),
  });
  const workerId = `worker:${hostname()}:${process.pid}`;
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => (stopping = true));
  process.stdout.write(
    `${JSON.stringify({ level: 'info', msg: 'worker started', workerId, profile: config.profile })}\n`,
  );
  while (!stopping) {
    const processed = await queue.runOnce(workerId, handlers);
    if (processed === 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  await db.close();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `OPENTRADIE worker failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exit(1);
});
