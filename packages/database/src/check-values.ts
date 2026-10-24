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
  'system',
  'mailbox_sync',
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

/** provider_connections.provider: 0001 list plus `fake_mail` (0013). */
export const CONNECTION_PROVIDERS = [
  'xero',
  'gmail',
  'microsoft_graph',
  'whatsapp_business',
  'test',
  'fake_mail',
] as const;

/** provider_connections.sync_warning (0017). */
export const MAIL_SYNC_WARNINGS = ['cursor_reset'] as const;

/** oauth_authorisations.provider: 0010 list plus the mail providers (0013). */
export const OAUTH_AUTHORISATION_PROVIDERS = [
  'xero',
  'test',
  'gmail',
  'microsoft_graph',
  'fake_mail',
] as const;

/** reminders.status: 0009 list plus `escalated` (0014). */
export const REMINDER_STATUSES = [
  'scheduled',
  'prepared',
  'sent',
  'cancelled',
  'suppressed',
  'escalated',
] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

/** approved_rate_history.change (0019). */
export const RATE_HISTORY_CHANGES = [
  'created',
  'updated',
  'retired',
  'reactivated',
  'imported',
] as const;
export type RateHistoryChange = (typeof RATE_HISTORY_CHANGES)[number];

/** auth_tokens.purpose (0020): short-lived single-use tokens, stored as SHA-256 hashes. */
export const AUTH_TOKEN_PURPOSES = ['mfa_login', 'password_reset'] as const;
export type AuthTokenPurpose = (typeof AUTH_TOKEN_PURPOSES)[number];
