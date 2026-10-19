import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBackupCheck } from './lib/backup-check.js';
import { startEmbeddedPostgres } from './lib/embedded-postgres.js';

/**
 * pnpm test:backup — real backup and restore against PostgreSQL.
 * Uses TEST_DATABASE_URL (CI: pgvector/pgvector:pg17 + postgresql-client-17, so pg_dump runs too),
 * otherwise a temporary embedded PostgreSQL 17 cluster (logical backup only; it ships no pg_dump).
 */
let cluster: Awaited<ReturnType<typeof startEmbeddedPostgres>> | null = null;
let dataDir: string | null = null;
try {
  let adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    dataDir = await mkdtemp(join(tmpdir(), 'opentradie-backup-pg-'));
    cluster = await startEmbeddedPostgres({ dataDir });
    adminUrl = cluster.url('postgres');
    process.stdout.write(
      'Using a temporary embedded PostgreSQL 17 cluster (TEST_DATABASE_URL not set).\n',
    );
  }
  const result = await runBackupCheck(adminUrl, (line) => process.stdout.write(`${line}\n`));
  process.stdout.write(`${JSON.stringify({ check: 'backup-restore', passed: true, ...result })}\n`);
  if (process.env.REQUIRE_PG_DUMP === 'true' && !result.pgDump.verified)
    throw new Error(`pg_dump verification required but skipped: ${result.pgDump.skippedReason}`);
} catch (error) {
  process.stderr.write(
    `Backup check FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await cluster?.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}
