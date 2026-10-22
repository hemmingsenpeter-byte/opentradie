import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createDatabase, migrate, seed } from '@opentradie/database';
import { freePort, startEmbeddedPostgres } from './lib/embedded-postgres.js';

/**
 * pnpm test:smoke — runs the BUILT API (dist/api/server.js, as the Dockerfile does) as a real
 * process on a real port and drives the vertical slice over HTTP with the mock agent.
 * Uses TEST_DATABASE_URL when set, otherwise a temporary embedded PostgreSQL.
 *
 * Targeting an already-running server (e.g. the Docker image): set SMOKE_BASE_URL to its URL and
 * SMOKE_DATABASE_URL to the (fresh, throwaway) database it uses. The script then does not spawn
 * a server or create/drop a database; it migrates (a no-op after MIGRATE_ON_START) and seeds that
 * database. The server must run with TENANT_ID=SMOKE_TENANT_ID (default below) and
 * APP_ORIGIN=SMOKE_APP_ORIGIN (default http://localhost:5173).
 */
const externalBase = process.env.SMOKE_BASE_URL?.replace(/\/$/, '');
const externalDatabaseUrl = process.env.SMOKE_DATABASE_URL;
if (externalBase && !externalDatabaseUrl)
  throw new Error('SMOKE_BASE_URL requires SMOKE_DATABASE_URL (the database that server uses).');
if (!externalBase && !existsSync('dist/api/server.js'))
  throw new Error('Run pnpm build first (dist/api/server.js is missing).');
const workDir = await mkdtemp(join(tmpdir(), 'opentradie-smoke-'));
const cluster =
  externalBase || process.env.TEST_DATABASE_URL
    ? null
    : await startEmbeddedPostgres({ dataDir: join(workDir, 'pg') });
const adminUrl = externalBase ? null : (process.env.TEST_DATABASE_URL ?? cluster!.url('postgres'));
const name = `ot_smoke_${randomBytes(4).toString('hex')}`;
let databaseUrl: string;
if (adminUrl) {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  databaseUrl = url.toString();
} else {
  databaseUrl = externalDatabaseUrl!;
}

const tenantId = process.env.SMOKE_TENANT_ID ?? '44444444-4444-4444-8444-444444444444';
const owner = { email: 'owner@smoke.test', password: randomBytes(12).toString('hex') };
const origin = process.env.SMOKE_APP_ORIGIN ?? 'http://localhost:5173';
const port = externalBase ? 0 : await freePort();
const base = externalBase ?? `http://127.0.0.1:${port}`;

const waitForHealth = async () => {
  let health: Response | null = null;
  for (let attempt = 0; attempt < 60 && !health?.ok; attempt++) {
    health = await fetch(`${base}/health`).catch(() => null);
    if (!health?.ok) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return health;
};
// An external server may be migrating on start; let it finish before seeding its database.
const externalHealth = externalBase ? await waitForHealth() : null;
const db = createDatabase(databaseUrl);
await migrate(db);
await seed(db, { tenantId, ownerEmail: owner.email, ownerPassword: owner.password });
await db.close();

const server = externalBase
  ? null
  : spawn(process.execPath, ['dist/api/server.js'], {
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: databaseUrl,
        SESSION_SECRET: randomBytes(32).toString('hex'),
        TENANT_ID: tenantId,
        APP_ORIGIN: origin,
        PORT: String(port),
        FILE_STORE_PATH: join(workDir, 'files'),
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });

const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(`Smoke check failed: ${message}`);
};
try {
  const health = externalHealth ?? (await waitForHealth());
  check(health?.ok, 'API did not become healthy');
  const healthBody = (await health!.json()) as {
    agent: { synthetic: boolean };
    deployment: { profile: string };
  };
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(owner),
  });
  check(login.ok, `login returned ${login.status}`);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        cookie,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify(body),
    });
  const first = (await (
    await post('/api/enquiries', { text: 'Mrs Johnson needs two power points replaced.' })
  ).json()) as { status: string; clarification: { matches: Array<{ id: string; name: string }> } };
  check(first.status === 'clarification_required', 'expected clarification');
  const margaret = first.clarification.matches.find((match) => match.name === 'Mrs Johnson')!;
  const drafted = (await (
    await post('/api/enquiries', {
      text: 'Mrs Johnson needs two power points replaced.',
      customerId: margaret.id,
    })
  ).json()) as { quoteId: string; quote: { totalCents: number } };
  check(drafted.quote.totalCents === 31_395, `unexpected total ${drafted.quote.totalCents}`);
  const approved = await post(`/api/quotes/${drafted.quoteId}/approve`, { version: 1 });
  check(approved.ok, `approve returned ${approved.status}`);
  const approvedBody = (await approved.json()) as { quote?: { version: number }; version?: number };
  const approvedVersion = approvedBody.quote?.version ?? approvedBody.version;
  // Sending renders the quote PDF, which exercises @react-pdf/renderer from the built bundle.
  const sent = await post(`/api/quotes/${drafted.quoteId}/send`, { version: approvedVersion });
  check(sent.ok, `send returned ${sent.status}`);
  const pdf = await fetch(`${base}/api/quotes/${drafted.quoteId}/pdf`, { headers: { cookie } });
  const pdfBytes = Buffer.from(await pdf.arrayBuffer());
  check(pdf.ok && pdfBytes.subarray(0, 5).toString() === '%PDF-', 'quote PDF was not rendered');
  process.stdout.write(
    `${JSON.stringify({ check: externalBase ? 'external-api-smoke' : 'built-api-smoke', passed: true, profile: healthBody.deployment.profile, agentSynthetic: healthBody.agent.synthetic, totalCents: 31_395 })}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (server) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  if (adminUrl) {
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await cleanup.end();
  }
  await cluster?.stop();
  await rm(workDir, { recursive: true, force: true });
}
