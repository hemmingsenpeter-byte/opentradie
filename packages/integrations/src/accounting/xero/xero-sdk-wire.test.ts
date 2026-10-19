import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthExpiredError, RateLimitedError, ValidationError } from '../../errors.js';
import { InMemoryTokenStore } from '../../credentials/stores.js';
import { XeroAccountingAdapter } from './adapter.js';
import { XERO_TAX_PRESETS } from './mapping.js';
import { XeroOAuthClient } from './oauth-client.js';
import { createXeroSdkClient } from './sdk.js';

/**
 * Drives the REAL xero-node SDK against a local HTTP server standing in for api.xero.com, to pin
 * down what actually goes on the wire (JSON field names, number formatting, headers) and how the
 * SDK reports responses and errors. This is still not Xero: it proves our use of the SDK, not
 * Xero's behaviour.
 */
interface Captured {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let server: Server;
let base: string;
const captured: Captured[] = [];
let nextResponse: { status: number; headers?: Record<string, string>; body: unknown } = {
  status: 200,
  body: {},
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      captured.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.writeHead(nextResponse.status, {
        'content-type': 'application/json',
        ...nextResponse.headers,
      });
      res.end(JSON.stringify(nextResponse.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api.xro/2.0`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const TENANT = '33333333-3333-4333-8333-333333333333';
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';

async function adapter() {
  const tokens = new InMemoryTokenStore();
  await tokens.save(TENANT, 'xero', {
    accessToken: 'wire-access-token',
    refreshToken: 'wire-refresh-token',
    expiresAt: new Date(Date.now() + 3_600_000),
    scopes: [],
  });
  return new XeroAccountingAdapter({
    oauth: new XeroOAuthClient({ clientId: 'c', clientSecret: 's' }),
    tokens,
    taxTypes: XERO_TAX_PRESETS.NZ,
    sdkFactory: () => createXeroSdkClient({ accountingBasePath: base }),
  });
}

const xeroInvoice = {
  Invoices: [
    {
      InvoiceID: 'bbbbbbbb-0000-4000-8000-000000000002',
      Type: 'ACCREC',
      Status: 'DRAFT',
      Reference: 'OT-INV-7',
      CurrencyCode: 'NZD',
      LineAmountTypes: 'Exclusive',
      SubTotal: 177.49,
      TotalTax: 19.13,
      Total: 196.62,
      AmountDue: 196.62,
      AmountPaid: 0,
      UpdatedDateUTC: '/Date(1760864400000+0000)/',
    },
  ],
};

describe('xero-node SDK on the wire (local fake server)', () => {
  it('serialises a draft invoice exactly and parses the response into integer cents', async () => {
    captured.length = 0;
    nextResponse = { status: 200, body: xeroInvoice };
    const snapshot = await (
      await adapter()
    ).createDraftInvoice(
      { tenantId: TENANT, organisationId: ORG },
      {
        externalContactId: 'cccccccc-0000-4000-8000-000000000003',
        invoiceNumber: 'OT-INV-7',
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
            description: 'Part',
            quantityMilli: 1000,
            unitAmountCents: 4999,
            accountCode: '200',
            taxCode: 'zero_rated',
          },
        ],
      },
      { idempotencyKey: 'ot-draft_invoice-abc123' },
    );
    expect(captured).toHaveLength(1);
    const request = captured[0]!;
    expect(request.method).toBe('PUT');
    expect(request.url).toMatch(/^\/api\.xro\/2\.0\/Invoices(\?|$)/);
    expect(request.headers.authorization).toBe('Bearer wire-access-token');
    expect(request.headers['xero-tenant-id']).toBe(ORG);
    expect(request.headers['idempotency-key']).toBe('ot-draft_invoice-abc123');
    const sent = JSON.parse(request.body) as { Invoices: Array<Record<string, unknown>> };
    expect(sent.Invoices[0]).toMatchObject({
      Type: 'ACCREC',
      Status: 'DRAFT',
      Contact: { ContactID: 'cccccccc-0000-4000-8000-000000000003' },
      Reference: 'OT-INV-7',
      LineAmountTypes: 'Exclusive',
      CurrencyCode: 'NZD',
      Date: '2026-10-19',
      DueDate: '2026-11-20',
    });
    expect(request.body).toContain('"Quantity":1.5,"UnitAmount":85');
    expect(request.body).toContain('"Quantity":1,"UnitAmount":49.99');
    expect(request.body).toContain('"TaxType":"OUTPUT2"');
    expect(request.body).toContain('"TaxType":"ZERORATED"');
    expect(snapshot).toMatchObject({
      externalInvoiceId: 'bbbbbbbb-0000-4000-8000-000000000002',
      status: 'draft',
      subtotalCents: 17_749,
      taxCents: 1_913,
      totalCents: 19_662,
      amountDueCents: 19_662,
      amountPaidCents: 0,
    });
    expect(snapshot.updatedAt.toISOString()).toBe('2025-10-19T09:00:00.000Z');
  });

  it('reports SDK errors in the shape the error mapper expects', async () => {
    const a = await adapter();
    const ctx = { tenantId: TENANT, organisationId: ORG };
    nextResponse = {
      status: 429,
      headers: { 'retry-after': '5', 'x-rate-limit-problem': 'minute' },
      body: {},
    };
    const limited = await a
      .getInvoice(ctx, 'bbbbbbbb-0000-4000-8000-000000000002')
      .catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(RateLimitedError);
    expect(limited).toMatchObject({ retryAfterSeconds: 5, code: 'rate_limit_minute' });

    nextResponse = { status: 401, body: { Type: 'Unauthorized' } };
    await expect(a.getInvoice(ctx, 'bbbbbbbb-0000-4000-8000-000000000002')).rejects.toBeInstanceOf(
      AuthExpiredError,
    );

    nextResponse = {
      status: 400,
      body: {
        ErrorNumber: 10,
        Type: 'ValidationException',
        Message: 'A validation exception occurred',
        Elements: [{ ValidationErrors: [{ Message: 'Account code 999 is not valid.' }] }],
      },
    };
    const invalid = await a
      .upsertContact(
        ctx,
        { customerId: 'cust-1', externalContactId: null, name: 'N' },
        { idempotencyKey: 'k1' },
      )
      .catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(ValidationError);
    expect((invalid as ValidationError).issues).toEqual(['Account code 999 is not valid.']);
    const contactRequest = captured.at(-1)!;
    expect(contactRequest.method).toBe('POST');
    expect(JSON.parse(contactRequest.body)).toEqual({
      Contacts: [{ ContactNumber: 'cust-1', Name: 'N' }],
    });
    expect(contactRequest.headers['idempotency-key']).toBe('k1');
  });
});
