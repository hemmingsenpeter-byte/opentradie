import { hostname } from 'node:os';
import { createTaskHandlers, PostgresJobQueue } from '@opentradie/platform';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createAdapters, createAgentRuntime, prepareAuthoritativeDatabase } from './runtime.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = await prepareAuthoritativeDatabase(config);
  const runtime = createAgentRuntime(config);
  const { fileStore, embeddingProvider } = createAdapters(config);
  const queue = new PostgresJobQueue(db);
  const app = await buildApp({ db, runtime, config, fileStore, embeddingProvider, queue });

  // Single-container deployments run the background worker in-process; set RUN_WORKER=false
  // when apps/worker runs as its own process.
  let stopWorker = false;
  let workerLoop: Promise<void> | null = null;
  if (process.env.RUN_WORKER !== 'false') {
    const handlers = createTaskHandlers({ queue, privacyMode: config.privacyMode, embeddingProvider });
    const workerId = `api:${hostname()}:${process.pid}`;
    workerLoop = (async () => {
      while (!stopWorker) {
        const processed = await queue.runOnce(workerId, handlers).catch(() => 0);
        if (processed === 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    })();
  }

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
  process.stderr.write(`OPENTRADIE API failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exit(1);
});
