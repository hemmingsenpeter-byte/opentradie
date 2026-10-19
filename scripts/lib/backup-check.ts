import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { MockAgentRuntime } from '@opentradie/agent';
import { createDatabase, migrate, seed } from '@opentradie/database';
import {
  assertFingerprintsEqual,
  createLogicalBackup,
  createPgDumpBackup,
  fingerprintDatabase,
  LocalFileStore,
  loadRuntimeConfig,
  pgDumpAvailable,
  PostgresJobQueue,
  restoreLogicalBackup,
  restorePgDumpBackup,
} from '@opentradie/platform';
import { buildApp } from '../../apps/api/src/app.js';

const TENANT = '33333333-3333-4333-8333-333333333333';

export interface BackupCheckResult {
  tables: number;
  rows: number;
  logical: { verified: true; bytes: number; encrypted: true };
  pgDump: { verified: boolean; skippedReason: string | null };
}

async function createDb(adminUrl: string, name: string): Promise<string> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function dropDb(adminUrl: string, name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}

/**
 * Real backup/restore check: populate a database through the vertical slice, back it up, restore
 * it into fresh databases and prove every table's row count and SHA-256 checksum match.
 */
export async function runBackupCheck(
  adminUrl: string,
  log: (line: string) => void = () => {},
): Promise<BackupCheckResult> {
  const suffix = randomBytes(4).toString('hex');
  const names = {
    source: `ot_backup_src_${suffix}`,
    logical: `ot_backup_logical_${suffix}`,
    dump: `ot_backup_dump_${suffix}`,
  };
  const directory = await mkdtemp(join(tmpdir(), 'opentradie-backup-'));
  try {
    const sourceUrl = await createDb(adminUrl, names.source);
    const source = createDatabase(sourceUrl);
    await migrate(source);
    await seed(source, {
      tenantId: TENANT,
      ownerEmail: 'owner@backup.test',
      ownerPassword: 'backup-owner-password',
    });
    const config = loadRuntimeConfig({
      DATABASE_URL: sourceUrl,
      SESSION_SECRET: randomBytes(32).toString('hex'),
      TENANT_ID: TENANT,
      APP_ORIGIN: 'http://localhost:5173',
      LOG_LEVEL: 'silent',
    });
    const app = await buildApp({
      db: source,
      runtime: new MockAgentRuntime(),
      config,
      fileStore: new LocalFileStore(join(directory, 'files')),
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: config.appOrigin },
      payload: { email: 'owner@backup.test', password: 'backup-owner-password' },
    });
    const cookie = `opentradie_session=${login.cookies.find((item) => item.name === 'opentradie_session')!.value}`;
    const headers = () => ({ cookie, origin: config.appOrigin, 'idempotency-key': randomUUID() });
    const margaret = (
      await source.pool.query<{ id: string }>(
        "SELECT id FROM customers WHERE name='Margaret Johnson'",
      )
    ).rows[0]!.id;
    const drafted = await app.inject({
      method: 'POST',
      url: '/api/enquiries',
      headers: headers(),
      payload: { text: 'Mrs Johnson needs two power points replaced.', customerId: margaret },
    });
    const quoteId = (JSON.parse(drafted.body) as { quoteId: string }).quoteId;
    const approved = await app.inject({
      method: 'POST',
      url: `/api/quotes/${quoteId}/approve`,
      headers: headers(),
      payload: { version: 1 },
    });
    if (approved.statusCode !== 200)
      throw new Error(`Slice setup failed (${approved.statusCode}).`);
    const queue = new PostgresJobQueue(source, { baseRetryDelayMs: 0 });
    await queue.enqueue({
      tenantId: TENANT,
      kind: 'backup.check',
      payload: { pending: true },
      idempotencyKey: 'pending-job',
    });
    await queue.runOnce('backup-check', {
      'knowledge.embed': async () => {
        throw new Error('simulated failure for a failure record');
      },
    });
    await app.close();
    await source.close();

    const fingerprint = await fingerprintDatabase(sourceUrl);
    const tables = Object.keys(fingerprint).length;
    const rows = Object.values(fingerprint).reduce((sum, table) => sum + table.rows, 0);
    log(`source: ${tables} tables, ${rows} rows`);

    const key = randomBytes(32);
    const file = join(directory, 'backup.otbk');
    await createLogicalBackup(sourceUrl, file, { encryptionKey: key });
    const bytes = (await stat(file)).size;
    const logicalUrl = await createDb(adminUrl, names.logical);
    const target = createDatabase(logicalUrl);
    await migrate(target);
    await target.close();
    const restored = await restoreLogicalBackup(logicalUrl, file, { encryptionKey: key });
    assertFingerprintsEqual(fingerprint, restored);
    log(
      `logical backup (gzip + AES-256-GCM, ${bytes} bytes): restored and verified ${tables} tables`,
    );

    const availability = await pgDumpAvailable(sourceUrl);
    let pgDump: BackupCheckResult['pgDump'] = {
      verified: false,
      skippedReason: availability.reason,
    };
    if (availability.available) {
      const dumpFile = join(directory, 'backup.dump');
      await createPgDumpBackup(sourceUrl, dumpFile);
      const dumpUrl = await createDb(adminUrl, names.dump);
      await restorePgDumpBackup(dumpUrl, dumpFile);
      assertFingerprintsEqual(fingerprint, await fingerprintDatabase(dumpUrl));
      pgDump = { verified: true, skippedReason: null };
      log(`pg_dump/pg_restore (${availability.reason}): restored and verified ${tables} tables`);
    } else {
      log(`pg_dump check skipped: ${availability.reason}`);
    }
    return { tables, rows, logical: { verified: true, bytes, encrypted: true }, pgDump };
  } finally {
    for (const name of Object.values(names)) await dropDb(adminUrl, name).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
