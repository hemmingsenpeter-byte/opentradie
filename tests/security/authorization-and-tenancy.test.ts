import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  customerId,
  ORIGIN,
  TENANT_B,
  type TestContext,
} from '../helpers/app.js';

describe('authentication, roles and CSRF', () => {
  let ctx: TestContext;
  let owner: string;
  let viewer: string;
  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await ctx.login('owner');
    viewer = await ctx.login('viewer');
  });
  afterAll(async () => ctx?.close());

  it('rejects unauthenticated access to protected endpoints', async () => {
    for (const path of [
      '/api/state',
      '/api/customers',
      '/api/jobs',
      '/api/quotes',
      '/api/me',
      '/api/audit-events',
    ]) {
      const response = await ctx.get(path, '');
      expect(response.status, path).toBe(401);
    }
    expect((await ctx.get('/health', '')).status).toBe(200);
  });

  it('rejects a forged or tampered session cookie', async () => {
    expect((await ctx.get('/api/me', 'opentradie_session=not-a-signed-token')).status).toBe(401);
    const tampered = owner.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    expect((await ctx.get('/api/me', tampered)).status).toBe(401);
  });

  it('gives viewers read access but 403 on every mutation', async () => {
    expect((await ctx.get('/api/state', viewer)).status).toBe(200);
    const margaret = await customerId(ctx.db, 'Margaret Johnson');
    const job = (await ctx.get('/api/jobs', viewer)).body.jobs[0].id;
    const attempts: Array<['POST' | 'PATCH' | 'DELETE', string, unknown]> = [
      ['POST', '/api/customers', { name: 'Viewer Created' }],
      ['PATCH', `/api/customers/${margaret}`, { name: 'Renamed' }],
      ['DELETE', `/api/customers/${margaret}`, undefined],
      ['POST', '/api/jobs', { customerId: margaret, title: 'x' }],
      ['PATCH', `/api/jobs/${job}`, { status: 'completed' }],
      ['POST', `/api/jobs/${job}/notes`, { text: 'note' }],
      ['POST', '/api/enquiries', { text: 'Mrs Johnson needs two power points replaced.' }],
      ['POST', `/api/quotes/${randomUUID()}/approve`, { version: 1 }],
      ['POST', `/api/quotes/${randomUUID()}/reject`, { version: 1 }],
      [
        'PATCH',
        `/api/quotes/${randomUUID()}`,
        { version: 1, lines: [{ rateCode: 'call_out', quantity: 1 }], missingInformation: [] },
      ],
    ];
    for (const [method, path, body] of attempts) {
      const response = await ctx.send(method, path, viewer, body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(response.body.error).toBe('OWNER_REQUIRED');
    }
    const created = await ctx.db.pool.query(
      "SELECT count(*)::int AS n FROM customers WHERE name='Viewer Created'",
    );
    expect(created.rows[0].n).toBe(0);
  });

  it('rejects cross-site mutations (Origin must match APP_ORIGIN)', async () => {
    const evil = await ctx.send(
      'POST',
      '/api/customers',
      owner,
      { name: 'CSRF' },
      { origin: 'https://evil.example' },
    );
    expect(evil.status).toBe(403);
    expect(evil.body.error).toBe('ORIGIN_REJECTED');
    const missing = await ctx.send(
      'POST',
      '/api/customers',
      owner,
      { name: 'CSRF' },
      { origin: null },
    );
    expect(missing.status).toBe(403);
  });

  it('requires an idempotency key on mutations and rejects unknown fields', async () => {
    const noKey = await ctx.app.inject({
      method: 'POST',
      url: '/api/customers',
      headers: { cookie: owner, origin: ORIGIN },
      payload: { name: 'No Key' },
    });
    expect(noKey.statusCode).toBe(400);
    expect(JSON.parse(noKey.body).error).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const smuggled = await ctx.send('POST', '/api/customers', owner, {
      name: 'Smuggle',
      tenantId: TENANT_B,
    });
    expect(smuggled.status).toBe(400);
    expect(smuggled.body.error).toBe('VALIDATION_ERROR');
  });

  it('logout revokes the session server-side', async () => {
    const session = await ctx.login('viewer');
    expect((await ctx.send('POST', '/api/auth/logout', session)).status).toBe(200);
    expect((await ctx.get('/api/me', session)).status).toBe(401);
  });
  it('rate limits login attempts', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: ORIGIN },
        payload: { email: 'owner@demo.opentradie.test', password: 'wrong-password-123' },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toContain(401);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('tenant isolation', () => {
  let ctx: TestContext;
  let owner: string;
  let foreignCustomer: string;
  let foreignJob: string;
  beforeAll(async () => {
    ctx = await createTestContext({ seedTenantB: true });
    owner = await ctx.login('owner');
    foreignCustomer = await customerId(ctx.db, 'Margaret Johnson', TENANT_B);
    foreignJob = (
      await ctx.db.pool.query('SELECT id FROM jobs WHERE tenant_id=$1 LIMIT 1', [TENANT_B])
    ).rows[0].id;
  });
  afterAll(async () => ctx?.close());

  it('never lists another tenant’s records', async () => {
    const state = (await ctx.get('/api/state', owner)).body;
    expect(state.customers.map((c: { id: string }) => c.id)).not.toContain(foreignCustomer);
    expect(state.customers).toHaveLength(4);
    const search = (await ctx.get('/api/search?q=Johnson', owner)).body;
    expect(search.customers.map((c: { id: string }) => c.id)).not.toContain(foreignCustomer);
  });

  it('returns 404 for cross-tenant reads', async () => {
    expect((await ctx.get(`/api/customers/${foreignCustomer}`, owner)).status).toBe(404);
    expect((await ctx.get(`/api/jobs/${foreignJob}`, owner)).status).toBe(404);
  });

  it('rejects cross-tenant writes without changing the other tenant', async () => {
    expect(
      (await ctx.send('PATCH', `/api/customers/${foreignCustomer}`, owner, { name: 'Hijacked' }))
        .status,
    ).toBe(404);
    expect((await ctx.send('DELETE', `/api/customers/${foreignCustomer}`, owner)).status).toBe(404);
    expect(
      (
        await ctx.send('POST', '/api/jobs', owner, {
          customerId: foreignCustomer,
          title: 'Cross-tenant job',
        })
      ).status,
    ).toBe(404);
    expect(
      (await ctx.send('PATCH', `/api/jobs/${foreignJob}`, owner, { status: 'cancelled' })).status,
    ).toBe(404);
    expect(
      (await ctx.send('POST', `/api/jobs/${foreignJob}/notes`, owner, { text: 'x' })).status,
    ).toBe(404);
    expect(
      (
        await ctx.send('POST', '/api/enquiries', owner, {
          text: 'Mrs Johnson needs two power points replaced.',
          customerId: foreignCustomer,
        })
      ).status,
    ).toBe(404);
    const unchanged = await ctx.db.pool.query(
      'SELECT name, archived_at FROM customers WHERE id=$1',
      [foreignCustomer],
    );
    expect(unchanged.rows[0]).toEqual({ name: 'Margaret Johnson', archived_at: null });
    const jobs = await ctx.db.pool.query(
      "SELECT count(*)::int AS n FROM jobs WHERE title='Cross-tenant job'",
    );
    expect(jobs.rows[0].n).toBe(0);
  });

  it('rejects cross-tenant quote approval', async () => {
    const quoteId = randomUUID();
    const jobId = (
      await ctx.db.pool.query('SELECT id FROM jobs WHERE tenant_id=$1 AND customer_id=$2 LIMIT 1', [
        TENANT_B,
        foreignCustomer,
      ])
    ).rows[0].id;
    await ctx.db.pool.query(
      "INSERT INTO quotes(id,tenant_id,customer_id,job_id,currency,subtotal_cents,tax_cents,total_cents,tax_basis_points) VALUES($1,$2,$3,$4,'NZD',100,15,115,1500)",
      [quoteId, TENANT_B, foreignCustomer, jobId],
    );
    expect((await ctx.get(`/api/quotes/${quoteId}`, owner)).status).toBe(404);
    expect(
      (await ctx.send('POST', `/api/quotes/${quoteId}/approve`, owner, { version: 1 })).status,
    ).toBe(404);
    expect(
      (await ctx.db.pool.query('SELECT status FROM quotes WHERE id=$1', [quoteId])).rows[0].status,
    ).toBe('draft');
  });

  it('a valid session for another tenant is not accepted by this runtime', async () => {
    const otherUser = (
      await ctx.db.pool.query('SELECT id FROM users WHERE tenant_id=$1', [TENANT_B])
    ).rows[0].id;
    const token = randomBytes(32).toString('base64url');
    await ctx.db.pool.query(
      "INSERT INTO sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [createHash('sha256').update(token).digest('hex'), TENANT_B, otherUser],
    );
    const signed = ctx.app.signCookie(token);
    expect((await ctx.get('/api/me', `opentradie_session=${signed}`)).status).toBe(401);
    // The other tenant's owner cannot sign in to this runtime either.
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN },
      payload: { email: 'owner@other.test', password: 'other-owner-password' },
    });
    expect(login.statusCode).toBe(401);
  });

  it('the database refuses cross-tenant references even if application code were wrong', async () => {
    const ownJob = (
      await ctx.db.pool.query(
        "SELECT id FROM jobs WHERE tenant_id='11111111-1111-4111-8111-111111111111' LIMIT 1",
      )
    ).rows[0].id;
    await expect(
      ctx.db.pool.query("INSERT INTO job_notes(id,tenant_id,job_id,text) VALUES($1,$2,$3,'x')", [
        randomUUID(),
        TENANT_B,
        ownJob,
      ]),
    ).rejects.toThrow(/foreign key/);
  });
});
