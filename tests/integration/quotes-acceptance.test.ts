import { createHash, randomUUID } from 'node:crypto';
import { createTaskHandlers, PostgresJobQueue } from '@opentradie/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  publicQuoteResponse,
  quoteResponse,
  quoteSendResponse,
} from '../../apps/api/src/schemas.js';
import {
  createTestContext,
  customerId,
  TENANT_A,
  TENANT_B,
  type TestContext,
} from '../helpers/app.js';

const ENQUIRY =
  'Mrs Johnson needs two power points replaced. Check her existing information and prepare a quote.';

type Quote = ReturnType<typeof quoteResponse.parse>;

async function draftQuote(ctx: TestContext, owner: string, customer: string): Promise<Quote> {
  const response = await ctx.send('POST', '/api/enquiries', owner, {
    text: ENQUIRY,
    customerId: customer,
  });
  expect(response.status).toBe(201);
  return quoteResponse.parse(response.body.quote);
}

async function approveAndSend(ctx: TestContext, owner: string, quote: Quote) {
  const approved = await ctx.send('POST', `/api/quotes/${quote.id}/approve`, owner, {
    version: quote.version,
  });
  expect(approved.status).toBe(200);
  const sent = await ctx.send('POST', `/api/quotes/${quote.id}/send`, owner, {
    version: approved.body.version,
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  return quoteSendResponse.parse(sent.body);
}

const tokenOf = (url: string) => new URL(url).pathname.split('/').at(-1)!;

/** Public calls carry no session cookie; POSTs carry the app Origin like a browser would. */
function publicApi(ctx: TestContext) {
  return {
    get: (token: string, suffix = '') =>
      ctx.app.inject({ method: 'GET', url: `/api/public/quotes/${token}${suffix}` }),
    post: (
      token: string,
      verb: 'accept' | 'decline',
      body: unknown,
      origin: string | null = ctx.config.appOrigin,
    ) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/public/quotes/${token}/${verb}`,
        headers: origin ? { origin } : {},
        payload: body as object,
      }),
  };
}

describe('quote editing, sending and customer acceptance', () => {
  let ctx: TestContext;
  let owner: string;
  let viewer: string;
  let margaret: string;

  beforeAll(async () => {
    ctx = await createTestContext({ seedTenantB: true });
    owner = await ctx.login('owner');
    viewer = await ctx.login('viewer');
    margaret = await customerId(ctx.db, 'Mrs Johnson');
  });
  afterAll(async () => ctx?.close());

  it('lets only the owner change GST settings, validating the GST number checksum', async () => {
    const current = await ctx.get('/api/settings/business', viewer);
    expect(current.body).toMatchObject({
      gstRegistered: true,
      gstNumber: '49091850',
      pricesEntered: 'exclusive',
      quoteValidityDays: 30,
    });
    expect(
      (await ctx.send('PATCH', '/api/settings/business', viewer, { quoteValidityDays: 14 })).status,
    ).toBe(403);
    const invalid = await ctx.send('PATCH', '/api/settings/business', owner, {
      gstNumber: '136-410-133',
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error).toBe('INVALID_GST_NUMBER');
    const updated = await ctx.send('PATCH', '/api/settings/business', owner, {
      gstNumber: '136-410-132',
      defaultMaterialMarkupBasisPoints: 2500,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      gstNumber: '136410132',
      defaultMaterialMarkupBasisPoints: 2500,
    });
    const audit = await ctx.db.pool.query(
      "SELECT metadata FROM audit_events WHERE action='business.settings_updated'",
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0].metadata)).not.toContain('136410132');
  });

  let edited: Quote;

  it('edits draft lines and recomputes every total on the server', async () => {
    const quote = await draftQuote(ctx, owner, margaret);
    expect(quote.quoteNumber).toMatch(/^Q-\d{4}$/);
    expect(quote.revision).toBe(1);
    expect(quote.lines.every((line) => line.priceSource === 'approved_rate')).toBe(true);
    const response = await ctx.send('PATCH', `/api/quotes/${quote.id}`, owner, {
      version: quote.version,
      lines: [
        { source: 'approved_rate', rateCode: 'labour_hour', quantityMilli: 1500 },
        // Default markup 25%: $20.00 cost -> $25.00 sell, × 3 = $75.00
        {
          source: 'cost_plus_markup',
          description: 'Double power point (synthetic)',
          unit: 'each',
          quantityMilli: 3000,
          costCents: 2000,
        },
        {
          source: 'owner_entered',
          kind: 'fee',
          description: 'Export-certified test (synthetic)',
          unit: 'each',
          quantityMilli: 1000,
          unitPriceCents: 4000,
          taxCode: 'zero_rated',
        },
        {
          source: 'owner_entered',
          kind: 'discount',
          description: 'Loyalty discount',
          unit: 'each',
          quantityMilli: 1000,
          unitPriceCents: 1000,
        },
      ],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    edited = quoteResponse.parse(response.body);
    // standard: 16500 + 7500 - 1000 = 23000 -> GST 3450; zero-rated 4000 -> 0.
    expect(edited).toMatchObject({
      subtotalCents: 27_000,
      taxCents: 3_450,
      totalCents: 30_450,
      version: quote.version + 1,
      gstRegistered: true,
    });
    expect(edited.taxBreakdown).toEqual([
      {
        taxCode: 'standard',
        rateBasisPoints: 1500,
        netCents: 23_000,
        taxCents: 3_450,
        grossCents: 26_450,
      },
      {
        taxCode: 'zero_rated',
        rateBasisPoints: 0,
        netCents: 4_000,
        taxCents: 0,
        grossCents: 4_000,
      },
    ]);
    expect(edited.lines.map((line) => [line.kind, line.quantity, line.lineTotalCents])).toEqual([
      ['labour', 1.5, 16_500],
      ['material', 3, 7_500],
      ['fee', 1, 4_000],
      ['discount', 1, -1_000],
    ]);
    expect(edited.lines[1]).toMatchObject({
      costCents: 2000,
      markupBasisPoints: 2500,
      unitPriceCents: 2500,
    });
    const ownerId = (
      await ctx.db.pool.query("SELECT id FROM users WHERE role='owner' AND tenant_id=$1", [
        TENANT_A,
      ])
    ).rows[0].id;
    const stored = await ctx.db.pool.query(
      "SELECT price_source,entered_by FROM quote_line_items WHERE quote_id=$1 AND price_source='owner_entered'",
      [quote.id],
    );
    expect(stored.rows.every((row) => row.entered_by === ownerId)).toBe(true);
  });

  it('never takes totals or prices from the client, a viewer or an agent proposal', async () => {
    const withTotals = await ctx.send('PATCH', `/api/quotes/${edited.id}`, owner, {
      version: edited.version,
      lines: [{ rateCode: 'call_out', quantity: 1 }],
      totalCents: 1,
    });
    expect(withTotals.status).toBe(400);
    const pricedRate = await ctx.send('PATCH', `/api/quotes/${edited.id}`, owner, {
      version: edited.version,
      lines: [
        { source: 'approved_rate', rateCode: 'call_out', quantityMilli: 1000, unitPriceCents: 1 },
      ],
    });
    expect(pricedRate.status).toBe(400);
    const byViewer = await ctx.send('PATCH', `/api/quotes/${edited.id}`, viewer, {
      version: edited.version,
      lines: [
        {
          source: 'owner_entered',
          kind: 'fee',
          description: 'x',
          unit: 'each',
          quantityMilli: 1000,
          unitPriceCents: 1,
        },
      ],
    });
    expect(byViewer.status).toBe(403);
    const invalidDiscount = await ctx.send('PATCH', `/api/quotes/${edited.id}`, owner, {
      version: edited.version,
      lines: [
        {
          source: 'owner_entered',
          kind: 'discount',
          description: 'Too much',
          unit: 'each',
          quantityMilli: 1000,
          unitPriceCents: 999_999,
        },
      ],
    });
    expect(invalidDiscount.status).toBe(422);
    expect(invalidDiscount.body.error).toBe('INVALID_QUOTE_LINES');
    // The enquiry route has no price fields at all; the assistant draft uses approved rates only.
    const enquiry = await ctx.send('POST', '/api/enquiries', owner, {
      text: ENQUIRY,
      customerId: margaret,
      unitPriceCents: 1,
    });
    expect(enquiry.status).toBe(400);
    // A fresh assistant draft carries approved-rate prices only.
    const drafted = await ctx.send('POST', '/api/enquiries', owner, {
      text: ENQUIRY,
      customerId: margaret,
    });
    expect(
      drafted.body.quote.lines.every(
        (line: { priceSource: string }) => line.priceSource === 'approved_rate',
      ),
    ).toBe(true);
    expect((await ctx.get(`/api/quotes/${edited.id}`, owner)).body.totalCents).toBe(30_450);
  });

  let sent: ReturnType<typeof quoteSendResponse.parse>;

  it('sends only approved quotes, stores the PDF and a message draft, and is idempotent', async () => {
    const early = await ctx.send('POST', `/api/quotes/${edited.id}/send`, owner, {
      version: edited.version,
    });
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('QUOTE_NOT_APPROVED');
    const approved = await ctx.send('POST', `/api/quotes/${edited.id}/approve`, owner, {
      version: edited.version,
    });
    expect(approved.status).toBe(200);
    expect(
      (
        await ctx.send('POST', `/api/quotes/${edited.id}/send`, viewer, {
          version: approved.body.version,
        })
      ).status,
    ).toBe(403);
    const key = 'send-key-0001';
    const response = await ctx.send(
      'POST',
      `/api/quotes/${edited.id}/send`,
      owner,
      { version: approved.body.version },
      { key },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    sent = quoteSendResponse.parse(response.body);
    expect(sent.quote).toMatchObject({ status: 'sent', validUntil: sent.validUntil });
    expect(sent.acceptanceUrl).toMatch(/^http:\/\/localhost:5173\/q\/[A-Za-z0-9_-]{43}$/);

    const token = tokenOf(sent.acceptanceUrl);
    const tokens = await ctx.db.pool.query(
      'SELECT token_hash,expires_at FROM quote_acceptance_tokens WHERE quote_id=$1',
      [edited.id],
    );
    expect(tokens.rows).toHaveLength(1);
    expect(tokens.rows[0].token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(tokens.rows)).not.toContain(token);

    const message = await ctx.db.pool.query(
      'SELECT direction,channel,status,text FROM communications WHERE id=$1',
      [sent.messageDraftId],
    );
    expect(message.rows[0]).toMatchObject({
      direction: 'outbound',
      channel: 'email',
      status: 'draft',
    });
    expect(message.rows[0].text).toContain(sent.acceptanceUrl);

    const pdf = await ctx.get(`/api/quotes/${edited.id}/pdf`, viewer);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(String(pdf.body).startsWith('%PDF-')).toBe(true);
    const task = await ctx.db.pool.query(
      "SELECT run_at FROM scheduled_tasks WHERE kind='quote.expire' AND payload->>'quoteId'=$1",
      [edited.id],
    );
    expect(new Date(task.rows[0].run_at).getTime()).toBe(
      new Date(tokens.rows[0].expires_at).getTime(),
    );

    const replay = await ctx.send(
      'POST',
      `/api/quotes/${edited.id}/send`,
      owner,
      { version: approved.body.version },
      { key },
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(response.body);
    const again = await ctx.send('POST', `/api/quotes/${edited.id}/send`, owner, {
      version: approved.body.version,
    });
    expect(again.status).toBe(200);
    expect(again.body.acceptanceUrl).toBe(sent.acceptanceUrl);
    const counts = await ctx.db.pool.query(
      `SELECT (SELECT count(*)::int FROM documents WHERE quote_id=$1 AND kind='quote_pdf') AS pdfs,
              (SELECT count(*)::int FROM communications WHERE job_id=$2 AND direction='outbound') AS drafts,
              (SELECT count(*)::int FROM audit_events WHERE entity_id=$1 AND action='quote.sent') AS audits,
              (SELECT count(*)::int FROM job_events WHERE job_id=$2 AND type='quote_sent') AS events`,
      [edited.id, edited.jobId],
    );
    expect(counts.rows[0]).toEqual({ pdfs: 1, drafts: 1, audits: 1, events: 1 });
  });

  it('shows the customer the quote without a sign-in and rejects bad links', async () => {
    const pub = publicApi(ctx);
    const token = tokenOf(sent.acceptanceUrl);
    const view = await pub.get(token);
    expect(view.statusCode).toBe(200);
    const body = publicQuoteResponse.parse(view.json());
    expect(body).toMatchObject({
      status: 'sent',
      title: 'Quote',
      totalCents: 30_450,
      decision: null,
    });
    expect(body.business.gstNumberLabel).toBe('GST No. 136-410-132');
    expect(body.totals.map((row) => row.label)).toEqual([
      'Subtotal (excl. GST)',
      'GST 15%',
      'Total (incl. GST)',
    ]);
    expect((await pub.get(token, '/pdf')).headers['content-type']).toBe('application/pdf');
    expect((await pub.get('A'.repeat(43))).statusCode).toBe(404);
    expect((await pub.get('short')).statusCode).toBe(400);
    expect(
      (await pub.post('B'.repeat(43), 'accept', { name: 'Margaret Johnson' })).statusCode,
    ).toBe(404);
  });

  it('records a customer acceptance once, with a complete approval record', async () => {
    const pub = publicApi(ctx);
    const token = tokenOf(sent.acceptanceUrl);
    const noOrigin = await pub.post(token, 'accept', { name: 'Margaret Johnson' }, null);
    expect(noOrigin.statusCode).toBe(403);
    const foreign = await pub.post(
      token,
      'accept',
      { name: 'Margaret Johnson' },
      'https://evil.example',
    );
    expect(foreign.statusCode).toBe(403);
    expect((await pub.post(token, 'accept', { name: '' })).statusCode).toBe(400);

    const accepted = await pub.post(token, 'accept', {
      name: 'Margaret Johnson',
      comment: 'Tuesday suits.',
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      status: 'accepted',
      decision: { decision: 'accepted', signerName: 'Margaret Johnson' },
    });

    const replay = await pub.post(token, 'accept', { name: 'Margaret Johnson' });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error).toBe('QUOTE_ALREADY_DECIDED');
    expect((await pub.post(token, 'decline', { name: 'Someone Else' })).statusCode).toBe(409);
    // The customer can still view the decided quote.
    expect((await pub.get(token)).json().status).toBe('accepted');

    const quote = quoteResponse.parse((await ctx.get(`/api/quotes/${edited.id}`, owner)).body);
    expect(quote).toMatchObject({ status: 'accepted', decisionSource: 'customer' });
    expect(quote.acceptedAt).toBeTruthy();
    expect(quote.customerDecision).toMatchObject({
      decision: 'accepted',
      source: 'customer',
      signerName: 'Margaret Johnson',
      comment: 'Tuesday suits.',
    });
    const record = await ctx.db.pool.query(
      'SELECT quote_number,revision,total_cents,document_sha256,token_id FROM quote_decisions WHERE quote_id=$1',
      [edited.id],
    );
    expect(record.rows[0]).toMatchObject({
      quote_number: edited.quoteNumber,
      revision: 1,
      total_cents: 30_450,
    });
    expect(record.rows[0].document_sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      ctx.db.pool.query('DELETE FROM quote_decisions WHERE quote_id=$1', [edited.id]),
    ).rejects.toThrow(/append-only/);
    const audit = await ctx.db.pool.query(
      "SELECT actor_type,metadata FROM audit_events WHERE action='quote.accepted' AND entity_id=$1",
      [edited.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_type).toBe('customer');
    expect(JSON.stringify(audit.rows[0].metadata)).not.toMatch(/Margaret|Tuesday/);
    const timeline = (await ctx.get(`/api/jobs/${edited.jobId}`, owner)).body.timeline;
    expect(
      timeline.find((event: { type: string }) => event.type === 'quote_accepted'),
    ).toMatchObject({ actorType: 'customer' });
    const used = await ctx.db.pool.query(
      'SELECT used_at FROM quote_acceptance_tokens WHERE quote_id=$1',
      [edited.id],
    );
    expect(used.rows[0].used_at).not.toBeNull();
  });

  it('records a customer decline', async () => {
    const quote = await draftQuote(ctx, owner, margaret);
    const result = await approveAndSend(ctx, owner, quote);
    const declined = await publicApi(ctx).post(tokenOf(result.acceptanceUrl), 'decline', {
      name: 'Margaret Johnson',
      comment: 'Too dear',
    });
    expect(declined.statusCode).toBe(200);
    const after = quoteResponse.parse((await ctx.get(`/api/quotes/${quote.id}`, owner)).body);
    expect(after).toMatchObject({ status: 'rejected', decisionSource: 'customer' });
    expect(after.declinedAt).toBeTruthy();
    expect(after.customerDecision?.decision).toBe('declined');
  });

  it('revising a sent quote supersedes it and revokes its link', async () => {
    const quote = await draftQuote(ctx, owner, margaret);
    const result = await approveAndSend(ctx, owner, quote);
    expect(
      (
        await ctx.send('POST', `/api/quotes/${quote.id}/revise`, viewer, {
          version: result.quote.version,
        })
      ).status,
    ).toBe(403);
    const revised = await ctx.send('POST', `/api/quotes/${quote.id}/revise`, owner, {
      version: result.quote.version,
    });
    expect(revised.status).toBe(201);
    const next = quoteResponse.parse(revised.body);
    expect(next).toMatchObject({
      status: 'draft',
      quoteNumber: quote.quoteNumber,
      revision: 2,
      previousVersionId: quote.id,
      quoteGroupId: quote.quoteGroupId,
      totalCents: quote.totalCents,
      canApprove: true,
    });
    const old = quoteResponse.parse((await ctx.get(`/api/quotes/${quote.id}`, owner)).body);
    expect(old.status).toBe('superseded');
    const gone = await publicApi(ctx).get(tokenOf(result.acceptanceUrl));
    expect(gone.statusCode).toBe(410);
    expect(gone.json().error).toBe('QUOTE_SUPERSEDED');
    expect(
      (
        await publicApi(ctx).post(tokenOf(result.acceptanceUrl), 'accept', {
          name: 'Margaret Johnson',
        })
      ).statusCode,
    ).toBe(410);
    expect(
      (await ctx.send('POST', `/api/quotes/${quote.id}/revise`, owner, { version: old.version }))
        .status,
    ).toBe(409);
    expect(
      (await ctx.send('POST', `/api/quotes/${next.id}/revise`, owner, { version: next.version }))
        .body.error,
    ).toBe('QUOTE_NOT_REVISABLE');
    // Version 2 goes through the same approve -> send path, with a new link.
    const second = await approveAndSend(ctx, owner, next);
    expect(second.acceptanceUrl).not.toBe(result.acceptanceUrl);
    const events = await ctx.db.pool.query(
      "SELECT type FROM job_events WHERE job_id=$1 AND type LIKE 'quote_%' ORDER BY created_at",
      [quote.jobId],
    );
    expect(events.rows.map((row) => row.type)).toEqual([
      'quote_drafted',
      'quote_approved',
      'quote_sent',
      'quote_revised',
      'quote_approved',
      'quote_sent',
    ]);
  });

  it('expires a lapsed quote on read and through the queue task', async () => {
    const lapsedOnRead = await draftQuote(ctx, owner, margaret);
    const first = await approveAndSend(ctx, owner, lapsedOnRead);
    await ctx.db.pool.query("UPDATE quotes SET valid_until='2020-01-01' WHERE id=$1", [
      lapsedOnRead.id,
    ]);
    const gone = await publicApi(ctx).get(tokenOf(first.acceptanceUrl));
    expect(gone.statusCode).toBe(410);
    expect(gone.json().error).toBe('QUOTE_EXPIRED');
    expect((await ctx.get(`/api/quotes/${lapsedOnRead.id}`, owner)).body.status).toBe('expired');
    expect(
      (
        await publicApi(ctx).post(tokenOf(first.acceptanceUrl), 'accept', {
          name: 'Margaret Johnson',
        })
      ).statusCode,
    ).toBe(410);

    const lapsedOnAccept = await draftQuote(ctx, owner, margaret);
    const second = await approveAndSend(ctx, owner, lapsedOnAccept);
    await ctx.db.pool.query("UPDATE quotes SET valid_until='2020-01-01' WHERE id=$1", [
      lapsedOnAccept.id,
    ]);
    expect(
      (
        await publicApi(ctx).post(tokenOf(second.acceptanceUrl), 'accept', {
          name: 'Margaret Johnson',
        })
      ).statusCode,
    ).toBe(410);
    expect((await ctx.get(`/api/quotes/${lapsedOnAccept.id}`, owner)).body.status).toBe('expired');

    const byTask = await draftQuote(ctx, owner, margaret);
    await approveAndSend(ctx, owner, byTask);
    await ctx.db.pool.query("UPDATE quotes SET valid_until='2020-01-01' WHERE id=$1", [byTask.id]);
    await ctx.db.pool.query(
      "UPDATE scheduled_tasks SET run_at=now() WHERE kind='quote.expire' AND payload->>'quoteId'=$1",
      [byTask.id],
    );
    const queue = new PostgresJobQueue(ctx.db);
    const handlers = createTaskHandlers({
      queue,
      privacyMode: 'LOCAL_ONLY',
      embeddingProvider: null,
    });
    await queue.runOnce('test-worker', { 'quote.expire': handlers['quote.expire']! });
    const after = await ctx.get(`/api/quotes/${byTask.id}`, owner);
    expect(after.body.status).toBe('expired');
    const audits = await ctx.db.pool.query(
      "SELECT actor_type FROM audit_events WHERE action='quote.expired' AND entity_id=$1",
      [byTask.id],
    );
    expect(audits.rows).toEqual([{ actor_type: 'system' }]);
  });

  it('never resolves a link that belongs to another business', async () => {
    const tenantBQuote = await ctx.db.pool.query(
      `SELECT j.id AS job, j.customer_id AS customer FROM jobs j WHERE j.tenant_id=$1 LIMIT 1`,
      [TENANT_B],
    );
    const quoteId = randomUUID();
    await ctx.db.pool.query(
      `INSERT INTO quotes(id,tenant_id,customer_id,job_id,status,currency,subtotal_cents,tax_cents,total_cents,tax_basis_points,
         quote_number,quote_group_id,sent_at,valid_until,decided_at)
       VALUES($1,$2,$3,$4,'sent','NZD',100,15,115,1500,'Q-0001',$1,now(),current_date + 30,now())`,
      [quoteId, TENANT_B, tenantBQuote.rows[0].customer, tenantBQuote.rows[0].job],
    );
    const token = 'C'.repeat(43);
    await ctx.db.pool.query(
      `INSERT INTO quote_acceptance_tokens(id,tenant_id,quote_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now() + interval '30 days')`,
      [randomUUID(), TENANT_B, quoteId, createHash('sha256').update(token).digest('hex')],
    );
    expect((await publicApi(ctx).get(token)).statusCode).toBe(404);
    expect((await publicApi(ctx).post(token, 'accept', { name: 'Someone' })).statusCode).toBe(404);
    expect(
      (await ctx.db.pool.query('SELECT status FROM quotes WHERE id=$1', [quoteId])).rows[0].status,
    ).toBe('sent');
  });
});

describe('a business that is not registered for GST', () => {
  let ctx: TestContext;
  let owner: string;
  let margaret: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await ctx.login('owner');
    margaret = await customerId(ctx.db, 'Mrs Johnson');
  });
  afterAll(async () => ctx?.close());

  it('refuses to send a quote priced under different GST settings', async () => {
    const quote = await draftQuote(ctx, owner, margaret);
    const approved = await ctx.send('POST', `/api/quotes/${quote.id}/approve`, owner, {
      version: quote.version,
    });
    await ctx.send('PATCH', '/api/settings/business', owner, { gstRegistered: false });
    const send = await ctx.send('POST', `/api/quotes/${quote.id}/send`, owner, {
      version: approved.body.version,
    });
    expect(send.status).toBe(409);
    expect(send.body.error).toBe('QUOTE_TAX_SETTINGS_CHANGED');
  });

  it('quotes, sends and shows documents with no GST anywhere', async () => {
    const quote = await draftQuote(ctx, owner, margaret);
    expect(quote).toMatchObject({
      gstRegistered: false,
      taxCents: 0,
      subtotalCents: 27_300,
      totalCents: 27_300,
      taxBreakdown: [],
    });
    expect(quote.assumptions.join(' ')).toMatch(/not registered for GST/);
    const result = await approveAndSend(ctx, owner, quote);
    const message = await ctx.db.pool.query('SELECT text FROM communications WHERE id=$1', [
      result.messageDraftId,
    ]);
    expect(message.rows[0].text).not.toMatch(/GST/);
    const view = publicQuoteResponse.parse(
      (await publicApi(ctx).get(tokenOf(result.acceptanceUrl))).json(),
    );
    expect(view.title).toBe('Quote');
    expect(view.business.gstNumberLabel).toBeNull();
    expect(view.totals).toEqual([{ label: 'Total', value: '$273.00', emphasis: true }]);
    expect(view.notes.join(' ')).toMatch(/not registered for GST. No GST is charged/);
    expect(JSON.stringify(view)).not.toMatch(/GST No\.|incl\. GST|Tax invoice/);
  });

  it('requires a GST number before a registered business can send', async () => {
    await ctx.send('PATCH', '/api/settings/business', owner, {
      gstRegistered: true,
      gstNumber: null,
    });
    const quote = await draftQuote(ctx, owner, margaret);
    const approved = await ctx.send('POST', `/api/quotes/${quote.id}/approve`, owner, {
      version: quote.version,
    });
    const send = await ctx.send('POST', `/api/quotes/${quote.id}/send`, owner, {
      version: approved.body.version,
    });
    expect(send.status).toBe(422);
    expect(send.body.error).toBe('GST_NUMBER_REQUIRED');
  });
});
