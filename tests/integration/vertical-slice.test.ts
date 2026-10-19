import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enquiryResponse, quoteResponse } from '../../apps/api/src/schemas.js';
import { createTestContext, customerId, type TestContext } from '../helpers/app.js';

const ENQUIRY =
  'Mrs Johnson needs two power points replaced. Check her existing information and prepare a quote.';

describe('vertical slice: enquiry -> job -> draft quote -> approval', () => {
  let ctx: TestContext;
  let owner: string;
  let viewer: string;
  let margaret: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await ctx.login('owner');
    viewer = await ctx.login('viewer');
    margaret = await customerId(ctx.db, 'Margaret Johnson');
  });
  afterAll(async () => ctx?.close());

  it('asks for clarification when two customers match "Mrs Johnson"', async () => {
    const response = await ctx.send('POST', '/api/enquiries', owner, { text: ENQUIRY });
    expect(response.status).toBe(200);
    const body = enquiryResponse.parse(response.body);
    expect(body.status).toBe('clarification_required');
    if (body.status !== 'clarification_required') return;
    expect(body.clarification.matches.map((match) => match.name).sort()).toEqual([
      'Helen Johnson',
      'Margaret Johnson',
    ]);
    expect(body.agent).toMatchObject({ runtime: 'mock', synthetic: true });
    const quotes = await ctx.db.pool.query('SELECT count(*)::int AS n FROM quotes');
    expect(quotes.rows[0].n).toBe(0);
  });

  let quote: ReturnType<typeof quoteResponse.parse>;

  it('drafts a deterministic quote from approved rates once the customer is chosen', async () => {
    const response = await ctx.send('POST', '/api/enquiries', owner, {
      text: ENQUIRY,
      customerId: margaret,
    });
    expect(response.status).toBe(201);
    const body = enquiryResponse.parse(response.body);
    if (body.status !== 'quote_drafted') throw new Error('expected a drafted quote');
    quote = body.quote;
    expect(body.customer).toMatchObject({
      id: margaret,
      name: 'Margaret Johnson',
      matchedBy: 'selected',
    });
    expect(quote.lines).toEqual([
      expect.objectContaining({
        rateCode: 'power_point_replace',
        quantity: 2,
        unitPriceCents: 8_900,
        lineTotalCents: 17_800,
      }),
      expect.objectContaining({
        rateCode: 'call_out',
        quantity: 1,
        unitPriceCents: 9_500,
        lineTotalCents: 9_500,
      }),
    ]);
    expect(quote).toMatchObject({
      subtotalCents: 27_300,
      taxCents: 4_095,
      totalCents: 31_395,
      taxBasisPoints: 1500,
      currency: 'NZD',
      status: 'draft',
      version: 1,
    });
    expect(quote.missingInformation).toEqual([]);
    expect(quote.canApprove).toBe(true);
    expect(quote.approval?.status).toBe('pending');
    expect(quote.assumptions.join(' ')).toMatch(/approved rate card/);
    expect(quote.assumptions.join(' ')).toMatch(/GST at 15%/);
    expect(body.history.map((job) => job.title)).toContain('Kitchen downlight replacement');
    expect(body.history.flatMap((job) => job.notes).join(' ')).toMatch(/ceramic-fuse/);
    const job = await ctx.get(`/api/jobs/${body.jobId}`, owner);
    expect(job.body.job).toMatchObject({
      status: 'quoted',
      origin: 'assistant_proposed',
      customerId: margaret,
    });
    expect(job.body.notes[0].provenance).toBe('inferred');
  });

  it('refuses approval by a viewer', async () => {
    const response = await ctx.send('POST', `/api/quotes/${quote.id}/approve`, viewer, {
      version: 1,
    });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('OWNER_REQUIRED');
    expect((await ctx.get(`/api/quotes/${quote.id}`, owner)).body.status).toBe('draft');
  });

  it('refuses approval of a stale version', async () => {
    const response = await ctx.send('POST', `/api/quotes/${quote.id}/approve`, owner, {
      version: 7,
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('STALE_QUOTE');
  });

  it('lets the owner approve, stores the approved document, and replays retries idempotently', async () => {
    const key = 'approve-key-0001';
    const response = await ctx.send(
      'POST',
      `/api/quotes/${quote.id}/approve`,
      owner,
      { version: 1 },
      { key },
    );
    expect(response.status).toBe(200);
    const approved = quoteResponse.parse(response.body);
    expect(approved).toMatchObject({ status: 'approved', version: 2, totalCents: 31_395 });
    expect(approved.approval?.status).toBe('approved');
    expect(approved.documentId).toBeTruthy();
    const document = await ctx.db.pool.query(
      'SELECT storage_key,sha256 FROM documents WHERE id=$1',
      [approved.documentId],
    );
    const stored = JSON.parse((await ctx.fileStore.get(document.rows[0].storage_key)).toString());
    expect(stored.quote.totalCents).toBe(31_395);

    const retry = await ctx.send(
      'POST',
      `/api/quotes/${quote.id}/approve`,
      owner,
      { version: 1 },
      { key },
    );
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(response.body);
    const conflict = await ctx.send(
      'POST',
      `/api/quotes/${quote.id}/approve`,
      owner,
      { version: 2 },
      { key },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('IDEMPOTENCY_CONFLICT');
    const again = await ctx.send('POST', `/api/quotes/${quote.id}/approve`, owner, { version: 2 });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('QUOTE_NOT_APPROVABLE');
    const events = await ctx.db.pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action='quote.approved' AND entity_id=$1",
      [quote.id],
    );
    expect(events.rows[0].n).toBe(1);
  });

  it('records an audit event for every step', async () => {
    const actions = (await ctx.get('/api/audit-events?limit=200', owner)).body.auditEvents.map(
      (event: { action: string }) => event.action,
    );
    for (const action of [
      'session.login',
      'model.policy_allowed',
      'enquiry.received',
      'enquiry.clarification_requested',
      'job.proposed',
      'quote.drafted',
      'approval.requested',
      'quote.approved',
    ]) {
      expect(actions).toContain(action);
    }
  });

  it('turns an unpriced request into missing information that blocks approval, until the owner revises it', async () => {
    const response = await ctx.send('POST', '/api/enquiries', owner, {
      text: 'Mrs Johnson wants her heat pump serviced before winter.',
      customerId: margaret,
    });
    expect(response.status).toBe(201);
    const drafted = response.body.quote;
    expect(drafted.lines).toEqual([]);
    expect(drafted.totalCents).toBe(0);
    expect(drafted.missingInformation.join(' ')).toMatch(/No approved rate covers/);
    expect(drafted.canApprove).toBe(false);
    const blocked = await ctx.send('POST', `/api/quotes/${drafted.id}/approve`, owner, {
      version: 1,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('QUOTE_NOT_APPROVABLE');

    const invented = await ctx.send('PATCH', `/api/quotes/${drafted.id}`, owner, {
      version: 1,
      lines: [{ rateCode: 'heat_pump_service', quantity: 1 }],
      missingInformation: [],
    });
    expect(invented.status).toBe(422);
    const priced = await ctx.send('PATCH', `/api/quotes/${drafted.id}`, owner, {
      version: 1,
      lines: [
        { rateCode: 'labour_hour', quantity: 2 },
        { rateCode: 'call_out', quantity: 1 },
      ],
      missingInformation: [],
    });
    expect(priced.status).toBe(200);
    expect(priced.body).toMatchObject({
      version: 2,
      subtotalCents: 31_500,
      taxCents: 4_725,
      totalCents: 36_225,
      canApprove: true,
    });
    const approved = await ctx.send('POST', `/api/quotes/${drafted.id}/approve`, owner, {
      version: 2,
    });
    expect(approved.status).toBe(200);
  });

  it('never assumes a quantity the enquiry did not state', async () => {
    const response = await ctx.send('POST', '/api/enquiries', owner, {
      text: 'Margaret Johnson wants some power points replaced.',
    });
    expect(response.status).toBe(201);
    expect(response.body.customer.matchedBy).toBe('exact_name');
    expect(response.body.quote.missingInformation.join(' ')).toMatch(/Confirm the quantity/);
    expect(response.body.quote.canApprove).toBe(false);
  });

  it('lets the owner reject a draft', async () => {
    const drafted = (
      await ctx.send('POST', '/api/enquiries', owner, { text: ENQUIRY, customerId: margaret })
    ).body.quote;
    const rejected = await ctx.send('POST', `/api/quotes/${drafted.id}/reject`, owner, {
      version: 1,
      reason: 'Customer went elsewhere',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ id: drafted.id, status: 'rejected', version: 2 });
  });
});
