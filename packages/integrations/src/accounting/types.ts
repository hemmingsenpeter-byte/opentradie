/**
 * Provider-independent accounting contract. Xero is the first implementation; MYOB or
 * QuickBooks adapters implement the same interface.
 *
 * Authority: the accounting provider is the authoritative ledger (invoice numbers it assigns,
 * tax it calculates, payments). OPENTRADIE owns the operational invoice and its sync status.
 *
 * Money crosses this boundary only as integer cents and quantities only as integer thousandths.
 * Every write takes an idempotency key; repeating a write with the same key and payload must not
 * create a second record.
 */
import type { ConnectionProvider } from '../credentials/stores.js';

/** OPENTRADIE's tax classification for a line; adapters map it to provider tax codes. */
export type TaxCode = 'standard' | 'zero_rated' | 'exempt';
export const taxCodes: readonly TaxCode[] = ['standard', 'zero_rated', 'exempt'];

export type LineAmountMode = 'exclusive' | 'inclusive' | 'no_tax';

/** Our tenant plus the provider organisation the owner chose at connection time. */
export interface AccountingContext {
  tenantId: string;
  /** Provider organisation id (Xero: the "xero-tenant-id" of the connected organisation). */
  organisationId: string;
}

export interface WriteOptions {
  /** 1-128 chars of [A-Za-z0-9_.:-]. Derive deterministically so a retry after a crash reuses it. */
  idempotencyKey: string;
}

export interface BeginAuthorisationInput {
  redirectUri: string;
}

export interface BeginAuthorisationResult {
  url: string;
  /** Store server-side bound to the owner's session and compare on callback. */
  state: string;
  /** Present when the provider flow uses PKCE; store server-side, never send to the browser. */
  codeVerifier: string | null;
}

export interface CompleteAuthorisationInput {
  tenantId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string | null;
}

export interface ConnectionSummary {
  scopes: string[];
  expiresAt: Date;
}

export interface Organisation {
  organisationId: string;
  name: string;
}

export interface ProviderTaxRate {
  /** Provider tax type code, e.g. Xero "OUTPUT2". */
  code: string;
  name: string;
  rateBasisPoints: number;
}

export interface ContactInput {
  /** Our customer id; stored on the provider contact as its external number. */
  customerId: string;
  /** Known provider contact id from the external reference mapping, if any. */
  externalContactId: string | null;
  name: string;
  email?: string | null;
  phone?: string | null;
}

export interface ContactResult {
  externalContactId: string;
}

export interface DraftInvoiceLine {
  description: string;
  /** Integer thousandths: 1500 = 1.5 hours. */
  quantityMilli: number;
  unitAmountCents: number;
  accountCode: string;
  taxCode: TaxCode;
}

export interface DraftInvoiceInput {
  externalContactId: string;
  /** Our invoice number; Xero stores it as Reference. The provider assigns its own number. */
  invoiceNumber: string;
  /** YYYY-MM-DD */
  issueDate: string;
  /** YYYY-MM-DD */
  dueDate: string;
  currency: string;
  lineAmountMode: LineAmountMode;
  lines: DraftInvoiceLine[];
}

export type InvoiceStatus = 'draft' | 'submitted' | 'authorised' | 'paid' | 'voided' | 'deleted';

/** Provider view of an invoice; amounts are the provider's (authoritative) figures in cents. */
export interface InvoiceSnapshot {
  externalInvoiceId: string;
  /** Number assigned by the provider, when it has assigned one. */
  providerInvoiceNumber: string | null;
  reference: string | null;
  status: InvoiceStatus;
  currency: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  amountDueCents: number;
  amountPaidCents: number;
  updatedAt: Date;
}

export interface PaymentRecord {
  externalPaymentId: string;
  externalInvoiceId: string;
  amountCents: number;
  /** YYYY-MM-DD */
  paidOn: string;
  status: 'active' | 'deleted';
  updatedAt: Date;
}

export interface AccountingAdapter {
  readonly provider: ConnectionProvider;
  /** "mock" adapters are never evidence of a working provider integration. */
  readonly kind: 'provider' | 'mock';
  readonly capabilities: { pkce: boolean };

  beginAuthorisation(input: BeginAuthorisationInput): Promise<BeginAuthorisationResult>;
  completeAuthorisation(input: CompleteAuthorisationInput): Promise<ConnectionSummary>;
  /** Forces a refresh now. Adapters also refresh automatically before expiry. */
  refreshTokens(tenantId: string): Promise<ConnectionSummary>;
  listOrganisations(tenantId: string): Promise<Organisation[]>;
  listTaxRates(context: AccountingContext): Promise<ProviderTaxRate[]>;

  upsertContact(
    context: AccountingContext,
    input: ContactInput,
    options: WriteOptions,
  ): Promise<ContactResult>;
  createDraftInvoice(
    context: AccountingContext,
    input: DraftInvoiceInput,
    options: WriteOptions,
  ): Promise<InvoiceSnapshot>;
  getInvoice(context: AccountingContext, externalInvoiceId: string): Promise<InvoiceSnapshot>;
  /** Invoices changed at or after `since` (provider modified time). */
  listInvoiceChangesSince(context: AccountingContext, since: Date): Promise<InvoiceSnapshot[]>;
  /** Payments created or changed at or after `since`. */
  listPaymentsSince(context: AccountingContext, since: Date): Promise<PaymentRecord[]>;
  /**
   * Withdraws an invoice that is still a draft (Xero: status DELETED). Authorised invoices are
   * refused with ConflictError: voiding a posted invoice is an owner action in the ledger.
   */
  voidDraftInvoice(
    context: AccountingContext,
    externalInvoiceId: string,
    options: WriteOptions,
  ): Promise<InvoiceSnapshot>;
}
