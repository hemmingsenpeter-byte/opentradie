import { MockAgentRuntime, RealOpenClawAgentRuntime } from '@opentradie/agent';
import { createDatabase } from '@opentradie/database';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const db = createDatabase(config.databaseUrl);
const runtime = config.agentMode === 'mock' ? new MockAgentRuntime() : new RealOpenClawAgentRuntime({
  url: process.env.OPENCLAW_URL ?? 'ws://127.0.0.1:18789',
  token: process.env.OPENCLAW_TOKEN ?? '',
  deviceStatePath: process.env.OPENCLAW_DEVICE_PATH ?? '.data/openclaw-device.json',
  ...(process.env.OPENCLAW_AGENT_ID ? { agentId: process.env.OPENCLAW_AGENT_ID } : {}),
});
const app = await buildApp({ db, runtime, config });
app.addHook('onClose', async () => {
  await runtime.close();
  await db.pool.end();
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void app.close().catch(() => { process.exitCode = 1; });
  });
}
try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch {
  app.log.error('API failed to start. Check database, configured port and runtime settings.');
  await app.close();
  process.exitCode = 1;
}
