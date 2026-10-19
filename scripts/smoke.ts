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
 */
if (!existsSync('dist/api/server.js'))
  throw new Error('Run pnpm build first (dist/api/server.js is missing).');
const workDir = await mkdtemp(join(tmpdir(), 'opentradie-smoke-'));
const cluster = process.env.TEST_DATABASE_URL
  ? null
  : await startEmbeddedPostgres({ dataDir: join(workDir, 'pg') });
const adminUrl = process.env.TEST_DATABASE_URL ?? cluster!.url('postgres');
const name = `ot_smoke_${randomBytes(4).toString('hex')}`;
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE ${name}`);
await admin.end();
const url = new URL(adminUrl);
url.pathname = `/${name}`;
const databaseUrl = url.toString();

const tenantId = '44444444-4444-4444-8444-444444444444';
const owner = { email: 'owner@smoke.test', password: randomBytes(12).toString('hex') };
const db = createDatabase(databaseUrl);
await migrate(db);
await seed(db, { tenantId, ownerEmail: owner.email, ownerPassword: owner.password });
await db.close();

const port = await freePort();
const origin = 'http://localhost:5173';
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist/api/server.js'], {
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
  let health: Response | null = null;
  for (let attempt = 0; attempt < 60 && !health?.ok; attempt++) {
    health = await fetch(`${base}/health`).catch(() => null);
    if (!health?.ok) await new Promise((resolve) => setTimeout(resolve, 500));
  }
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
  const margaret = first.clarification.matches.find((match) => match.name === 'Margaret Johnson')!;
  const drafted = (await (
    await post('/api/enquiries', {
      text: 'Mrs Johnson needs two power points replaced.',
      customerId: margaret.id,
    })
  ).json()) as { quoteId: string; quote: { totalCents: number } };
  check(drafted.quote.totalCents === 31_395, `unexpected total ${drafted.quote.totalCents}`);
  const approved = await post(`/api/quotes/${drafted.quoteId}/approve`, { version: 1 });
  check(approved.ok, `approve returned ${approved.status}`);
  process.stdout.write(
    `${JSON.stringify({ check: 'built-api-smoke', passed: true, profile: healthBody.deployment.profile, agentSynthetic: healthBody.agent.synthetic, totalCents: 31_395 })}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
  const cleanup = new pg.Client({ connectionString: adminUrl });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await cleanup.end();
  await cluster?.stop();
  await rm(workDir, { recursive: true, force: true });
}
