import { randomUUID } from 'node:crypto';
import {
  AuthExpiredError,
  FakeAccountingAdapter,
  RateLimitedError,
  ReauthorisationRequiredError,
  ValidationError,
  type AccountingAdapter,
  type ExternalReferenceStore,
} from '@opentradie/integrations';
import {
  createTaskHandlers,
  dispatchOutbox,
  POST_INVOICE_TOPIC,
  postingIdempotencyKey,
  PostgresExternalReferenceStore,
  PostgresJobQueue,
  RECONCILE_TASK_KIND,
  type AccountingRuntime,
  type TaskHandler,
} from '@opentradie/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoiceResponse } from '../../apps/api/src/invoice-schemas.js';
import { runReadTool } from '../../apps/api/src/tools/read.js';
import {
  createTestContext,
  customerId,
  FAKE_ACCOUNTING_ENV,
  TENANT_A,
  TENANT_B,
  type TestContext,
} from '../helpers/app.js';

type Invoice = ReturnType<typeof invoiceResponse.parse>;

let ctx: TestContext;
let owner: string;
let viewer: string;
let queue: PostgresJobQueue;
let handlers: Record<string, TaskHandler>;
let fake: FakeAccountingAdapter;
let accounting: AccountingRuntime;

const count = async (sql: string, values: unknown[] = []) =>
  Number((await ctx.db.pool.query<{ n: string }>(sql, values)).rows[0]!.n);

/** Dispatch the outbox and run due tasks until nothing is left to do now. */
async function drain(customHandlers = handlers): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const dispatched = await dispatchOutbox(ctx.db, queue);
    const processed = await queue.runOnce('test-worker', customHandlers);
    if (!dispatched && !processed) return;
  }
  throw new Error('queue did not settle');
}

async function connectFake(): Promise<string> {
  const started = await ctx.get('/api/integrations/xero/connect', owner);
  expect(started.status).toBe(200);
  expect(started.body.mock).toBe(true);
  const url = new URL(started.body.authorizeUrl);
  const callback = await ctx.app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
  expect(callback.statusCode).toBe(302);
  return callback.headers.location as string;
}

/** A completed job for Mrs Johnson. With `acceptQuote`, its quote was sent and accepted first. */
async function completedJob(
  options: { acceptQuote?: boolean; customer?: string } = {},
): Promise<{ jobId: string; quote: { id: string; totalCents: number; lineCount: number } | null }> {
  const customer = options.customer ?? (await customerId(ctx.db, 'Mrs Johnson'));
  let jobId: string;
  let quote: { id: string; totalCents: number; lineCount: number } | null = null;
  if (options.acceptQuote) {
    const enquiry = await ctx.send('POST', '/api/enquiries', owner, {
      text: 'Mrs Johnson needs two power points replaced. Check her existing information and prepare a quote.',
      customerId: customer,
    });
    expect(enquiry.status).toBe(201);
    const drafted = enquiry.body.quote;
    jobId = drafted.jobId;
    const approved = await ctx.send('POST', `/api/quotes/${drafted.id}/approve`, owner, {
      version: drafted.version,
    });
    expect(approved.status).toBe(200);
    const sent = await ctx.send('POST', `/api/quotes/${drafted.id}/send`, owner, {
      version: approved.body.version,
    });
    expect(sent.status).toBe(200);
    const token = new URL(sent.body.acceptanceUrl).pathname.split('/').at(-1)!;
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: `/api/public/quotes/${token}/accept`,
      headers: { origin: ctx.config.appOrigin },
      payload: { name: 'Margaret Johnson' },
    });
    expect(accepted.statusCode).toBe(200);
    quote = {
      id: drafted.id,
      totalCents: drafted.totalCents,
      lineCount: drafted.lines.length,
    };
  } else {
    const created = await ctx.send('POST', '/api/jobs', owner, {
      customerId: customer,
      title: `Invoice test job ${randomUUID().slice(0, 6)}`,
    });
    expect(created.status).toBe(201);
    jobId = created.body.id;
  }
  for (const status of ['in_progress', 'completed']) {
    const current = (await ctx.get(`/api/jobs/${jobId}`, owner)).body.status;
    if (current === status) continue;
    const moved = await ctx.send('PATCH', `/api/jobs/${jobId}`, owner, { status });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  }
  return { jobId, quote };
}

async function recordTime(jobId: string, quantityMilli: number, description: string | null = null) {
  const id = randomUUID();
  await ctx.db.pool.query(
    `INSERT INTO job_time_entries(id,tenant_id,job_id,rate_id,rate_code,quantity_milli,description,provenance)
     SELECT $1,$2,$3,id,code,$4,$5,'user_supplied' FROM approved_rates WHERE tenant_id=$2 AND code='labour_hour'`,
    [id, TENANT_A, jobId, quantityMilli, description],
  );
  return id;
}

async function recordMaterial(
  jobId: string,
  priced: { costCents: number; markupBp: number } | null,
  quantityMilli = 2000,
) {
  const id = randomUUID();
  const ownerId = (
    await ctx.db.pool.query("SELECT id FROM users WHERE tenant_id=$1 AND role='owner'", [TENANT_A])
  ).rows[0].id;
  await ctx.db.pool.query(
    `INSERT INTO job_materials(id,tenant_id,job_id,description,unit,quantity_milli,unit_cost_cents,markup_bp,sell_unit_cents,
       price_source,cost_provenance,cost_confirmed_by,provenance)
     VALUES($1,$2,$3,'20A cable joiner (synthetic)','each',$4,$5,$6,$7,$8,$9,$10,'user_supplied')`,
    [
      id,
      TENANT_A,
      jobId,
      quantityMilli,
      priced?.costCents ?? null,
      priced?.markupBp ?? null,
      priced ? Math.round((priced.costCents * (10_000 + priced.markupBp)) / 10_000) : null,
      priced ? 'cost_plus_markup' : 'unpriced',
      priced ? 'owner_entered' : null,
      priced ? ownerId : null,
    ],
  );
  return id;
}

async function createInvoice(jobId: string, body: Record<string, unknown> = {}) {
  const response = await ctx.send('POST', `/api/jobs/${jobId}/invoices`, owner, body);
  return response;
}

async function approve(invoice: Invoice, key?: string) {
  return ctx.send(
    'POST',
    `/api/invoices/${invoice.id}/approve`,
    owner,
    { version: invoice.version },
    key ? { key } : {},
  );
}

const getInvoice = async (id: string) =>
  invoiceResponse.parse((await ctx.get(`/api/invoices/${id}`, owner)).body);

/** A time-and-materials invoice approved and ready to post. */
async function approvedInvoice(): Promise<Invoice> {
  const { jobId } = await completedJob();
  await recordTime(jobId, 1000);
  const created = await createInvoice(jobId);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const approved = await approve(invoiceResponse.parse(created.body));
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return invoiceResponse.parse(approved.body);
}

beforeAll(async () => {
  ctx = await createTestContext({ env: FAKE_ACCOUNTING_ENV, seedTenantB: true, logLevel: 'info' });
  owner = await ctx.login('owner');
  viewer = await ctx.login('viewer');
  accounting = ctx.accounting!;
  fake = accounting.adapter as FakeAccountingAdapter;
  queue = new PostgresJobQueue(ctx.db, { baseRetryDelayMs: 0 });
  handlers = createTaskHandlers({
    queue,
    privacyMode: 'LOCAL_ONLY',
    embeddingProvider: null,
    accounting,
  });
});
afterAll(async () => ctx?.close());

describe('accounting connection (fake adapter, OAuth state and PKCE)', () => {
  it('refuses to start the fake adapter silently or in production configuration', async () => {
    const { loadRuntimeConfig } = await import('@opentradie/platform');
    const { baseEnv } = await import('../helpers/app.js');
    expect(() =>
      loadRuntimeConfig(
        baseEnv(ctx.url, { ...FAKE_ACCOUNTING_ENV, ACCOUNTING_ALLOW_FAKE: 'false' }),
      ),
    ).toThrow(/ACCOUNTING_ALLOW_FAKE/);
    expect(() =>
      loadRuntimeConfig({ ...baseEnv(ctx.url, FAKE_ACCOUNTING_ENV), NODE_ENV: 'production' }),
    ).toThrow(/not allowed/);
    expect(() =>
      loadRuntimeConfig(
        baseEnv(ctx.url, { ACCOUNTING_PROVIDER: 'fake', ACCOUNTING_ALLOW_FAKE: 'true' }),
      ),
    ).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
    expect(() =>
      loadRuntimeConfig(
        baseEnv(ctx.url, {
          ACCOUNTING_PROVIDER: 'xero',
          CREDENTIAL_ENCRYPTION_KEY: FAKE_ACCOUNTING_ENV.CREDENTIAL_ENCRYPTION_KEY,
        }),
      ),
    ).toThrow(/XERO_CLIENT_ID/);
    expect(() =>
      loadRuntimeConfig(
        baseEnv(ctx.url, {
          ACCOUNTING_PROVIDER: 'xero',
          CREDENTIAL_ENCRYPTION_KEY: FAKE_ACCOUNTING_ENV.CREDENTIAL_ENCRYPTION_KEY,
          XERO_CLIENT_ID: 'client-id-placeholder',
          XERO_CLIENT_SECRET: 'client-secret-placeholder',
          XERO_REDIRECT_URI: 'http://example.test/api/integrations/xero/callback',
        }),
      ),
    ).toThrow(/HTTPS/);
    const xero = loadRuntimeConfig(
      baseEnv(ctx.url, {
        ACCOUNTING_PROVIDER: 'xero',
        CREDENTIAL_ENCRYPTION_KEY: FAKE_ACCOUNTING_ENV.CREDENTIAL_ENCRYPTION_KEY,
        CREDENTIAL_ENCRYPTION_RETIRED_KEYS: `old:${'b'.repeat(64)}`,
        XERO_CLIENT_ID: 'client-id-placeholder',
        XERO_CLIENT_SECRET: 'client-secret-placeholder',
        XERO_REDIRECT_URI: 'https://trades.example.test/api/integrations/xero/callback',
      }),
    );
    expect(xero.accounting).toMatchObject({ provider: 'xero', taxPreset: 'NZ', pkce: true });
    expect(Object.keys(xero.credentialKeys!.keys).sort()).toEqual(['k1', 'old']);
  });

  it('only lets the owner start a connection', async () => {
    expect((await ctx.get('/api/integrations/xero/connect', viewer)).status).toBe(403);
    const status = await ctx.get('/api/integrations/xero/status', viewer);
    expect(status.body).toMatchObject({ provider: 'fake', mock: true, status: 'disconnected' });
  });

  it('rejects unknown, replayed and expired OAuth state, and stores tokens encrypted at rest', async () => {
    const bogus = await ctx.app.inject({
      method: 'GET',
      url: '/api/integrations/xero/callback?code=fake-authorisation-code&state=not-a-real-state',
    });
    expect(bogus.headers.location).toBe('/settings?accounting=invalid_state');

    const started = await ctx.get('/api/integrations/xero/connect', owner);
    const url = new URL(started.body.authorizeUrl);
    const state = url.searchParams.get('state')!;
    // Only the SHA-256 of the state is stored.
    const stored = await ctx.db.pool.query(
      'SELECT state_hash, sealed_verifier FROM oauth_authorisations',
    );
    expect(JSON.stringify(stored.rows)).not.toContain(state);
    expect(stored.rows.every((row) => row.sealed_verifier !== null)).toBe(true);
    // Expired state is refused.
    await ctx.db.pool.query(
      "UPDATE oauth_authorisations SET expires_at=now() - interval '1 minute'",
    );
    const expired = await ctx.app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(expired.headers.location).toBe('/settings?accounting=invalid_state');

    // A tampered PKCE verifier cannot be opened and the exchange is refused.
    const second = new URL(
      (await ctx.get('/api/integrations/xero/connect', owner)).body.authorizeUrl,
    );
    await ctx.db.pool.query(
      "UPDATE oauth_authorisations SET sealed_verifier = sealed_verifier || '\\x00'::bytea WHERE used_at IS NULL AND expires_at > now()",
    );
    const tampered = await ctx.app.inject({
      method: 'GET',
      url: `${second.pathname}${second.search}`,
    });
    expect(tampered.headers.location).toBe('/settings?accounting=failed');

    expect(await connectFake()).toBe('/settings?accounting=connected');
    // Replaying a used state is refused.
    const third = new URL(
      (await ctx.get('/api/integrations/xero/connect', owner)).body.authorizeUrl,
    );
    expect(
      (await ctx.app.inject({ method: 'GET', url: `${third.pathname}${third.search}` })).headers
        .location,
    ).toBe('/settings?accounting=connected');
    expect(
      (await ctx.app.inject({ method: 'GET', url: `${third.pathname}${third.search}` })).headers
        .location,
    ).toBe('/settings?accounting=invalid_state');

    const connection = await ctx.db.pool.query<{
      status: string;
      encrypted_credentials: Buffer;
      encryption_key_id: string;
      external_account_id: string;
    }>("SELECT * FROM provider_connections WHERE tenant_id=$1 AND provider='test'", [TENANT_A]);
    const row = connection.rows[0]!;
    expect(row.status).toBe('connected');
    expect(row.encryption_key_id).toBe('k1');
    expect(row.external_account_id).toBeTruthy();
    const bytes = row.encrypted_credentials.toString('latin1');
    for (const plain of ['fake-access', 'fake-refresh', 'accessToken', 'refreshToken'])
      expect(bytes).not.toContain(plain);
    // The tokens decrypt to what the adapter issued.
    const tokens = await accounting.tokens.load(TENANT_A, 'test');
    expect(tokens?.accessToken).toMatch(/^fake-access-/);

    const status = await ctx.get('/api/integrations/xero/status', owner);
    expect(status.body).toMatchObject({ status: 'connected', mock: true });
    expect(JSON.stringify(ctx.logs)).not.toContain(tokens!.accessToken);
    expect(JSON.stringify(ctx.logs)).not.toContain(state);
  });

  it('serialises token refreshes across processes with a row lock', async () => {
    const current = (await accounting.tokens.load(TENANT_A, 'test'))!;
    let refreshes = 0;
    const slowRefresh = async () => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        accessToken: `fake-access-rotated-${refreshes}`,
        refreshToken: `fake-refresh-rotated-${refreshes}`,
        expiresAt: new Date(Date.now() + 30 * 60_000),
        scopes: ['fake.accounting'],
      };
    };
    const [a, b] = await Promise.all([
      accounting.tokens.refreshExclusive(TENANT_A, 'test', current, slowRefresh),
      accounting.tokens.refreshExclusive(TENANT_A, 'test', current, slowRefresh),
    ]);
    expect(refreshes).toBe(1);
    expect(a?.accessToken).toBe(b?.accessToken);
    expect((await accounting.tokens.load(TENANT_A, 'test'))?.accessToken).toBe(a?.accessToken);
  });
});

describe('invoice drafts from completed jobs', () => {
  it('copies an accepted quote exactly and refuses to invoice it twice', async () => {
    const { jobId, quote } = await completedJob({ acceptQuote: true });
    const created = await createInvoice(jobId);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const invoice = invoiceResponse.parse(created.body);
    expect(invoice).toMatchObject({
      status: 'draft',
      sourceQuoteId: quote!.id,
      totalCents: quote!.totalCents,
      gstRegistered: true,
    });
    expect(invoice.invoiceNumber).toMatch(/^INV-\d{4}$/);
    expect(invoice.lines).toHaveLength(quote!.lineCount);
    expect(invoice.lines.every((line) => line.sourceType === 'quote_line')).toBe(true);
    expect(invoice.totalCents).toBe(invoice.subtotalCents + invoice.taxCents);
    const again = await createInvoice(jobId);
    expect(again).toMatchObject({ status: 409, body: { error: 'QUOTE_ALREADY_INVOICED' } });
  });

  it('refuses jobs that are not completed', async () => {
    const created = await ctx.send('POST', '/api/jobs', owner, {
      customerId: await customerId(ctx.db, 'Mrs Johnson'),
      title: 'Not finished yet',
    });
    const response = await createInvoice(created.body.id);
    expect(response).toMatchObject({ status: 409, body: { error: 'JOB_NOT_COMPLETED' } });
  });

  it('prices time from approved rates and materials from cost x markup, and never bills them twice', async () => {
    const { jobId } = await completedJob();
    const first = await recordTime(jobId, 1500, 'Fault finding');
    await recordTime(jobId, 500);
    await recordMaterial(jobId, { costCents: 1000, markupBp: 2500 });
    await recordMaterial(jobId, null);
    const created = await createInvoice(jobId);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const invoice = invoiceResponse.parse(created.body);
    // 1.5 h + 0.5 h at $110.00, 2 x ($10.00 + 25%) = $165.00 + $55.00 + $25.00.
    expect(invoice.lines.map((line) => [line.sourceType, line.lineTotalCents])).toEqual([
      ['time_entry', 16_500],
      ['time_entry', 5_500],
      ['material', 2_500],
    ]);
    expect(invoice.lines[0]).toMatchObject({
      priceSource: 'approved_rate',
      rateCode: 'labour_hour',
    });
    expect(invoice.lines[2]).toMatchObject({
      priceSource: 'cost_plus_markup',
      unitPriceCents: 1_250,
    });
    expect(invoice).toMatchObject({ subtotalCents: 24_500, taxCents: 3_675, totalCents: 28_175 });
    expect(
      await count('SELECT count(*) AS n FROM job_time_entries WHERE job_id=$1 AND invoice_id=$2', [
        jobId,
        invoice.id,
      ]),
    ).toBe(2);
    // Everything billable is claimed: a second invoice has nothing to bill.
    expect(await createInvoice(jobId)).toMatchObject({
      status: 422,
      body: { error: 'NOTHING_TO_INVOICE' },
    });

    // The owner drops one time line and adds a fee: the dropped entry is released.
    const edited = await ctx.send('PATCH', `/api/invoices/${invoice.id}`, owner, {
      version: invoice.version,
      lines: [
        { lineId: invoice.lines[1]!.id },
        { lineId: invoice.lines[2]!.id, quantityMilli: 1000 },
        { source: 'approved_rate', rateCode: 'call_out', quantityMilli: 1000 },
      ],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const after = invoiceResponse.parse(edited.body);
    expect(after.version).toBe(invoice.version + 1);
    expect(after.subtotalCents).toBe(5_500 + 1_250 + 9_500);
    expect(
      (await ctx.db.pool.query('SELECT invoice_id FROM job_time_entries WHERE id=$1', [first]))
        .rows[0].invoice_id,
    ).toBeNull();
    // Clients cannot send amounts.
    const forged = await ctx.send('PATCH', `/api/invoices/${invoice.id}`, owner, {
      version: after.version,
      lines: [{ lineId: after.lines[0]!.id, lineTotalCents: 1 }],
    });
    expect(forged.status).toBe(400);
    const stale = await ctx.send('PATCH', `/api/invoices/${invoice.id}`, owner, {
      version: invoice.version,
      lines: [{ lineId: after.lines[0]!.id }],
    });
    expect(stale).toMatchObject({ status: 409, body: { error: 'STALE_INVOICE' } });

    // The released entry can go on a new invoice; voiding a draft releases everything it held.
    const second = await createInvoice(jobId);
    expect(second.status).toBe(201);
    expect(invoiceResponse.parse(second.body).lines).toHaveLength(1);
    const voided = await ctx.send('POST', `/api/invoices/${invoice.id}/void`, owner, {
      version: after.version,
    });
    expect(voided.status).toBe(200);
    expect(voided.body.status).toBe('void');
    expect(
      await count(
        'SELECT count(*) AS n FROM job_time_entries WHERE job_id=$1 AND invoice_id IS NULL',
        [jobId],
      ),
    ).toBe(1);
  });

  it('never claims the same time entry for two concurrent drafts', async () => {
    const { jobId } = await completedJob();
    await recordTime(jobId, 1000);
    const results = await Promise.all([createInvoice(jobId), createInvoice(jobId)]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 422]);
  });

  it('blocks approval with an explicit list of missing taxable supply information', async () => {
    const { jobId } = await completedJob();
    await recordTime(jobId, 1000);
    const invoice = invoiceResponse.parse((await createInvoice(jobId)).body);
    await ctx.db.pool.query('UPDATE businesses SET gst_number=NULL WHERE id=$1', [TENANT_A]);
    try {
      const view = await getInvoice(invoice.id);
      expect(view.readiness.missing).toContain('supplier GST number');
      const blocked = await approve(invoice);
      expect(blocked.status).toBe(422);
      expect(blocked.body).toMatchObject({ error: 'INVOICE_INCOMPLETE' });
      expect(blocked.body.missing).toContain('supplier GST number');
    } finally {
      await ctx.db.pool.query("UPDATE businesses SET gst_number='49091850' WHERE id=$1", [
        TENANT_A,
      ]);
    }

    // Over $1,000 the recipient needs an identifier (address, phone, email, ...).
    const anon = randomUUID();
    await ctx.db.pool.query(
      "INSERT INTO customers(id,tenant_id,name) VALUES($1,$2,'Walk-in customer (synthetic)')",
      [anon, TENANT_A],
    );
    const big = await completedJob({ customer: anon });
    await recordTime(big.jobId, 10_000);
    const large = invoiceResponse.parse((await createInvoice(big.jobId)).body);
    expect(large.totalCents).toBeGreaterThan(100_000);
    const refused = await approve(large);
    expect(refused.status).toBe(422);
    expect(refused.body.missing.join(' ')).toMatch(/recipient identifier/);
    expect(
      await count("SELECT count(*) AS n FROM event_outbox WHERE payload->>'invoiceId'=$1", [
        large.id,
      ]),
    ).toBe(0);
  });
});

describe('approval, outbox and posting', () => {
  it('approves, writes the outbox event in the same transaction, posts once and stores the PDF', async () => {
    const { jobId } = await completedJob();
    await recordTime(jobId, 2000);
    const draft = invoiceResponse.parse((await createInvoice(jobId)).body);
    expect(
      (await ctx.send('POST', `/api/invoices/${draft.id}/approve`, viewer, { version: 1 })).status,
    ).toBe(403);
    const key = randomUUID();
    const approved = await approve(draft, key);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', pdfAvailable: true });
    // A replayed approval returns the stored response and writes no second event.
    const replay = await approve(draft, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(
      await count(
        "SELECT count(*) AS n FROM event_outbox WHERE topic=$1 AND payload->>'invoiceId'=$2",
        [POST_INVOICE_TOPIC, draft.id],
      ),
    ).toBe(1);
    // Nothing reaches the queue until the dispatcher runs.
    expect(
      await count(
        "SELECT count(*) AS n FROM scheduled_tasks WHERE kind=$1 AND payload->>'invoiceId'=$2",
        [POST_INVOICE_TOPIC, draft.id],
      ),
    ).toBe(0);
    await drain();
    const posted = await getInvoice(draft.id);
    expect(posted.status).toBe('posted');
    expect(posted.accounting).toMatchObject({
      provider: 'test',
      providerStatus: 'draft',
      providerTotalCents: posted.totalCents,
      syncError: null,
    });
    expect(posted.accounting.externalInvoiceId).toMatch(/^fake-invoice-/);
    expect(posted.accounting.attempts[0]).toMatchObject({ status: 'succeeded' });

    // Redelivery of the same work (dispatch twice, run the handler again) creates nothing new.
    await ctx.db.pool.query('UPDATE event_outbox SET dispatched_at=NULL WHERE payload->>$1=$2', [
      'invoiceId',
      draft.id,
    ]);
    await drain();
    await handlers[POST_INVOICE_TOPIC]!(
      {
        id: randomUUID(),
        tenantId: TENANT_A,
        kind: POST_INVOICE_TOPIC,
        payload: { invoiceId: draft.id },
        idempotencyKey: 'manual',
        attempts: 1,
        maxAttempts: 5,
        leaseOwner: 'test',
      },
      { db: ctx.db },
    );
    const ledger = await fake.listInvoiceChangesSince(
      { tenantId: TENANT_A, organisationId: 'x' },
      new Date(0),
    );
    expect(ledger.filter((entry) => entry.reference === draft.invoiceNumber)).toHaveLength(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM external_references WHERE tenant_id=$1 AND entity_type='invoice' AND entity_id=$2",
        [TENANT_A, draft.id],
      ),
    ).toBe(1);

    const pdf = await ctx.app.inject({
      method: 'GET',
      url: `/api/invoices/${draft.id}/pdf`,
      headers: { cookie: viewer },
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect(
      await count(
        "SELECT count(*) AS n FROM job_events WHERE job_id=$1 AND type IN ('invoice_drafted','invoice_approved','invoice_posted')",
        [jobId],
      ),
    ).toBe(3);
    // Approved invoices are immutable here.
    expect(
      (
        await ctx.send('PATCH', `/api/invoices/${draft.id}`, owner, {
          version: posted.version,
          lines: [{ lineId: posted.lines[0]!.id }],
        })
      ).body.error,
    ).toBe('INVOICE_NOT_DRAFT');
  });

  it('a crash after the ledger created the invoice links the existing record on retry', async () => {
    const invoice = await approvedInvoice();
    const calls: string[] = [];
    // Recording adapter: every contract call is logged.
    const recording = new Proxy(fake, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(String(property));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as AccountingAdapter;
    const real = new PostgresExternalReferenceStore(ctx.db.pool);
    let crashed = false;
    // The provider call succeeds, then our process "dies" before the link is committed.
    const crashing: ExternalReferenceStore = {
      get: (...args) => real.get(...args),
      put: async (...args) => {
        if (args[2] === 'invoice' && !crashed) {
          crashed = true;
          throw new Error('simulated crash after remote success');
        }
        return real.put(...args);
      },
    };
    const crashyHandlers = createTaskHandlers({
      queue,
      privacyMode: 'LOCAL_ONLY',
      embeddingProvider: null,
      accounting: { ...accounting, adapter: recording, references: crashing },
    });
    await dispatchOutbox(ctx.db, queue);
    await queue.runOnce('crashy-worker', crashyHandlers);
    expect(crashed).toBe(true);
    expect((await getInvoice(invoice.id)).status).toBe('posting');
    expect(calls.filter((call) => call === 'createDraftInvoice')).toHaveLength(1);

    await drain(
      createTaskHandlers({
        queue,
        privacyMode: 'LOCAL_ONLY',
        embeddingProvider: null,
        accounting: { ...accounting, adapter: recording },
      }),
    );
    const linked = await getInvoice(invoice.id);
    expect(linked.status).toBe('posted');
    expect(linked.accounting.attempts.map((attempt) => attempt.status)).toContain(
      'linked_existing',
    );
    // Still exactly one ledger invoice and one create call.
    expect(calls.filter((call) => call === 'createDraftInvoice')).toHaveLength(1);
    const ledger = await fake.listInvoiceChangesSince(
      { tenantId: TENANT_A, organisationId: 'x' },
      new Date(0),
    );
    expect(ledger.filter((entry) => entry.reference === invoice.invoiceNumber)).toHaveLength(1);
    expect(postingIdempotencyKey(TENANT_A, invoice.id, invoice.version)).toBe(
      postingIdempotencyKey(TENANT_A, invoice.id, invoice.version),
    );
  });

  it('refreshes once on an expired access token and posts', async () => {
    const invoice = await approvedInvoice();
    fake.failNext(new AuthExpiredError('expired', 'unauthorised', 'test'));
    await drain();
    expect((await getInvoice(invoice.id)).status).toBe('posted');
  });

  it('retries after the provider rate limit delay with the same idempotency key', async () => {
    const invoice = await approvedInvoice();
    fake.failNext(new RateLimitedError('slow down', 'rate_limit', 'test', 120));
    await drain();
    const waiting = await getInvoice(invoice.id);
    expect(waiting.status).toBe('posting');
    expect(waiting.accounting.attempts[0]).toMatchObject({
      status: 'retry_scheduled',
      errorKind: 'rate_limited',
    });
    const task = (
      await ctx.db.pool.query<{ status: string; delay: number }>(
        `SELECT status, extract(epoch FROM run_at - now())::integer AS delay FROM scheduled_tasks
         WHERE kind=$1 AND payload->>'invoiceId'=$2`,
        [POST_INVOICE_TOPIC, invoice.id],
      )
    ).rows[0]!;
    expect(task.status).toBe('pending');
    expect(task.delay).toBeGreaterThan(100);
    expect(task.delay).toBeLessThanOrEqual(120);
    await ctx.db.pool.query(
      "UPDATE scheduled_tasks SET run_at=now() WHERE kind=$1 AND payload->>'invoiceId'=$2",
      [POST_INVOICE_TOPIC, invoice.id],
    );
    await drain();
    const posted = await getInvoice(invoice.id);
    expect(posted.status).toBe('posted');
    const keys = await ctx.db.pool.query(
      'SELECT DISTINCT idempotency_key FROM accounting_sync_attempts WHERE invoice_id=$1',
      [invoice.id],
    );
    expect(keys.rows).toEqual([
      { idempotency_key: postingIdempotencyKey(TENANT_A, invoice.id, invoice.version) },
    ]);
  });

  it('shows provider validation failures to the owner and retries on request', async () => {
    const invoice = await approvedInvoice();
    fake.failNext(
      new ValidationError('Draft invoice is invalid.', 'invoice', 'test', [
        'Account code 999 is archived (synthetic)',
      ]),
    );
    await drain();
    const failed = await getInvoice(invoice.id);
    expect(failed.status).toBe('sync_failed');
    expect(failed.accounting.syncError).toMatchObject({
      kind: 'validation',
      issues: ['Account code 999 is archived (synthetic)'],
    });
    const status = await ctx.get('/api/integrations/xero/status', viewer);
    expect(status.body.syncFailures.map((row: { invoiceId: string }) => row.invoiceId)).toContain(
      invoice.id,
    );
    // Provider messages may contain business data: never logged.
    expect(ctx.logs.join('\n')).not.toContain('archived (synthetic)');
    expect((await ctx.send('POST', `/api/invoices/${invoice.id}/retry-sync`, viewer)).status).toBe(
      403,
    );
    const retried = await ctx.send('POST', `/api/invoices/${invoice.id}/retry-sync`, owner);
    expect(retried.body.status).toBe('approved');
    await drain();
    expect((await getInvoice(invoice.id)).status).toBe('posted');
  });

  it('a revoked connection marks the sync failed, the connection in error, and recovers after reconnecting', async () => {
    const invoice = await approvedInvoice();
    fake.failNext(new ReauthorisationRequiredError('revoked', 'invalid_grant', 'test'));
    await drain();
    const failed = await getInvoice(invoice.id);
    expect(failed.status).toBe('sync_failed');
    expect(failed.accounting.syncError?.kind).toBe('reauthorisation_required');
    const connection = await ctx.db.pool.query(
      "SELECT status, status_reason, encrypted_credentials FROM provider_connections WHERE tenant_id=$1 AND provider='test'",
      [TENANT_A],
    );
    expect(connection.rows[0]).toMatchObject({
      status: 'error',
      status_reason: 'reauthorisation_required',
      encrypted_credentials: null,
    });
    expect((await ctx.get('/api/integrations/xero/status', owner)).body.status).toBe('error');

    expect(await connectFake()).toBe('/settings?accounting=connected');
    await ctx.send('POST', `/api/invoices/${invoice.id}/retry-sync`, owner);
    await drain();
    expect((await getInvoice(invoice.id)).status).toBe('posted');
  });
});

describe('reconciliation', () => {
  it('reads payments back: part paid, then paid, with snapshots and a periodic task', async () => {
    const invoice = await approvedInvoice();
    await drain();
    const posted = await getInvoice(invoice.id);
    expect(posted.status).toBe('posted');
    const externalId = posted.accounting.externalInvoiceId!;
    fake.simulateAuthorise(externalId);
    fake.simulatePayment(externalId, 5_000, '2026-10-20');

    expect((await ctx.send('POST', '/api/accounting/sync', viewer)).status).toBe(403);
    const first = await ctx.send('POST', '/api/accounting/sync', owner);
    expect(first.status).toBe(200);
    expect(first.body.blocked).toBeNull();
    const partPaid = await getInvoice(invoice.id);
    expect(partPaid.status).toBe('part_paid');
    expect(partPaid.accounting).toMatchObject({
      amountPaidCents: 5_000,
      amountDueCents: posted.totalCents - 5_000,
      providerStatus: 'authorised',
    });

    // The owner records the rest via the mock-only route, then the periodic task picks it up.
    const paid = await ctx.send('POST', '/api/integrations/accounting/mock/payments', owner, {
      invoiceId: invoice.id,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const reconcileTask = await ctx.db.pool.query(
      'SELECT id FROM scheduled_tasks WHERE tenant_id=$1 AND kind=$2 AND status=$3',
      [TENANT_A, RECONCILE_TASK_KIND, 'pending'],
    );
    expect(reconcileTask.rowCount).toBeGreaterThan(0);
    await ctx.db.pool.query(
      "UPDATE scheduled_tasks SET run_at=now() WHERE kind=$1 AND status='pending'",
      [RECONCILE_TASK_KIND],
    );
    await queue.runOnce('test-worker', handlers);
    const done = await getInvoice(invoice.id);
    expect(done.status).toBe('paid');
    expect(done.accounting.amountDueCents).toBe(0);
    expect(
      await count('SELECT count(*) AS n FROM payment_snapshots WHERE invoice_id=$1', [invoice.id]),
    ).toBeGreaterThanOrEqual(2);
    expect(
      await count(
        "SELECT count(*) AS n FROM job_events WHERE type='invoice_paid' AND metadata->>'invoiceId'=$1",
        [invoice.id],
      ),
    ).toBe(1);

    // The agent's payment.status read tool reports the reconciled status.
    const tool = await runReadTool(ctx.db.pool, TENANT_A, 'payment.status', {
      invoiceId: invoice.id,
    });
    expect(tool.invoices).toEqual([
      expect.objectContaining({
        invoiceNumber: invoice.invoiceNumber,
        status: 'paid',
        amountPaidCents: done.totalCents,
        amountDueCents: 0,
      }),
    ]);
  });
});

describe('tenancy and roles', () => {
  it('keeps invoices inside their tenant and mutations owner-only', async () => {
    const otherJob = (
      await ctx.db.pool.query<{ id: string; customer_id: string }>(
        'SELECT id, customer_id FROM jobs WHERE tenant_id=$1 LIMIT 1',
        [TENANT_B],
      )
    ).rows[0]!;
    const foreign = randomUUID();
    await ctx.db.pool.query(
      `INSERT INTO invoices(id,tenant_id,invoice_number,customer_id,job_id,issue_date,due_date,currency,gst_registered,prices_entered,tax_basis_points)
       VALUES($1,$2,'INV-0001',$3,$4,'2026-10-20','2026-11-09','NZD',true,'exclusive',1500)`,
      [foreign, TENANT_B, otherJob.customer_id, otherJob.id],
    );
    expect((await ctx.get(`/api/invoices/${foreign}`, owner)).status).toBe(404);
    expect((await ctx.get(`/api/invoices/${foreign}/pdf`, owner)).status).toBe(404);
    expect(
      (await ctx.send('POST', `/api/invoices/${foreign}/approve`, owner, { version: 1 })).status,
    ).toBe(404);
    expect(
      (await ctx.get('/api/invoices', owner)).body.invoices.some(
        (invoice: { id: string }) => invoice.id === foreign,
      ),
    ).toBe(false);
    expect((await ctx.send('POST', `/api/jobs/${otherJob.id}/invoices`, owner, {})).status).toBe(
      404,
    );

    const list = await ctx.get('/api/invoices', viewer);
    expect(list.status).toBe(200);
    const someJob = list.body.invoices[0].jobId as string;
    expect((await ctx.send('POST', `/api/jobs/${someJob}/invoices`, viewer, {})).status).toBe(403);
    expect((await ctx.send('POST', '/api/integrations/xero/disconnect', viewer)).status).toBe(403);
  });

  it('lets the owner disconnect; stored tokens are deleted', async () => {
    const response = await ctx.send('POST', '/api/integrations/xero/disconnect', owner);
    expect(response.status).toBe(200);
    const row = (
      await ctx.db.pool.query(
        "SELECT status, encrypted_credentials FROM provider_connections WHERE tenant_id=$1 AND provider='test'",
        [TENANT_A],
      )
    ).rows[0];
    expect(row).toMatchObject({ status: 'disconnected', encrypted_credentials: null });
  });
});
