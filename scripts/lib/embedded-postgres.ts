import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * Development and test Postgres without Docker, using the embedded-postgres binaries (PostgreSQL 17).
 * Production and CI use a real PostgreSQL server; this is only a local convenience.
 * Note: these binaries do not include pgvector or pg_dump.
 */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No port'))));
    });
  });
}

export interface EmbeddedCluster {
  url(database: string): string;
  createDatabase(name: string): Promise<void>;
  stop(): Promise<void>;
}

export async function startEmbeddedPostgres(options: { dataDir: string; port?: number; user?: string; password?: string; persistent?: boolean }): Promise<EmbeddedCluster> {
  const port = options.port ?? (await freePort());
  const user = options.user ?? 'postgres';
  const password = options.password ?? 'postgres';
  const persistent = options.persistent ?? false;
  const cluster = new EmbeddedPostgres({ databaseDir: options.dataDir, user, password, port, persistent, authMethod: 'scram-sha-256', initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
  const initialised = existsSync(`${options.dataDir}/PG_VERSION`);
  if (!initialised) {
    await mkdir(options.dataDir, { recursive: true });
    await cluster.initialise();
  }
  await cluster.start();
  return {
    url: (database) => `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`,
    createDatabase: (name) => cluster.createDatabase(name),
    stop: () => cluster.stop(),
  };
}
