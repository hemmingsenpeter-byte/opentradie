import { createHash } from 'node:crypto';
import type { ExternalReferenceStore } from '../credentials/stores.js';
import type {
  AccountingAdapter,
  AccountingContext,
  ContactInput,
  DraftInvoiceInput,
  InvoiceSnapshot,
} from './types.js';

/**
 * Deterministic idempotency key: the same operation on the same entity revision always produces
 * the same key, so a retry after a crash or timeout can never create a second provider record.
 */
export function deriveIdempotencyKey(parts: {
  tenantId: string;
  operation: string;
  entityId: string;
  revision: number | string;
}): string {
  const digest = createHash('sha256')
    .update(
      [parts.tenantId, parts.operation, parts.entityId, String(parts.revision)].join('\u0000'),
    )
    .digest('hex');
  return `ot-${parts.operation.replace(/[^a-z0-9_]/gi, '').slice(0, 20)}-${digest.slice(0, 48)}`;
}

export interface PushInvoiceInput {
  customer: Omit<ContactInput, 'externalContactId'>;
  invoiceId: string;
  /** Bumped by the caller whenever the operational invoice is re-sent after a change. */
  revision: number;
  invoice: Omit<DraftInvoiceInput, 'externalContactId'>;
}

/**
 * Pushes an owner-approved operational invoice to the ledger as a draft: ensure the contact
 * mapping, create the draft, record the provider invoice id. Callers persist sync status and
 * audit events in their own transaction; this service performs no retries itself.
 */
export class AccountingSyncService {
  constructor(
    private readonly adapter: AccountingAdapter,
    private readonly references: ExternalReferenceStore,
  ) {}

  async pushDraftInvoice(
    context: AccountingContext,
    input: PushInvoiceInput,
  ): Promise<InvoiceSnapshot> {
    const provider = this.adapter.provider;
    const known = await this.references.get(
      context.tenantId,
      provider,
      'contact',
      input.customer.customerId,
    );
    const contact = await this.adapter.upsertContact(
      context,
      { ...input.customer, externalContactId: known },
      {
        idempotencyKey: deriveIdempotencyKey({
          tenantId: context.tenantId,
          operation: 'contact',
          entityId: input.customer.customerId,
          // The known mapping is part of the request, so it is part of the key: replaying the
          // first (unmapped) request after a crash reuses the first key exactly.
          revision: `${input.invoiceId}:${input.revision}:${known ?? 'unmapped'}`,
        }),
      },
    );
    if (contact.externalContactId !== known)
      await this.references.put(
        context.tenantId,
        provider,
        'contact',
        input.customer.customerId,
        contact.externalContactId,
      );

    const existingInvoice = await this.references.get(
      context.tenantId,
      provider,
      'invoice',
      input.invoiceId,
    );
    if (existingInvoice) return this.adapter.getInvoice(context, existingInvoice);

    const snapshot = await this.adapter.createDraftInvoice(
      context,
      { ...input.invoice, externalContactId: contact.externalContactId },
      {
        idempotencyKey: deriveIdempotencyKey({
          tenantId: context.tenantId,
          operation: 'draft_invoice',
          entityId: input.invoiceId,
          revision: input.revision,
        }),
      },
    );
    await this.references.put(
      context.tenantId,
      provider,
      'invoice',
      input.invoiceId,
      snapshot.externalInvoiceId,
    );
    return snapshot;
  }
}
