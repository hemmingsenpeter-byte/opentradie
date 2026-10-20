import { hostname } from 'node:os';
import { createDatabase, migrate } from '@opentradie/database';
import { noMailConnections } from '@opentradie/integrations/mail';
import {
  createAccountingRuntime,
  createMailRuntime,
  createTaskHandlers,
  PostgresJobQueue,
  runWorkerLoop,
} from '@opentradie/platform';
import { buildApp, collectionsClock } from './app.js';
import { createCollectionsTaskHandlers } from './services/collections.js';
import { createInboxTaskHandlers } from './services/inbox.js';
import { createVoiceTaskHandlers } from './services/voice-notes.js';
import { loadConfig } from './config.js';
import { createAdapters, createAgentRuntime, prepareAuthoritativeDatabase } from './runtime.js';

async function main(): Promise<void> {
  const config = loadConfig();
  if (process.env.MIGRATE_ON_START === 'true') {
    const migrator = createDatabase(config.databaseUrl, { max: 1 });
    try {
      await migrate(migrator);
    } finally {
      await migrator.close();
    }
  }
  const db = await prepareAuthoritativeDatabase(config);
  const runtime = createAgentRuntime(config);
  const { fileStore, embeddingProvider, speech } = createAdapters(config);
  const queue = new PostgresJobQueue(db);
  // One accounting runtime for the API and the in-process worker (ADR 0023).
  const accounting = createAccountingRuntime(config, db);
  // One mail runtime for the routes and the inbox.send handler (ADR 0026).
  const mailRuntime = createMailRuntime(config, db);
  const app = await buildApp({
    db,
    runtime,
    config,
    fileStore,
    embeddingProvider,
    queue,
    accounting,
    mailRuntime,
  });

  // Single-container deployments run the background worker in-process; set RUN_WORKER=false
  // when apps/worker runs as its own process.
  let stopWorker = false;
  // Inbox tasks need the agent runtime and mail connections, which only this process has, so the
  // API always runs them; the platform handlers and the outbox dispatcher move to apps/worker when
  // RUN_WORKER=false. Voice notes likewise need the agent runtime and the speech adapter.
  const runPlatform = process.env.RUN_WORKER !== 'false';
  const inboxHandlers = {
    ...createInboxTaskHandlers({
      db,
      runtime,
      config,
      mail: mailRuntime?.mail ?? noMailConnections,
    }),
    ...createVoiceTaskHandlers({ db, runtime, config, fileStore, speech, queue }),
    // Follow-ups may queue inbox.send, which only this process runs.
    ...createCollectionsTaskHandlers({
      db,
      queue,
      mail: mailRuntime?.mail ?? noMailConnections,
      ...collectionsClock(config.collectionsTestNow),
    }),
  };
  const handlers = runPlatform
    ? {
        ...createTaskHandlers({
          queue,
          privacyMode: config.privacyMode,
          embeddingProvider,
          accounting,
        }),
        ...inboxHandlers,
      }
    : inboxHandlers;
  const workerId = `api:${hostname()}:${process.pid}`;
  const workerLoop = runWorkerLoop({
    db,
    queue,
    workerId,
    handlers,
    dispatch: runPlatform,
    shouldStop: () => stopWorker,
  });

  app.addHook('onClose', async () => {
    stopWorker = true;
    await workerLoop;
    await runtime.close();
    await db.close();
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().catch(() => {
        process.exitCode = 1;
      });
    });
  }
  await app.listen({ port: config.port, host: config.host });
}

main().catch((error: unknown) => {
  // Configuration and claim errors are safe to print; they never contain secrets.
  process.stderr.write(
    `OPENTRADIE API failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exit(1);
});
