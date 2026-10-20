import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { MockAgentRuntime } from '@opentradie/agent';
import { createDatabase, migrate, seed } from '@opentradie/database';
import {
  assertFingerprintsEqual,
  fingerprintDatabase,
  LocalFileStore,
  loadRuntimeConfig,
  Restic,
  ResticError,
  runResticBackup,
  runResticRestore,
  spawnRunner,
} from '@opentradie/platform';
import { buildApp } from '../apps/api/src/app.js';

/**
 * pnpm test:restore-drill — proves a RESTORE works, not merely that backup commands exit 0.
 * Requires TEST_DATABASE_URL and the real restic binary (BACKUP_RESTIC_BINARY or `restic` on PATH).
 * Seeds a throwaway DB + file store, backs both up to a throwaway restic repository, restores the
 * snapshot into a fresh, empty, migrated database and verifies counts, a quote total, the file's
 * SHA-256, `restic check`, and that a wrong password is refused.
 */
const TENANT = '55555555-5555-4555-8555-555555555555';
const adminUrl = process.env.TEST_DATABASE_URL;
const binary = process.env.BACKUP_RESTIC_BINARY || 'restic';
const suffix = randomBytes(4).toString('hex');
const names = { source: `ot_drill_src_${suffix}`, target: `ot_drill_dst_${suffix}` };
const log = (line: string) => process.stdout.write(`${line}\n`);

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}
const dbUrl = (name: string) => {
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  return url.toString();
};
async function scalar(url: string, sql: string): Promise<string> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return String(Object.values((await client.query(sql)).rows[0] as object)[0]);
  } finally {
    await client.end();
  }
}

const work = await mkdtemp(join(tmpdir(), 'opentradie-drill-'));
try {
  if (!adminUrl) throw new Error('TEST_DATABASE_URL is required for the restore drill.');
  const version = await spawnRunner(binary, ['version'], {
    env: { PATH: process.env.PATH ?? '' },
  }).catch(() => null);
  if (!version || version.code !== 0)
    throw new Error(
      `restic binary not found (${binary}); install restic or set BACKUP_RESTIC_BINARY.`,
    );
  log(`using ${version.stdout.trim()}`);

  // 1. Seed a throwaway installation: demo data, an approved quote, and one stored file.
  await admin(`CREATE DATABASE ${names.source}`);
  const sourceUrl = dbUrl(names.source);
  const source = createDatabase(sourceUrl);
  await migrate(source);
  await seed(source, {
    tenantId: TENANT,
    ownerEmail: 'owner@drill.test',
    ownerPassword: 'drill-owner-password',
  });
  const filesDir = join(work, 'files');
  const store = new LocalFileStore(filesDir);
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
    fileStore: store,
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: config.appOrigin },
    payload: { email: 'owner@drill.test', password: 'drill-owner-password' },
  });
  const cookie = `opentradie_session=${login.cookies.find((c) => c.name === 'opentradie_session')!.value}`;
  const headers = () => ({ cookie, origin: config.appOrigin, 'idempotency-key': randomUUID() });
  const customer = (
    await source.pool.query<{ id: string }>("SELECT id FROM customers WHERE name='Mrs Johnson'")
  ).rows[0]!.id;
  const drafted = await app.inject({
    method: 'POST',
    url: '/api/enquiries',
    headers: headers(),
    payload: { text: 'Mrs Johnson needs two power points replaced.', customerId: customer },
  });
  const quoteId = (JSON.parse(drafted.body) as { quoteId: string }).quoteId;
  const approved = await app.inject({
    method: 'POST',
    url: `/api/quotes/${quoteId}/approve`,
    headers: headers(),
    payload: { version: 1 },
  });
  if (approved.statusCode !== 200) throw new Error(`Seeding failed (${approved.statusCode}).`);
  await app.close();
  await source.close();
  const fileKey = `tenants/${TENANT}/drill/photo.bin`;
  const fileBody = randomBytes(64 * 1024);
  const stored = await store.put(fileKey, fileBody);
  if (!/^[0-9a-f-]{36}$/.test(quoteId)) throw new Error('Unexpected quote id.');
  const quoteTotalSql = `SELECT total_cents FROM quotes WHERE id='${quoteId}'`;
  const quoteTotal = await scalar(sourceUrl, quoteTotalSql);
  const expected = await fingerprintDatabase(sourceUrl);
  log(`seeded ${Object.keys(expected).length} tables, quote total ${quoteTotal} cents, 1 file`);

  // 2. Encrypted restic backup to a throwaway repository with a throwaway password.
  const passwordFile = join(work, 'restic-password');
  await writeFile(passwordFile, randomBytes(24).toString('hex'), { mode: 0o600 });
  const restic = {
    repository: join(work, 'repo'),
    passwordFile,
    binary,
    cacheDir: join(work, 'cache'),
  };
  const backup = await runResticBackup({
    restic,
    retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 },
    databaseUrl: sourceUrl,
    fileStorePath: filesDir,
    installationId: 'drill-installation',
  });
  const client = new Restic(restic);
  if ((await client.init()).created) throw new Error('init was not idempotent.');
  const snapshots = await client.snapshots({ tags: ['installation:drill-installation'] });
  if (!snapshots.some((s) => s.id === backup.snapshotId)) throw new Error('snapshot not listed.');
  log(`restic snapshot ${backup.snapshotId.slice(0, 8)} tags=${backup.tags.join(',')}`);

  // 3. Fresh, empty, migrated target; restore from the snapshot and apply the logical restore.
  await admin(`DROP DATABASE ${names.source} WITH (FORCE)`);
  await admin(`CREATE DATABASE ${names.target}`);
  const targetUrl = dbUrl(names.target);
  const target = createDatabase(targetUrl);
  await migrate(target);
  await target.close();
  const restoreDir = join(work, 'restored');
  const restored = await runResticRestore(restic, {
    snapshotId: backup.snapshotId,
    target: restoreDir,
    databaseUrl: targetUrl,
  });

  // 4. Verify.
  assertFingerprintsEqual(expected, restored.fingerprint!);
  for (const [table, value] of Object.entries(expected)) {
    const rows = Number(await scalar(targetUrl, `SELECT count(*) FROM "${table}"`));
    if (rows !== value.rows) throw new Error(`row count mismatch in ${table}`);
  }
  const restoredTotal = await scalar(targetUrl, quoteTotalSql);
  if (restoredTotal !== quoteTotal) throw new Error('quote total mismatch after restore.');
  const restoredFile = await readFile(join(restoreDir, 'files', fileKey));
  const restoredSha = createHash('sha256').update(restoredFile).digest('hex');
  if (restoredSha !== stored.sha256) throw new Error('stored file SHA-256 mismatch after restore.');
  await client.check({ readData: true });
  let wrongRefused = false;
  try {
    await new Restic({
      ...restic,
      passwordFile: undefined,
      password: 'not-the-password',
    }).snapshots();
  } catch (error) {
    wrongRefused = error instanceof ResticError && error.code === 'WRONG_PASSWORD';
  }
  if (!wrongRefused) throw new Error('wrong password was not refused.');
  log(
    JSON.stringify({
      check: 'restore-drill',
      passed: true,
      tables: Object.keys(expected).length,
      rows: Object.values(expected).reduce((sum, t) => sum + t.rows, 0),
      quoteTotalCents: Number(restoredTotal),
      fileSha256Match: true,
      resticCheck: 'read-data passed',
      wrongPasswordRefused: true,
    }),
  );
} catch (error) {
  process.stderr.write(
    `Restore drill FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  for (const name of Object.values(names))
    await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
  await rm(work, { recursive: true, force: true });
}
