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
