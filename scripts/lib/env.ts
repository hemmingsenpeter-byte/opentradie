import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startEmbeddedPostgres, type EmbeddedCluster } from './embedded-postgres.js';

/** Load .env when present. Variables already set in the environment (e.g. CI) win. */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

/**
 * When DEV_EMBEDDED_POSTGRES=true (written by `pnpm setup:dev` on machines without a Postgres
 * server), start the persistent development cluster in .data/postgres for DATABASE_URL.
 */
export async function startDevDatabaseIfConfigured(): Promise<EmbeddedCluster | null> {
  if (process.env.DEV_EMBEDDED_POSTGRES !== 'true') return null;
  const url = new URL(process.env.DATABASE_URL ?? '');
  const cluster = await startEmbeddedPostgres({
    dataDir: resolve(process.env.DEV_POSTGRES_DIR ?? '.data/postgres'),
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    persistent: true,
  });
  const database = url.pathname.slice(1);
  await cluster.createDatabase(database).catch(() => {}); // already exists
  return cluster;
}

export function requireEnv(...names: string[]): Record<string, string> {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length)
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. Run pnpm setup:dev or see .env.example.`,
    );
  return Object.fromEntries(names.map((name) => [name, process.env[name]!]));
}
