import { describe, expect, it } from 'vitest';
import {
  AuthExpiredError,
  ConflictError,
  PermanentError,
  RateLimitedError,
  ReauthorisationRequiredError,
  TransientError,
  ValidationError,
} from '../../errors.js';
import { InMemoryTokenStore } from '../../credentials/stores.js';
import type { DraftInvoiceInput } from '../types.js';
import { XeroAccountingAdapter } from './adapter.js';
import { mapXeroError } from './errors.js';
import { FakeXeroBackend, fakeXeroTokenEndpoint } from './fake-sdk.js';
import {
  buildXeroContact,
  buildXeroInvoice,
  parseXeroDate,
  toTaxRate,
  XERO_TAX_PRESETS,
} from './mapping.js';
import { XERO_GRANULAR_SCOPES, XeroOAuthClient, type FormFetch } from './oauth-client.js';
import type { XeroInvoicePayload } from './sdk.js';

const TENANT = '22222222-2222-4222-8222-222222222222';
const ORG = '00000000-0000-4000-8000-00000000a001';

function setup() {
  let now = new Date('2026-10-19T09:00:00Z');
  const clock = () => new Date(now);
  const tokenEndpoint = fakeXeroTokenEndpoint('code-1');
  const tokens = new InMemoryTokenStore();
  const backend = new FakeXeroBackend(XERO_TAX_PRESETS.NZ, clock);
  const oauth = new XeroOAuthClient({
    clientId: 'cid',
    clientSecret: 'csecret',
    fetch: tokenEndpoint,
    now: clock,
  });
  const adapter = new XeroAccountingAdapter({
    oauth,
    tokens,
    taxTypes: XERO_TAX_PRESETS.NZ,
    sdkFactory: () => backend.client(),
    now: clock,
  });
  const connect = async () => {
    const begun = await adapter.beginAuthorisation({ redirectUri: 'https://app.example.test/cb' });
    await adapter.completeAuthorisation({
      tenantId: TENANT,
      code: 'code-1',
      redirectUri: 'https://app.example.test/cb',
      codeVerifier: begun.codeVerifier,
    });
  };
  return {
    adapter,
    backend,
    tokens,
    tokenEndpoint,
    connect,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

const ctx = { tenantId: TENANT, organisationId: ORG };

const invoice: DraftInvoiceInput = {
  externalContactId: 'c0ffee00-0000-4000-8000-000000000001',
  invoiceNumber: 'OT-INV-0042',
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
      description: 'Washer',
      quantityMilli: 1,
      unitAmountCents: 4999,
      accountCode: '260',
      taxCode: 'zero_rated',
    },
    {
      description: 'Waste',
      quantityMilli: 2000,
      unitAmountCents: 10,
      accountCode: '200',
      taxCode: 'exempt',
    },
    {
      description: 'Large',
      quantityMilli: 1000,
      unitAmountCents: 99_999_999_999,
      accountCode: '200',
      taxCode: 'standard',
    },
  ],
};

describe('Xero request mapping', () => {
  it('builds an ACCREC draft with exact amount strings, mapped tax types and our number as Reference', () => {
    const payload = buildXeroInvoice(invoice, XERO_TAX_PRESETS.NZ);
    expect(payload).toMatchObject({
      type: 'ACCREC',
      status: 'DRAFT',
      contact: { contactID: invoice.externalContactId },
      reference: 'OT-INV-0042',
      lineAmountTypes: 'Exclusive',
      date: '2026-10-19',
      dueDate: '2026-11-20',
      currencyCode: 'NZD',
    });
    // JSON is what reaches Xero: every amount is the exact decimal of our integer units.
    const json = JSON.stringify(
      payload.lineItems.map((line) => [
        line.quantity,
        line.unitAmount,
        line.taxType,
        line.accountCode,
      ]),
    );
    expect(json).toBe(
      '[[1.5,85,"OUTPUT2","200"],[0.001,49.99,"ZERORATED","260"],[2,0.1,"NONE","200"],[1,999999999.99,"OUTPUT2","200"]]',
    );
    expect(
      buildXeroInvoice({ ...invoice, lineAmountMode: 'inclusive' }, XERO_TAX_PRESETS.NZ)
        .lineAmountTypes,
    ).toBe('Inclusive');
    const noTax = buildXeroInvoice({ ...invoice, lineAmountMode: 'no_tax' }, XERO_TAX_PRESETS.AU);
    expect(noTax.lineAmountTypes).toBe('NoTax');
    expect(new Set(noTax.lineItems.map((line) => line.taxType))).toEqual(new Set(['INPUTTAXED']));
  });

  it('maps contacts by our customer id', () => {
    expect(
      buildXeroContact({
        customerId: 'cust-9',
        externalContactId: null,
        name: ' Pita ',
        email: 'p@example.test',
        phone: '021 1',
      }),
    ).toEqual({
      contactNumber: 'cust-9',
      name: 'Pita',
      emailAddress: 'p@example.test',
      phones: [{ phoneType: 'MOBILE', phoneNumber: '021 1' }],
    });
    expect(
      buildXeroContact({ customerId: 'cust-9', externalContactId: 'abc', name: 'Pita' }).contactID,
    ).toBe('abc');
  });

  it('parses Xero timestamps and tax rates without float maths on rates', () => {
    expect(parseXeroDate('/Date(1760864400000+0000)/')?.toISOString()).toBe(
      '2025-10-19T09:00:00.000Z',
    );
    expect(parseXeroDate('2026-10-19T09:00:00')?.toISOString()).toBe('2026-10-19T09:00:00.000Z');
    expect(parseXeroDate('nonsense')).toBeNull();
    expect(
      toTaxRate({ taxType: 'OUTPUT2', name: 'GST', effectiveRate: 15, status: 'ACTIVE' }),
    ).toEqual({ code: 'OUTPUT2', name: 'GST', rateBasisPoints: 1500 });
    expect(toTaxRate({ taxType: 'X', effectiveRate: 12.5 })?.rateBasisPoints).toBe(1250);
    expect(
      toTaxRate({ taxType: 'INPUT2', effectiveRate: 15, canApplyToRevenue: false }),
    ).toBeNull();
  });
});

describe('XeroAccountingAdapter with a fake SDK', () => {
  it('sends writes with the idempotency key and the tenant access token', async () => {
    const t = setup();
    await t.connect();
    const contact = await t.adapter.upsertContact(
      ctx,
      { customerId: 'cust-1', externalContactId: null, name: 'Aroha' },
      { idempotencyKey: 'k-contact-1' },
    );
    await t.adapter.createDraftInvoice(
      ctx,
      { ...invoice, externalContactId: contact.externalContactId },
      { idempotencyKey: 'k-invoice-1' },
    );
    const writes = t.backend.calls.filter((call) => call.method !== 'updateTenants');
    expect(
      writes.map((call) => [
        call.method,
        call.organisationId,
        call.idempotencyKey,
        call.accessToken,
      ]),
    ).toEqual([
      ['updateOrCreateContacts', ORG, 'k-contact-1', 'access-1'],
      ['createInvoices', ORG, 'k-invoice-1', 'access-1'],
    ]);
    const sent = (writes[1]!.payload as { invoices: XeroInvoicePayload[] }).invoices[0]!;
    expect(sent.contact.contactID).toBe(contact.externalContactId);
    expect(sent.lineItems[0]).toEqual({
      description: 'Labour',
      quantity: 1.5,
      unitAmount: 85,
      accountCode: '200',
      taxType: 'OUTPUT2',
    });
  });

  it('refreshes the token shortly before expiry, once, even for concurrent calls', async () => {
    const t = setup();
    await t.connect();
    t.advance(29 * 60_000); // token lives 30 minutes; refresh skew is 2 minutes
    await Promise.all([
      t.adapter.listTaxRates(ctx),
      t.adapter.listTaxRates(ctx),
      t.adapter.listTaxRates(ctx),
    ]);
    const grants = t.tokenEndpoint.requests.map((form) => form.get('grant_type'));
    expect(grants).toEqual(['authorization_code', 'refresh_token']);
    expect(t.tokenEndpoint.requests[1]!.get('refresh_token')).toBe('refresh-1');
    expect(
      t.backend.calls.filter((c) => c.method === 'getTaxRates').map((c) => c.accessToken),
    ).toEqual(['access-2', 'access-2', 'access-2']);
    expect((await t.tokens.load(TENANT, 'xero'))?.refreshToken).toBe('refresh-2');
  });

  it('marks the connection for reauthorisation when the refresh token is rejected', async () => {
    const t = setup();
    await t.connect();
    await t.tokens.save(TENANT, 'xero', {
      accessToken: 'old',
      refreshToken: 'revoked',
      expiresAt: new Date('2026-10-19T08:00:00Z'),
      scopes: [],
    });
    await expect(t.adapter.listTaxRates(ctx)).rejects.toBeInstanceOf(ReauthorisationRequiredError);
    expect(t.tokens.reauthorisationRequired.has(`${TENANT}:xero`)).toBe(true);
    await expect(t.adapter.listTaxRates(ctx)).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('pages through changed invoices', async () => {
    let now = new Date('2026-10-19T09:00:00Z');
    const backend = new FakeXeroBackend(XERO_TAX_PRESETS.NZ, () => now);
    const tokens = new InMemoryTokenStore();
    await tokens.save(TENANT, 'xero', {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date('2026-10-20T00:00:00Z'),
      scopes: [],
    });
    const adapter = new XeroAccountingAdapter({
      oauth: new XeroOAuthClient({ clientId: 'c', clientSecret: 's' }),
      tokens,
      taxTypes: XERO_TAX_PRESETS.NZ,
      sdkFactory: () => backend.client(),
      now: () => now,
      pageSize: 2,
    });
    const contact = await adapter.upsertContact(
      ctx,
      { customerId: 'c', externalContactId: null, name: 'C' },
      { idempotencyKey: 'c' },
    );
    for (let i = 0; i < 5; i += 1) {
      now = new Date(now.getTime() + 1000);
      await adapter.createDraftInvoice(
        ctx,
        { ...invoice, externalContactId: contact.externalContactId, invoiceNumber: `N${i}` },
        { idempotencyKey: `i${i}` },
      );
    }
    const changes = await adapter.listInvoiceChangesSince(ctx, new Date('2026-10-19T09:00:00Z'));
    expect(changes.map((c) => c.reference)).toEqual(['N0', 'N1', 'N2', 'N3', 'N4']);
    expect(backend.calls.filter((c) => c.method === 'getInvoices')).toHaveLength(3);
  });

  it('withdraws a draft with status DELETED and the idempotency key', async () => {
    const t = setup();
    await t.connect();
    const contact = await t.adapter.upsertContact(
      ctx,
      { customerId: 'x', externalContactId: null, name: 'X' },
      { idempotencyKey: 'x' },
    );
    const created = await t.adapter.createDraftInvoice(
      ctx,
      { ...invoice, externalContactId: contact.externalContactId },
      { idempotencyKey: 'y' },
    );
    await t.adapter.voidDraftInvoice(ctx, created.externalInvoiceId, { idempotencyKey: 'void-y' });
    const update = t.backend.calls.find((c) => c.method === 'updateInvoice')!;
    expect(update.idempotencyKey).toBe('void-y');
    expect(update.payload).toEqual({
      invoiceID: created.externalInvoiceId,
      invoices: [{ status: 'DELETED' }],
    });
  });
});

describe('mapXeroError', () => {
  const sdkReject = (
    statusCode: number,
    body: unknown = null,
    headers: Record<string, string> = {},
  ) => JSON.stringify({ response: { statusCode, headers, body }, body });

  it('maps statuses to the normalised taxonomy', () => {
    expect(mapXeroError(sdkReject(401))).toBeInstanceOf(AuthExpiredError);
    expect(mapXeroError(sdkReject(403, { Type: 'AuthorizationUnsuccessful' }))).toBeInstanceOf(
      ReauthorisationRequiredError,
    );
    expect(mapXeroError(sdkReject(404))).toMatchObject({ kind: 'permanent', code: 'not_found' });
    expect(mapXeroError(sdkReject(503))).toBeInstanceOf(TransientError);
    expect(mapXeroError(sdkReject(0))).toMatchObject({ kind: 'transient', code: 'network' });
    expect(mapXeroError({ code: 'ECONNRESET', message: 'socket hang up' })).toBeInstanceOf(
      TransientError,
    );
    expect(mapXeroError(new TypeError('bug'))).toBeInstanceOf(PermanentError);
    expect(mapXeroError({ response: { status: 429, headers: {} } })).toMatchObject({
      kind: 'rate_limited',
      retryAfterSeconds: 60,
    });
    expect(
      mapXeroError(sdkReject(429, null, { 'retry-after': '12', 'x-rate-limit-problem': 'day' })),
    ).toMatchObject({
      retryAfterSeconds: 12,
      code: 'rate_limit_day',
    });
  });

  it('separates validation failures from duplicates and keeps bodies out of messages', () => {
    const validation = (message: string) => ({
      Type: 'ValidationException',
      Message: 'A validation exception occurred',
      Elements: [{ ValidationErrors: [{ Message: message }] }],
    });
    const invalid = mapXeroError(
      sdkReject(400, validation('Account code 999 is not a valid code for this document.')),
    );
    expect(invalid).toBeInstanceOf(ValidationError);
    expect((invalid as ValidationError).issues).toEqual([
      'Account code 999 is not a valid code for this document.',
    ]);
    expect(invalid.message).not.toContain('999');
    const duplicate = mapXeroError(
      sdkReject(
        400,
        validation('The contact name Secret Customer is already assigned to another contact.'),
      ),
    );
    expect(duplicate).toBeInstanceOf(ConflictError);
    expect(duplicate.message).not.toContain('Secret Customer');
    expect(mapXeroError(new RateLimitedError('x', 'y', 'xero', 1))).toBeInstanceOf(
      RateLimitedError,
    );
  });
});

describe('XeroOAuthClient', () => {
  const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) => ({
    ok: status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => body,
  });

  it('builds the authorize URL with granular scopes, state and an S256 challenge', () => {
    const client = new XeroOAuthClient({ clientId: 'cid', clientSecret: 'secret' });
    const { url, state, codeVerifier } = client.authorizationUrl('https://app.example.test/cb');
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      'https://login.xero.com/identity/connect/authorize',
    );
    expect(Object.fromEntries(parsed.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'cid',
      redirect_uri: 'https://app.example.test/cb',
      scope: XERO_GRANULAR_SCOPES.join(' '),
      state,
      code_challenge_method: 'S256',
    });
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(url).not.toContain('secret');
    expect(
      new XeroOAuthClient({ clientId: 'c', clientSecret: 's', pkce: false }).authorizationUrl(
        'https://x.test/cb',
      ).codeVerifier,
    ).toBeNull();
  });

  it('exchanges a code with client authentication and the PKCE verifier', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetch: FormFetch = async (url, init) => {
      seen.push({ url, headers: init.headers, body: init.body });
      return ok({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 1800,
        scope: 'offline_access accounting.invoices',
      });
    };
    const client = new XeroOAuthClient({
      clientId: 'cid',
      clientSecret: 'secret',
      fetch,
      now: () => new Date('2026-10-19T00:00:00Z'),
    });
    const tokens = await client.exchangeCode({
      code: 'abc',
      redirectUri: 'https://app.example.test/cb',
      codeVerifier: 'v'.repeat(64),
    });
    expect(tokens).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: new Date('2026-10-19T00:30:00Z'),
      scopes: ['offline_access', 'accounting.invoices'],
    });
    expect(seen[0]!.url).toBe('https://identity.xero.com/connect/token');
    expect(seen[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from('cid:secret').toString('base64')}`,
    );
    expect(Object.fromEntries(new URLSearchParams(seen[0]!.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'abc',
      redirect_uri: 'https://app.example.test/cb',
      code_verifier: 'v'.repeat(64),
    });
  });

  it('maps token endpoint failures without echoing secrets', async () => {
    const respond = (response: ReturnType<typeof ok>) =>
      new XeroOAuthClient({ clientId: 'cid', clientSecret: 'secret', fetch: async () => response });
    const refresh = (client: XeroOAuthClient) =>
      client.refresh('refresh-secret').catch((error: Error) => error);
    const reauth = await refresh(respond(ok({ error: 'invalid_grant' }, 400)));
    expect(reauth).toBeInstanceOf(ReauthorisationRequiredError);
    expect(String((reauth as Error).message)).not.toContain('refresh-secret');
    expect(await refresh(respond(ok(null, 429, { 'retry-after': '3' })))).toMatchObject({
      kind: 'rate_limited',
      retryAfterSeconds: 3,
    });
    expect(await refresh(respond(ok(null, 502)))).toBeInstanceOf(TransientError);
    expect(await refresh(respond(ok({ error: 'invalid_client' }, 400)))).toMatchObject({
      kind: 'permanent',
      code: 'invalid_client',
    });
    expect(await refresh(respond(ok({ access_token: 'x' })))).toMatchObject({
      code: 'malformed_token',
    });
    const offline = new XeroOAuthClient({
      clientId: 'c',
      clientSecret: 's',
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await refresh(offline)).toBeInstanceOf(TransientError);
    const badCode = new XeroOAuthClient({
      clientId: 'c',
      clientSecret: 's',
      fetch: async () => ok({ error: 'invalid_grant' }, 400),
    });
    await expect(
      badCode.exchangeCode({ code: 'x', redirectUri: 'https://x.test', codeVerifier: null }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
