import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { startEmbeddedPostgres, type EmbeddedCluster } from '../../scripts/lib/embedded-postgres.js';

declare module 'vitest' {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
    databaseSource: 'TEST_DATABASE_URL' | 'embedded-postgres';
  }
}

/**
 * CI provides TEST_DATABASE_URL (a real pgvector/pgvector:pg17 service). Locally, with no URL,
 * an embedded PostgreSQL 17 cluster is started in a temporary directory and removed afterwards.
 */
export default async function setup(project: TestProject) {
  const supplied = process.env.TEST_DATABASE_URL;
  let cluster: EmbeddedCluster | null = null;
  let dataDir: string | null = null;
  if (supplied) {
    project.provide('adminDatabaseUrl', supplied);
    project.provide('databaseSource', 'TEST_DATABASE_URL');
  } else {
    dataDir = await mkdtemp(join(tmpdir(), 'opentradie-test-pg-'));
    cluster = await startEmbeddedPostgres({ dataDir });
    project.provide('adminDatabaseUrl', cluster.url('postgres'));
    project.provide('databaseSource', 'embedded-postgres');
  }
  return async () => {
    await cluster?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  };
}
