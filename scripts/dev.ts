import { spawn, type ChildProcess } from 'node:child_process';
import { createDatabase, migrate } from '@opentradie/database';
import { loadDotEnv, requireEnv, startDevDatabaseIfConfigured } from './lib/env.js';

/** pnpm dev — development database (if embedded), API with reload, worker in-process, and the Vite web app. */
loadDotEnv();
requireEnv('DATABASE_URL', 'SESSION_SECRET', 'TENANT_ID');
const cluster = await startDevDatabaseIfConfigured();
const db = createDatabase(process.env.DATABASE_URL!);
await migrate(db);
await db.close();

const children: ChildProcess[] = [
  spawn('tsx', ['watch', 'apps/api/src/server.ts'], { stdio: 'inherit', env: process.env }),
  spawn('pnpm', ['--filter', '@opentradie/web', 'dev'], { stdio: 'inherit', env: process.env }),
];
let stopping = false;
const stop = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await cluster?.stop();
  process.exit(code);
};
for (const child of children) child.on('exit', (code) => void stop(code ?? 0));
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
