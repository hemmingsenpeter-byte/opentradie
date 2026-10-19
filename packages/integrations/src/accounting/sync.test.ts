import { describe, expect, it } from 'vitest';
import { InMemoryExternalReferenceStore } from '../credentials/stores.js';
import { TransientError } from '../errors.js';
import { FAKE_AUTHORISATION_CODE, FakeAccountingAdapter } from './fake.js';
import { AccountingSyncService, deriveIdempotencyKey } from './sync.js';
import { assertWriteOptions } from './validation.js';

const TENANT = '66666666-6666-4666-8666-666666666666';

async function connected() {
  const adapter = new FakeAccountingAdapter({ now: () => new Date('2026-10-19T09:00:00Z') });
  const begun = await adapter.beginAuthorisation({ redirectUri: 'https://x.test/cb' });
  await adapter.completeAuthorisation({
    tenantId: TENANT,
    code: FAKE_AUTHORISATION_CODE,
    redirectUri: 'https://x.test/cb',
    codeVerifier: begun.codeVerifier,
  });
  const [org] = await adapter.listOrganisations(TENANT);
  return { adapter, ctx: { tenantId: TENANT, organisationId: org!.organisationId } };
}

const push = {
  customer: { customerId: 'cust-7', name: 'Mere Walker', email: 'mere@example.test' },
  invoiceId: 'inv-7',
  revision: 1,
  invoice: {
    invoiceNumber: 'OT-0007',
    issueDate: '2026-10-19',
    dueDate: '2026-11-02',
    currency: 'NZD',
    lineAmountMode: 'exclusive' as const,
    lines: [
      {
        description: 'Labour',
        quantityMilli: 2000,
        unitAmountCents: 9000,
        accountCode: '200',
        taxCode: 'standard' as const,
      },
    ],
  },
};

describe('idempotency keys', () => {
  it('are deterministic, distinct per operation/revision, and valid for providers', () => {
    const base = { tenantId: TENANT, operation: 'draft_invoice', entityId: 'inv-1', revision: 1 };
    const key = deriveIdempotencyKey(base);
    expect(deriveIdempotencyKey(base)).toBe(key);
    expect(deriveIdempotencyKey({ ...base, revision: 2 })).not.toBe(key);
    expect(
      deriveIdempotencyKey({ ...base, tenantId: '77777777-7777-4777-8777-777777777777' }),
    ).not.toBe(key);
    expect(() => assertWriteOptions({ idempotencyKey: key }, 'test')).not.toThrow();
    expect(key.length).toBeLessThanOrEqual(128);
  });
});

describe('AccountingSyncService', () => {
  it('maps the customer to a contact, creates one draft and records both references', async () => {
    const { adapter, ctx } = await connected();
    const refs = new InMemoryExternalReferenceStore();
    const sync = new AccountingSyncService(adapter, refs);
    const first = await sync.pushDraftInvoice(ctx, push);
    expect(first).toMatchObject({
      status: 'draft',
      subtotalCents: 18_000,
      taxCents: 2_700,
      totalCents: 20_700,
      reference: 'OT-0007',
    });
    expect(await refs.get(TENANT, 'test', 'invoice', 'inv-7')).toBe(first.externalInvoiceId);
    expect(await refs.get(TENANT, 'test', 'contact', 'cust-7')).toBeTruthy();
    const again = await sync.pushDraftInvoice(ctx, push);
    expect(again.externalInvoiceId).toBe(first.externalInvoiceId);
    expect(await adapter.listInvoiceChangesSince(ctx, new Date(0))).toHaveLength(1);
  });

  it('a retry after a lost response reuses the idempotency key and does not duplicate', async () => {
    const { adapter, ctx } = await connected();
    const refs = new InMemoryExternalReferenceStore();
    // Simulate: the draft was created but the reference write never happened (crash).
    const sync = new AccountingSyncService(adapter, refs);
    await sync.pushDraftInvoice(ctx, push);
    const freshRefs = new InMemoryExternalReferenceStore();
    const retried = await new AccountingSyncService(adapter, freshRefs).pushDraftInvoice(ctx, push);
    expect(await adapter.listInvoiceChangesSince(ctx, new Date(0))).toHaveLength(1);
    expect(await freshRefs.get(TENANT, 'test', 'invoice', 'inv-7')).toBe(retried.externalInvoiceId);
  });

  it('surfaces transient failures without recording a reference', async () => {
    const { adapter, ctx } = await connected();
    const refs = new InMemoryExternalReferenceStore();
    adapter.failNext(new TransientError('down', 'http_503', 'test'));
    await expect(
      new AccountingSyncService(adapter, refs).pushDraftInvoice(ctx, push),
    ).rejects.toBeInstanceOf(TransientError);
    expect(await refs.get(TENANT, 'test', 'invoice', 'inv-7')).toBeNull();
  });
});
