import { hostname } from 'node:os';
import { createDatabase, migrate } from '@opentradie/database';
import { noMailConnections } from '@opentradie/integrations/mail';
import { createTaskHandlers, PostgresJobQueue } from '@opentradie/platform';
import { buildApp } from './app.js';
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
  const app = await buildApp({ db, runtime, config, fileStore, embeddingProvider, queue });

  // Single-container deployments run the background worker in-process; set RUN_WORKER=false
  // when apps/worker runs as its own process.
  let stopWorker = false;
  // Inbox tasks need the agent runtime and mail connections, which only this process has, so the
  // API always runs them; the platform handlers move to apps/worker when RUN_WORKER=false.
  // Voice notes likewise need the agent runtime and the speech adapter.
  const inboxHandlers = {
    ...createInboxTaskHandlers({ db, runtime, config, mail: noMailConnections }),
    ...createVoiceTaskHandlers({ db, runtime, config, fileStore, speech, queue }),
  };
  const handlers =
    process.env.RUN_WORKER !== 'false'
      ? {
          ...createTaskHandlers({ queue, privacyMode: config.privacyMode, embeddingProvider }),
          ...inboxHandlers,
        }
      : inboxHandlers;
  const workerId = `api:${hostname()}:${process.pid}`;
  const workerLoop = (async () => {
    while (!stopWorker) {
      const processed = await queue.runOnce(workerId, handlers).catch(() => 0);
      if (processed === 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  })();

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
