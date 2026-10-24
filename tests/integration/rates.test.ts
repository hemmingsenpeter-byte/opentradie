import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeProposal } from '../../apps/api/src/tools/proposals.js';
import {
  createTestContext,
  customerId,
  TENANT_A,
  TENANT_B,
  type TestContext,
} from '../helpers/app.js';

const ENQUIRY =
  'Mrs Johnson needs two power points replaced. Check her existing information and prepare a quote.';

describe('rate card management API', () => {
  let ctx: TestContext;
  let owner: string;
  let viewer: string;
  beforeAll(async () => {
    ctx = await createTestContext({ seedTenantB: true });
    owner = await ctx.login('owner');
    viewer = await ctx.login('viewer');
  });
  afterAll(async () => ctx?.close());

  it('creates a rate from a price typed as text, idempotently and audited', async () => {
    const body = {
      code: 'heat_pump_service',
      label: 'Heat pump service',
      unit: 'each',
      price: '$1,234.50',
    };
    const first = await ctx.send('POST', '/api/rates', owner, body, { key: 'create-heat-pump-1' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.rate).toMatchObject({
      code: 'heat_pump_service',
      unitPriceCents: 123_450,
      active: true,
    });
    const replay = await ctx.send('POST', '/api/rates', owner, body, { key: 'create-heat-pump-1' });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((await ctx.send('POST', '/api/rates', owner, body)).body.error).toBe('RATE_EXISTS');
    expect(
      (await ctx.send('POST', '/api/rates', owner, { ...body, code: 'bad_price', price: '-5' }))
        .body.error,
    ).toBe('INVALID_PRICE');
    const audit = await ctx.db.pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=$1 AND action='rate.created'",
      [TENANT_A],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('viewers can read but not change the rate card', async () => {
    expect((await ctx.get('/api/rates', viewer)).status).toBe(200);
    for (const [method, path, body] of [
      ['POST', '/api/rates', { code: 'v_rate', label: 'x', unit: 'each', price: '1' }],
      ['PATCH', '/api/rates/call_out', { price: '1' }],
      ['POST', '/api/rates/call_out/retire', undefined],
      ['POST', '/api/rates/import', { csv: 'x', mode: 'preview' }],
    ] as const)
      expect((await ctx.send(method, path, viewer, body)).status).toBe(403);
    expect((await ctx.get('/api/rates/export.csv', viewer)).status).toBe(403);
  });

  it('a price change is a new version; the existing quote keeps the price it was drafted with', async () => {
    const margaret = await customerId(ctx.db, 'Mrs Johnson');
    const drafted = await ctx.send('POST', '/api/enquiries', owner, {
      text: ENQUIRY,
      customerId: margaret,
    });
    expect(drafted.status).toBe(201);
    const quote = drafted.body.quote;
    const before = quote.lines.find(
      (l: { rateCode: string }) => l.rateCode === 'power_point_replace',
    );
    expect(before.unitPriceCents).toBe(8_900);

    const patched = await ctx.send('PATCH', '/api/rates/power_point_replace', owner, {
      price: '95.5',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.rate.unitPriceCents).toBe(9_550);
    const reread = await ctx.get(`/api/quotes/${quote.id}`, owner);
    expect(
      reread.body.lines.find((l: { rateCode: string }) => l.rateCode === 'power_point_replace')
        .unitPriceCents,
    ).toBe(8_900);
    expect(reread.body.totalCents).toBe(quote.totalCents);

    const history = await ctx.get('/api/rates/power_point_replace/history', owner);
    expect(
      history.body.versions.map((v: { change: string; unitPriceCents: number }) => [
        v.change,
        v.unitPriceCents,
      ]),
    ).toEqual([
      ['updated', 9_550],
      ['created', 8_900],
    ]);
    // A new quote line uses the new price.
    const edit = await ctx.send('PATCH', `/api/quotes/${quote.id}`, owner, {
      version: reread.body.version,
      lines: [{ source: 'approved_rate', rateCode: 'power_point_replace', quantityMilli: 1000 }],
    });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body.lines[0].unitPriceCents).toBe(9_550);
  });

  it('a retired rate is hidden, rejected on quote lines and agent proposals, and can be reactivated', async () => {
    const retired = await ctx.send('POST', '/api/rates/light_fitting_replace/retire', owner);
    expect(retired.body.rate).toMatchObject({ active: false });
    expect(retired.body.rate.retiredAt).not.toBeNull();
    const active = (await ctx.get('/api/rates', owner)).body.rates.map(
      (r: { code: string }) => r.code,
    );
    expect(active).not.toContain('light_fitting_replace');
    const all = (await ctx.get('/api/rates?includeRetired=true', owner)).body.rates;
    expect(all.find((r: { code: string }) => r.code === 'light_fitting_replace').active).toBe(
      false,
    );

    const quotes = (await ctx.get('/api/quotes', owner)).body.quotes;
    const draft = quotes.find((q: { status: string }) => q.status === 'draft');
    const edit = await ctx.send('PATCH', `/api/quotes/${draft.id}`, owner, {
      version: draft.version,
      lines: [{ source: 'approved_rate', rateCode: 'light_fitting_replace', quantityMilli: 1000 }],
    });
    expect(edit.status).toBe(422);
    expect(edit.body.error).toBe('UNKNOWN_RATE');

    const job = (
      await ctx.db.pool.query('SELECT id FROM jobs WHERE tenant_id=$1 LIMIT 1', [TENANT_A])
    ).rows[0].id;
    await expect(
      describeProposal(ctx.db.pool, TENANT_A, 'quote.prepare', {
        jobId: job,
        lines: [{ rateCode: 'light_fitting_replace', quantityMilli: 1000 }],
      }),
    ).rejects.toMatchObject({ code: 'RATE_NOT_APPROVED' });

    // Agents still see codes and labels only, never prices.
    const reactivated = await ctx.send(
      'POST',
      '/api/rates/light_fitting_replace/reactivate',
      owner,
    );
    expect(reactivated.body.rate).toMatchObject({
      active: true,
      retiredAt: null,
      unitPriceCents: 7_500,
    });
    const history = await ctx.get('/api/rates/light_fitting_replace/history', owner);
    expect(history.body.versions.map((v: { change: string }) => v.change)).toEqual([
      'reactivated',
      'retired',
      'created',
    ]);
  });

  it('imports a CSV with a preview diff, applies it, and exports a file that round-trips', async () => {
    const exported = await ctx.get('/api/rates/export.csv', owner);
    expect(exported.status).toBe(200);
    expect(String(exported.headers['content-type'])).toMatch(/^text\/csv/);
    const csv = String(exported.body);
    expect(csv.split('\r\n')[0]).toBe('code,description,unit,price_excl_gst_nzd');
    // Re-importing the export changes nothing.
    const same = await ctx.send('POST', '/api/rates/import', owner, { csv, mode: 'preview' });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(same.body.create).toEqual([]);
    expect(same.body.update).toEqual([]);

    const edited = csv
      .replace(/^labour_hour,.*$/m, 'labour_hour,Electrician labour (per hour),hour,"$125.00"')
      .replace(/^call_out,.*\r\n/m, '')
      .concat('switchboard_upgrade,Switchboard upgrade,each,"2,450"\r\n');
    const preview = await ctx.send('POST', '/api/rates/import', owner, {
      csv: edited,
      mode: 'preview',
    });
    expect(preview.body).toMatchObject({
      applied: false,
      create: [{ code: 'switchboard_upgrade', unitPriceCents: 245_000 }],
      update: [
        {
          code: 'labour_hour',
          fields: ['label', 'unitPriceCents'],
          after: { unitPriceCents: 12_500 },
        },
      ],
      notInFile: ['call_out'],
    });
    const unchanged = await ctx.db.pool.query(
      "SELECT unit_price_cents::int AS c FROM approved_rates WHERE tenant_id=$1 AND code='labour_hour'",
      [TENANT_A],
    );
    expect(unchanged.rows[0].c).toBe(11_000);

    const applied = await ctx.send('POST', '/api/rates/import', owner, {
      csv: edited,
      mode: 'apply',
    });
    expect(applied.body.applied).toBe(true);
    const rates = (await ctx.get('/api/rates', owner)).body.rates;
    const byCode = Object.fromEntries(
      rates.map((r: { code: string; unitPriceCents: number }) => [r.code, r.unitPriceCents]),
    );
    expect(byCode).toMatchObject({
      labour_hour: 12_500,
      switchboard_upgrade: 245_000,
      call_out: 9_500,
    });

    const bad = await ctx.send('POST', '/api/rates/import', owner, {
      csv: 'code,description,unit,price_excl_gst_nzd\nx_one,X,m2,1\nx_one,X,each,1',
      mode: 'apply',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('INVALID_RATE_CARD');
    expect(bad.body.errors.length).toBe(2);
  });

  it('is tenant scoped: tenant B cannot see or change tenant A rates', async () => {
    // Tenant B runs its own installation; inside tenant A's API, B's rows never appear.
    await ctx.db.pool.query(
      "UPDATE approved_rates SET label='tenant B only' WHERE tenant_id=$1 AND code='call_out'",
      [TENANT_B],
    );
    const rates = (await ctx.get('/api/rates?includeRetired=true', owner)).body.rates;
    expect(rates.map((r: { label: string }) => r.label)).not.toContain('tenant B only');
    await ctx.send('PATCH', '/api/rates/call_out', owner, { label: 'A call-out' });
    const b = await ctx.db.pool.query(
      "SELECT label FROM approved_rates WHERE tenant_id=$1 AND code='call_out'",
      [TENANT_B],
    );
    expect(b.rows[0].label).toBe('tenant B only');
    const bHistory = await ctx.db.pool.query(
      'SELECT count(*)::int AS n FROM approved_rate_history WHERE tenant_id=$1',
      [TENANT_B],
    );
    expect(bHistory.rows[0].n).toBe(5);
    expect((await ctx.get('/api/rates/no_such_rate/history', owner)).status).toBe(404);
  });
});
