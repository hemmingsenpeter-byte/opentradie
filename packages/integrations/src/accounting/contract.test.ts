import { beforeEach, describe, expect, it } from 'vitest';
import {
  AuthExpiredError,
  ConflictError,
  PermanentError,
  RateLimitedError,
  ReauthorisationRequiredError,
  TransientError,
  ValidationError,
} from '../errors.js';
import { InMemoryTokenStore } from '../credentials/stores.js';
import { FAKE_AUTHORISATION_CODE, FakeAccountingAdapter } from './fake.js';
import type { AccountingAdapter, AccountingContext, DraftInvoiceInput } from './types.js';
import { XeroAccountingAdapter } from './xero/adapter.js';
import { FakeXeroBackend, fakeXeroTokenEndpoint } from './xero/fake-sdk.js';
import { XERO_TAX_PRESETS } from './xero/mapping.js';
import { XeroOAuthClient } from './xero/oauth-client.js';

/**
 * Shared contract suite: every AccountingAdapter must pass it. It runs against the mock adapter
 * and against the Xero adapter wired to a fake SDK. Neither run touches a real provider.
 */
type FailureKind = 'unauthorised' | 'rate_limited' | 'server_error';

interface Harness {
  adapter: AccountingAdapter;
  validCode: string;
  authorise(externalInvoiceId: string): void;
  pay(externalInvoiceId: string, cents: number, paidOn: string): void;
  injectFailure(kind: FailureKind, retryAfterSeconds?: number): void;
  advance(ms: number): void;
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const UNKNOWN_INVOICE = '00000000-0000-4000-8000-999999999999';

function clock() {
  let now = new Date('2026-10-19T09:00:00Z');
  return {
    now: () => new Date(now),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

function fakeHarness(): Harness {
  const time = clock();
  const adapter = new FakeAccountingAdapter({ now: time.now });
  return {
    adapter,
    validCode: FAKE_AUTHORISATION_CODE,
    authorise: (id) => adapter.simulateAuthorise(id),
    pay: (id, cents, paidOn) => adapter.simulatePayment(id, cents, paidOn),
    injectFailure: (kind, retryAfter = 1) =>
      adapter.failNext(
        kind === 'unauthorised'
          ? new AuthExpiredError('expired', 'unauthorised', 'test')
          : kind === 'rate_limited'
            ? new RateLimitedError('slow down', 'rate_limit', 'test', retryAfter)
            : new TransientError('down', 'http_503', 'test'),
      ),
    advance: time.advance,
  };
}

function xeroHarness(): Harness {
  const time = clock();
  const backend = new FakeXeroBackend(XERO_TAX_PRESETS.NZ, time.now);
  const validCode = 'xero-test-code';
  const oauth = new XeroOAuthClient({
    clientId: 'client-id-test',
    clientSecret: 'client-secret-test',
    fetch: fakeXeroTokenEndpoint(validCode),
    now: time.now,
  });
  const adapter = new XeroAccountingAdapter({
    oauth,
    tokens: new InMemoryTokenStore(),
    taxTypes: XERO_TAX_PRESETS.NZ,
    sdkFactory: () => backend.client(),
    now: time.now,
  });
  return {
    adapter,
    validCode,
    authorise: (id) => backend.simulateAuthorise(id),
    pay: (id, cents, paidOn) => backend.simulatePayment(id, cents, paidOn),
    injectFailure: (kind, retryAfter = 1) =>
      backend.failNext(
        kind === 'unauthorised'
          ? { status: 401, body: { Type: 'Unauthorized' } }
          : kind === 'rate_limited'
            ? {
                status: 429,
                headers: { 'Retry-After': String(retryAfter), 'X-Rate-Limit-Problem': 'minute' },
              }
            : { status: 503 },
      ),
    advance: time.advance,
  };
}

function draft(
  externalContactId: string,
  overrides: Partial<DraftInvoiceInput> = {},
): DraftInvoiceInput {
  return {
    externalContactId,
    invoiceNumber: 'OT-INV-0001',
    issueDate: '2026-10-19',
    dueDate: '2026-11-20',
    currency: 'NZD',
    lineAmountMode: 'exclusive',
    lines: [
      {
        description: 'Labour',
        quantityMilli: 1500,
        unitAmountCents: 8500,
        accountCode: '200',
        taxCode: 'standard',
      },
      {
        description: 'Export part',
        quantityMilli: 1000,
        unitAmountCents: 4999,
        accountCode: '200',
        taxCode: 'zero_rated',
      },
    ],
    ...overrides,
  };
}

describe.each([
  ['FakeAccountingAdapter (mock)', fakeHarness],
  ['XeroAccountingAdapter with fake SDK', xeroHarness],
])('accounting adapter contract: %s', (_name, makeHarness) => {
  let h: Harness;
  let ctx: AccountingContext;

  async function connect() {
    const begun = await h.adapter.beginAuthorisation({
      redirectUri: 'https://app.example.test/xero/callback',
    });
    await h.adapter.completeAuthorisation({
      tenantId: TENANT,
      code: h.validCode,
      redirectUri: 'https://app.example.test/xero/callback',
      codeVerifier: begun.codeVerifier,
    });
    const [organisation] = await h.adapter.listOrganisations(TENANT);
    ctx = { tenantId: TENANT, organisationId: organisation!.organisationId };
  }

  async function contact(customerId = 'cust-1', name = 'Aroha Smith') {
    return (
      await h.adapter.upsertContact(
        ctx,
        { customerId, externalContactId: null, name, email: 'aroha@example.test' },
        { idempotencyKey: `contact-${customerId}-${name.length}` },
      )
    ).externalContactId;
  }

  beforeEach(() => {
    h = makeHarness();
  });

  it('requires a connection, then connects with state and PKCE', async () => {
    await expect(h.adapter.listOrganisations(TENANT)).rejects.toBeInstanceOf(
      ReauthorisationRequiredError,
    );
    const begun = await h.adapter.beginAuthorisation({
      redirectUri: 'https://app.example.test/cb',
    });
    const url = new URL(begun.url);
    expect(url.protocol).toBe('https:');
    expect(url.searchParams.get('state')).toBe(begun.state);
    expect(begun.state.length).toBeGreaterThanOrEqual(32);
    if (h.adapter.capabilities.pkce) {
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(begun.codeVerifier).toBeTruthy();
      expect(begun.url).not.toContain(begun.codeVerifier!);
    }
    await expect(
      h.adapter.completeAuthorisation({
        tenantId: TENANT,
        code: 'wrong',
        redirectUri: 'https://app.example.test/cb',
        codeVerifier: begun.codeVerifier,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const summary = await h.adapter.completeAuthorisation({
      tenantId: TENANT,
      code: h.validCode,
      redirectUri: 'https://app.example.test/cb',
      codeVerifier: begun.codeVerifier,
    });
    expect(summary.expiresAt.getTime()).toBeGreaterThan(Date.parse('2026-10-19T09:00:00Z'));
    expect((await h.adapter.listOrganisations(TENANT)).length).toBeGreaterThan(0);
  });

  it('upserts a contact by our customer id and keeps the external id stable', async () => {
    await connect();
    const id = await contact();
    const again = await h.adapter.upsertContact(
      ctx,
      {
        customerId: 'cust-1',
        externalContactId: id,
        name: 'Aroha Smith-Jones',
        phone: '+64 21 000 000',
      },
      { idempotencyKey: 'contact-cust-1-rename' },
    );
    expect(again.externalContactId).toBe(id);
  });

  it('reports a duplicate contact name as a conflict', async () => {
    await connect();
    await contact('cust-1', 'Same Name');
    await expect(contact('cust-2', 'Same Name')).rejects.toBeInstanceOf(ConflictError);
  });

  it('creates a draft invoice with exact integer-cent totals', async () => {
    await connect();
    const invoice = await h.adapter.createDraftInvoice(ctx, draft(await contact()), {
      idempotencyKey: 'inv-1',
    });
    expect(invoice).toMatchObject({
      status: 'draft',
      reference: 'OT-INV-0001',
      currency: 'NZD',
      subtotalCents: 17_749, // 1.5 × 85.00 + 49.99
      taxCents: 1_913, // 15% of 127.50 = 19.125 → 19.13; zero-rated line adds 0
      totalCents: 19_662,
      amountDueCents: 19_662,
      amountPaidCents: 0,
    });
    for (const value of [invoice.subtotalCents, invoice.taxCents, invoice.totalCents])
      expect(Number.isSafeInteger(value)).toBe(true);
  });

  it('handles tax-inclusive and no-tax line modes', async () => {
    await connect();
    const id = await contact();
    const line = {
      description: 'Callout',
      quantityMilli: 1000,
      unitAmountCents: 11_500,
      accountCode: '200',
      taxCode: 'standard' as const,
    };
    const inclusive = await h.adapter.createDraftInvoice(
      ctx,
      draft(id, { lineAmountMode: 'inclusive', lines: [line] }),
      { idempotencyKey: 'inv-incl' },
    );
    expect([inclusive.subtotalCents, inclusive.taxCents, inclusive.totalCents]).toEqual([
      10_000, 1_500, 11_500,
    ]);
    const noTax = await h.adapter.createDraftInvoice(
      ctx,
      draft(id, { lineAmountMode: 'no_tax', lines: [line], invoiceNumber: 'OT-2' }),
      { idempotencyKey: 'inv-notax' },
    );
    expect([noTax.subtotalCents, noTax.taxCents, noTax.totalCents]).toEqual([11_500, 0, 11_500]);
  });

  it('replays a write with the same idempotency key instead of duplicating it', async () => {
    await connect();
    const id = await contact();
    const first = await h.adapter.createDraftInvoice(ctx, draft(id), {
      idempotencyKey: 'inv-same',
    });
    const second = await h.adapter.createDraftInvoice(ctx, draft(id), {
      idempotencyKey: 'inv-same',
    });
    expect(second.externalInvoiceId).toBe(first.externalInvoiceId);
    const changed = await h.adapter.listInvoiceChangesSince(ctx, new Date('2026-01-01T00:00:00Z'));
    expect(changed).toHaveLength(1);
  });

  it('rejects invalid writes before calling the provider', async () => {
    await connect();
    const id = await contact();
    await expect(
      h.adapter.createDraftInvoice(ctx, draft(id, { lines: [] }), { idempotencyKey: 'x' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      h.adapter.createDraftInvoice(
        ctx,
        draft(id, { lines: [{ ...draft(id).lines[0]!, unitAmountCents: 12.5 }] }),
        { idempotencyKey: 'x' },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      h.adapter.createDraftInvoice(
        ctx,
        draft(id, { lines: [{ ...draft(id).lines[0]!, quantityMilli: 0 }] }),
        { idempotencyKey: 'x' },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      h.adapter.createDraftInvoice(ctx, draft(id), { idempotencyKey: 'bad key with spaces' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      h.adapter.createDraftInvoice(ctx, draft(id, { dueDate: '2026-02-30' }), {
        idempotencyKey: 'x',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('reads status, amount due and payments after the ledger authorises and is paid', async () => {
    await connect();
    const invoice = await h.adapter.createDraftInvoice(ctx, draft(await contact()), {
      idempotencyKey: 'inv-pay',
    });
    h.advance(60_000);
    h.authorise(invoice.externalInvoiceId);
    h.advance(60_000);
    const checkpoint = new Date(Date.parse('2026-10-19T09:02:00Z'));
    h.pay(invoice.externalInvoiceId, 10_000, '2026-10-20');
    let current = await h.adapter.getInvoice(ctx, invoice.externalInvoiceId);
    expect(current).toMatchObject({
      status: 'authorised',
      amountPaidCents: 10_000,
      amountDueCents: 9_662,
    });
    expect(current.providerInvoiceNumber).toBeTruthy();
    h.advance(60_000);
    h.pay(invoice.externalInvoiceId, 9_662, '2026-10-21');
    current = await h.adapter.getInvoice(ctx, invoice.externalInvoiceId);
    expect(current).toMatchObject({ status: 'paid', amountPaidCents: 19_662, amountDueCents: 0 });

    const payments = await h.adapter.listPaymentsSince(ctx, checkpoint);
    expect(payments.map((p) => [p.amountCents, p.paidOn, p.status])).toEqual([
      [10_000, '2026-10-20', 'active'],
      [9_662, '2026-10-21', 'active'],
    ]);
    expect(payments.every((p) => p.externalInvoiceId === invoice.externalInvoiceId)).toBe(true);
    expect(await h.adapter.listPaymentsSince(ctx, new Date('2026-10-19T10:00:00Z'))).toEqual([]);
    const changes = await h.adapter.listInvoiceChangesSince(ctx, new Date('2026-10-19T09:03:00Z'));
    expect(changes.map((c) => c.status)).toEqual(['paid']);
  });

  it('withdraws drafts but refuses to void authorised invoices', async () => {
    await connect();
    const id = await contact();
    const a = await h.adapter.createDraftInvoice(ctx, draft(id), { idempotencyKey: 'inv-a' });
    const voided = await h.adapter.voidDraftInvoice(ctx, a.externalInvoiceId, {
      idempotencyKey: 'void-a',
    });
    expect(voided.status).toBe('deleted');
    const b = await h.adapter.createDraftInvoice(ctx, draft(id, { invoiceNumber: 'OT-B' }), {
      idempotencyKey: 'inv-b',
    });
    h.authorise(b.externalInvoiceId);
    await expect(
      h.adapter.voidDraftInvoice(ctx, b.externalInvoiceId, { idempotencyKey: 'void-b' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('normalises provider failures', async () => {
    await connect();
    h.injectFailure('unauthorised');
    await expect(h.adapter.listTaxRates(ctx)).rejects.toBeInstanceOf(AuthExpiredError);
    h.injectFailure('rate_limited', 7);
    const limited = await h.adapter.listTaxRates(ctx).catch((error: unknown) => error);
    expect(limited).toBeInstanceOf(RateLimitedError);
    expect((limited as RateLimitedError).retryAfterSeconds).toBe(7);
    expect((limited as RateLimitedError).retryable).toBe(true);
    h.injectFailure('server_error');
    await expect(h.adapter.listTaxRates(ctx)).rejects.toBeInstanceOf(TransientError);
    const missing = await h.adapter
      .getInvoice(ctx, UNKNOWN_INVOICE)
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(PermanentError);
    expect((missing as PermanentError).code).toBe('not_found');
    expect((await h.adapter.listTaxRates(ctx)).length).toBeGreaterThan(0);
  });
});
