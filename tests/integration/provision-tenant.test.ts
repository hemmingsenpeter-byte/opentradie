import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MockAgentRuntime } from '@opentradie/agent';
import { provisionTenant, seed, type Database } from '@opentradie/database';
import { LocalFileStore, loadRuntimeConfig } from '@opentradie/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { baseEnv } from '../helpers/app.js';
import { createTestDatabase } from '../helpers/db.js';

const run = promisify(execFile);
const RATES = `code,description,unit,price_excl_gst_nzd
call_out,Call-out fee (per visit),visit,85
labour_hour,Labour (per hour),hour,"$1,234.50"
tap_washer,Replace tap washer,each,45.5
`;
const PASSWORD = 'a-real-owner-passphrase';

async function counts(db: Database) {
  const row = await db.pool.query(
    `SELECT (SELECT count(*) FROM businesses)::int AS businesses, (SELECT count(*) FROM users)::int AS users,
       (SELECT count(*) FROM approved_rates)::int AS rates, (SELECT count(*) FROM customers)::int AS customers,
       (SELECT count(*) FROM audit_events)::int AS audits`,
  );
  return row.rows[0];
}

describe('pnpm provision:tenant', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let dir: string;
  const tenantId = randomUUID();
  const cli = (args: string[], env: Record<string, string> = {}) =>
    run('npx', ['tsx', 'scripts/provision-tenant.ts', ...args], {
      env: { ...process.env, DATABASE_URL: database.url, TENANT_ID: '', ...env },
    }).then(
      (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
      (e: { code: number; stdout: string; stderr: string }) => e,
    );
  const args = () => [
    '--business',
    'Kauri Plumbing Ltd',
    '--trade',
    'plumber',
    '--owner-email',
    'Owner@Kauri.example.test',
    '--gst-registered',
    'yes',
    '--gst-number',
    '49-091-850',
    '--prices-entered',
    'exclusive',
    '--rates',
    join(dir, 'rates.csv'),
    '--tenant-id',
    tenantId,
  ];

  beforeAll(async () => {
    database = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'opentradie-provision-'));
    await writeFile(join(dir, 'rates.csv'), RATES);
    await writeFile(join(dir, 'password'), `${PASSWORD}\n`);
  });
  afterAll(async () => database?.drop());

  it('refuses bad input before touching the database, and never takes a password argument', async () => {
    const before = await counts(database.db);
    const bad = await cli([...args().slice(0, -2), '--password', 'x']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/Unknown option '--password'/);
    const gst = await cli(
      args().map((a) => (a === '49-091-850' ? '49-091-851' : a)),
      {
        OWNER_PASSWORD_FILE: join(dir, 'password'),
      },
    );
    expect(gst.code).toBe(1);
    expect(gst.stderr).toMatch(/IRD check digit/);
    await writeFile(join(dir, 'short'), 'too-short');
    const short = await cli(args(), { OWNER_PASSWORD_FILE: join(dir, 'short') });
    expect(short.stderr).toMatch(/at least 12 characters/);
    await writeFile(
      join(dir, 'bad.csv'),
      'code,description,unit,price_excl_gst_nzd\ncall_out,X,m2,1\ncall_out,Y,each,-1\n',
    );
    const csv = await cli(
      args().map((a) => (a.endsWith('rates.csv') ? join(dir, 'bad.csv') : a)),
      {
        OWNER_PASSWORD_FILE: join(dir, 'password'),
      },
    );
    expect(csv.code).toBe(1);
    expect(csv.stderr).toMatch(/bad\.csv:2 Unit "m2"/);
    expect(csv.stderr).toMatch(/bad\.csv:3 .*duplicate/);
    expect(await counts(database.db)).toEqual(before);
  });

  it('dry run prints the plan and writes nothing', async () => {
    const before = await counts(database.db);
    const dry = await cli([...args(), '--dry-run']);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toMatch(/Would create business "Kauri Plumbing Ltd"/);
    expect(dry.stdout).toMatch(/labour_hour,Labour \(per hour\),hour,1234\.50/);
    expect(dry.stdout).toMatch(/Dry run: nothing was written/);
    expect(await counts(database.db)).toEqual(before);
  });

  it('provisions the business, owner and rates; the owner signs in and quotes from those rates', async () => {
    const result = await cli(args(), { OWNER_PASSWORD_FILE: join(dir, 'password') });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Created business/);
    expect(result.stdout).toContain(`Set TENANT_ID=${tenantId}`);
    expect(result.stdout + result.stderr).not.toContain(PASSWORD);
    expect(await counts(database.db)).toMatchObject({
      businesses: 1,
      users: 1,
      rates: 3,
      customers: 0,
    });
    const business = (
      await database.db.pool.query(
        'SELECT demo_data,gst_number,trade,call_out_rate_code FROM businesses WHERE id=$1',
        [tenantId],
      )
    ).rows[0];
    expect(business).toEqual({
      demo_data: false,
      gst_number: '49091850',
      trade: 'plumber',
      call_out_rate_code: 'call_out',
    });
    const approvedBy = await database.db.pool.query(
      "SELECT count(*)::int AS n FROM approved_rates r JOIN users u ON u.tenant_id=r.tenant_id AND u.id=r.approved_by WHERE u.role='owner'",
    );
    expect(approvedBy.rows[0].n).toBe(3);
    const audits = await database.db.pool.query('SELECT action FROM audit_events ORDER BY action');
    expect(audits.rows.map((r) => r.action)).toEqual([
      'rate.created',
      'rate.created',
      'rate.created',
      'tenant.provisioned',
      'user.created',
    ]);

    const config = loadRuntimeConfig(baseEnv(database.url, { TENANT_ID: tenantId }));
    const app = await buildApp({
      db: database.db,
      runtime: new MockAgentRuntime(),
      config,
      fileStore: new LocalFileStore(dir),
      mailRuntime: null,
      embeddingProvider: null,
    });
    try {
      await app.ready();
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: config.appOrigin },
        payload: { email: 'owner@kauri.example.test', password: PASSWORD },
      });
      expect(login.statusCode).toBe(200);
      const cookie = `opentradie_session=${login.cookies.find((c) => c.name === 'opentradie_session')!.value}`;
      const send = (method: 'POST' | 'PATCH', url: string, payload: object) =>
        app.inject({
          method,
          url,
          headers: { cookie, origin: config.appOrigin, 'idempotency-key': randomUUID() },
          payload,
        });
      const customer = await send('POST', '/api/customers', { name: 'First Real Customer' });
      expect(customer.statusCode).toBe(201);
      const enquiry = await send('POST', '/api/enquiries', {
        text: 'Leaking tap in the kitchen, please quote.',
        customerId: customer.json().customer?.id ?? customer.json().id,
      });
      expect(enquiry.statusCode, enquiry.body).toBe(201);
      const quote = enquiry.json().quote;
      const edit = await send('PATCH', `/api/quotes/${quote.id}`, {
        version: quote.version,
        lines: [
          { source: 'approved_rate', rateCode: 'tap_washer', quantityMilli: 2000 },
          { source: 'approved_rate', rateCode: 'labour_hour', quantityMilli: 1000 },
        ],
      });
      expect(edit.statusCode, edit.body).toBe(200);
      expect(edit.json().lines.map((l: { unitPriceCents: number }) => l.unitPriceCents)).toEqual([
        4_550, 123_450,
      ]);
      expect(edit.json().subtotalCents).toBe(2 * 4_550 + 123_450);
    } finally {
      await app.close();
    }
  });

  it('re-running is a no-op', async () => {
    const before = await counts(database.db);
    const again = await cli(args(), { OWNER_PASSWORD_FILE: join(dir, 'password') });
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/already provisioned\. Nothing was changed/);
    expect(await counts(database.db)).toEqual(before);
  });

  it('refuses a database that holds another business or the demo seed', async () => {
    // The database above now holds a real business.
    await expect(
      provisionTenant(database.db, {
        tenantId: randomUUID(),
        businessName: 'Second',
        trade: 'plumber',
        ownerEmail: 'two@example.test',
        ownerPassword: PASSWORD,
        gstRegistered: false,
        gstNumber: null,
        pricesEntered: 'exclusive',
        rates: [{ code: 'call_out', label: 'x', unit: 'visit', unitPriceCents: 1 }],
      }),
    ).rejects.toThrow(/already holds another business/);

    const demo = await createTestDatabase();
    try {
      const demoTenant = randomUUID();
      await seed(demo.db, {
        tenantId: demoTenant,
        ownerEmail: 'demo@example.test',
        ownerPassword: PASSWORD,
      });
      const options = {
        tenantId: randomUUID(),
        businessName: 'Real',
        trade: 'electrician',
        ownerEmail: 'real@example.test',
        ownerPassword: PASSWORD,
        gstRegistered: false,
        gstNumber: null,
        pricesEntered: 'exclusive' as const,
        rates: [{ code: 'call_out', label: 'x', unit: 'visit' as const, unitPriceCents: 1 }],
      };
      await expect(provisionTenant(demo.db, options)).rejects.toThrow(/allow-alongside-demo/);
      await expect(provisionTenant(demo.db, { ...options, tenantId: demoTenant })).rejects.toThrow(
        /synthetic demo business/,
      );
      expect(
        await provisionTenant(demo.db, { ...options, allowAlongsideDemo: true }),
      ).toMatchObject({
        status: 'created',
      });
    } finally {
      await demo.drop();
    }
  });
});
