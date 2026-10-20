/**
 * Values the code writes into CHECK-constrained text columns. Migrations restate these lists
 * when they extend them; tests/integration/migrations.test.ts asserts that the final schema
 * allows exactly these values, so a later migration cannot silently drop one.
 */
export const COMMUNICATION_STATUSES = [
  'received',
  'draft',
  'approved',
  'sending',
  'sent',
  'failed',
  'discarded',
] as const;
export type CommunicationStatus = (typeof COMMUNICATION_STATUSES)[number];

/** `legacy` covers rows written before 0008 and code paths that do not set an origin. */
export const COMMUNICATION_ORIGINS = [
  'legacy',
  'webhook',
  'manual_paste',
  'agent_draft',
  'owner',
] as const;
export type CommunicationOrigin = (typeof COMMUNICATION_ORIGINS)[number];

export const JOB_ORIGINS = ['manual', 'assistant_proposed', 'seed', 'email'] as const;
export type JobOrigin = (typeof JOB_ORIGINS)[number];

/** invoices.status (0010). */
export const INVOICE_STATUSES = [
  'draft',
  'approved',
  'posting',
  'posted',
  'sync_failed',
  'void',
  'paid',
  'part_paid',
] as const;
export type InvoiceRecordStatus = (typeof INVOICE_STATUSES)[number];

/** documents.kind: 0004 list plus `invoice_pdf` (0010). */
export const DOCUMENT_KINDS = [
  'approved_quote',
  'quote_pdf',
  'attachment',
  'photo',
  'other',
  'invoice_pdf',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
