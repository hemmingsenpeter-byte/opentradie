import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, TENANT_A, TENANT_B, type TestContext } from '../helpers/app.js';

describe('ICS calendar export (ADR 0019 amendment)', () => {
  let ctx: TestContext;
  let owner: string;
  let viewer: string;
  const q = (sql: string, params: unknown[] = []) => ctx.db.pool.query(sql, params);

  async function appointment(tenantId: string, title: string, status = 'confirmed') {
    const customerId = randomUUID();
    const jobId = randomUUID();
    const id = randomUUID();
    await q('INSERT INTO customers(id,tenant_id,name) VALUES($1,$2,$3)', [
      customerId,
      tenantId,
      'Secret Customer Name',
    ]);
    await q(
      "INSERT INTO jobs(id,tenant_id,customer_id,title,status) VALUES($1,$2,$3,$4,'scheduled')",
      [jobId, tenantId, customerId, title],
    );
    await q(
      `INSERT INTO appointments(id,tenant_id,job_id,starts_at,ends_at,status,title,location,cancelled_at)
       VALUES($1,$2,$3,now() + interval '2 days',now() + interval '2 days 2 hours',$4,$5,'12 Secret Street',
         CASE WHEN $4='cancelled' THEN now() END)`,
      [id, tenantId, jobId, status, title],
    );
    return id;
  }
  const tokenOf = (url: string) => new URL(url).pathname.split('/').at(-1)!;

  beforeAll(async () => {
    ctx = await createTestContext({ seedTenantB: true });
    owner = await ctx.login('owner');
    viewer = await ctx.login('viewer');
  });
  afterAll(async () => ctx?.close());

  it('creates, rotates and revokes a feed link; only the hash is stored', async () => {
    expect((await ctx.get('/api/calendar/feed-token', owner)).body).toMatchObject({
      active: false,
    });
    expect((await ctx.get('/api/calendar/feed-token', viewer)).status).toBe(403);
    expect((await ctx.send('POST', '/api/calendar/feed-token', viewer)).status).toBe(403);

    const keep = await appointment(TENANT_A, 'Install heat pump');
    const dropped = await appointment(TENANT_A, 'Cancelled visit', 'cancelled');
    const created = await ctx.send('POST', '/api/calendar/feed-token', owner);
    expect(created.status).toBe(201);
    expect(created.body.url).toMatch(/\/calendar\/feed\/[A-Za-z0-9_-]{43}\.ics$/);
    const first = tokenOf(created.body.url);
    const stored = await q('SELECT token_hash FROM calendar_feed_tokens WHERE tenant_id=$1', [
      TENANT_A,
    ]);
    expect(JSON.stringify(stored.rows)).not.toContain(first.replace('.ics', ''));
    expect((await ctx.get('/api/calendar/feed-token', owner)).body.active).toBe(true);

    const feed = await ctx.get(`/calendar/feed/${first}`, '');
    expect(feed.status).toBe(200);
    expect(String(feed.headers['content-type'])).toMatch(/^text\/calendar/);
    expect(feed.body).toContain(`UID:${keep}@opentradie`);
    expect(feed.body).toContain('SUMMARY:Install heat pump');
    expect(feed.body).not.toContain(dropped);
    expect(feed.body).not.toContain('Secret Customer Name');
    expect(feed.body).not.toContain('Secret Street');
    expect((await ctx.get('/api/calendar/feed-token', owner)).body.lastUsedAt).not.toBeNull();

    const rotated = await ctx.send('POST', '/api/calendar/feed-token', owner);
    const second = tokenOf(rotated.body.url);
    expect(second).not.toBe(first);
    expect((await ctx.get(`/calendar/feed/${first}`, '')).status).toBe(404);
    expect((await ctx.get(`/calendar/feed/${second}`, '')).status).toBe(200);

    expect((await ctx.send('DELETE', '/api/calendar/feed-token', owner)).body).toEqual({
      revoked: true,
    });
    expect((await ctx.get(`/calendar/feed/${second}`, '')).status).toBe(404);
    expect((await ctx.get('/calendar/feed/not-a-token.ics', '')).status).toBe(404);
    expect((await ctx.get(`/calendar/feed/${'A'.repeat(43)}.ics`, '')).status).toBe(404);
    const audit = await q(
      "SELECT action FROM audit_events WHERE tenant_id=$1 AND action LIKE 'calendar.feed_%' ORDER BY created_at",
      [TENANT_A],
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      'calendar.feed_created',
      'calendar.feed_rotated',
      'calendar.feed_revoked',
    ]);
  });

  it('keeps each feed to its own tenant and scopes single downloads by session', async () => {
    const mine = await appointment(TENANT_A, 'Tenant A job');
    const theirs = await appointment(TENANT_B, 'Tenant B job');
    const created = await ctx.send('POST', '/api/calendar/feed-token', owner);
    const feed = await ctx.get(`/calendar/feed/${tokenOf(created.body.url)}`, '');
    expect(feed.body).toContain(mine);
    expect(feed.body).not.toContain(theirs);
    expect(feed.body).not.toContain('Tenant B job');

    const single = await ctx.get(`/api/appointments/${mine}.ics`, viewer);
    expect(single.status).toBe(200);
    expect(single.body).toContain(`UID:${mine}@opentradie`);
    expect(String(single.headers['content-disposition'])).toContain('.ics');
    expect((await ctx.get(`/api/appointments/${theirs}.ics`, owner)).status).toBe(404);
    expect((await ctx.get(`/api/appointments/${mine}.ics`, '')).status).toBe(401);
    // The JSON route is unaffected by the .ics route.
    expect((await ctx.get(`/api/appointments/${mine}`, owner)).status).toBe(200);
  });
});
