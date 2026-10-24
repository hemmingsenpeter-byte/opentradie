import { XeroClient } from 'xero-node';

/**
 * The narrow slice of the official xero-node SDK that the adapter uses. Declaring it here keeps
 * the adapter testable with a fake while production code passes a real XeroClient
 * (createXeroSdkClient). Shapes follow the SDK's camelCase models; enums are their string values.
 */
export interface XeroLineItemPayload {
  description: string;
  quantity: number;
  unitAmount: number;
  accountCode: string;
  taxType: string;
}

export interface XeroInvoicePayload {
  type: 'ACCREC';
  status: 'DRAFT';
  contact: { contactID: string };
  date: string;
  dueDate: string;
  reference: string;
  currencyCode: string;
  lineAmountTypes: 'Exclusive' | 'Inclusive' | 'NoTax';
  lineItems: XeroLineItemPayload[];
}

export interface XeroContactPayload {
  contactID?: string;
  contactNumber: string;
  name: string;
  emailAddress?: string;
  phones?: Array<{ phoneType: 'MOBILE'; phoneNumber: string }>;
}

/** Invoice as returned by the SDK (deserialised); fields may be missing on partial responses. */
export interface XeroInvoiceResult {
  invoiceID?: string;
  invoiceNumber?: string;
  reference?: string;
  status?: string;
  currencyCode?: string;
  subTotal?: number;
  totalTax?: number;
  total?: number;
  amountDue?: number;
  amountPaid?: number;
  updatedDateUTC?: Date | string;
  hasErrors?: boolean;
  validationErrors?: Array<{ message?: string }>;
}

export interface XeroPaymentResult {
  paymentID?: string;
  invoice?: { invoiceID?: string };
  amount?: number;
  date?: Date | string;
  status?: string;
  updatedDateUTC?: Date | string;
}

export interface XeroTaxRateResult {
  name?: string;
  taxType?: string;
  effectiveRate?: number;
  status?: string;
  canApplyToRevenue?: boolean;
}

export interface XeroContactResult {
  contactID?: string;
  hasValidationErrors?: boolean;
  validationErrors?: Array<{ message?: string }>;
}

type Result<T> = Promise<{ body: T }>;

export interface XeroAccountingApiSlice {
  updateOrCreateContacts(
    xeroTenantId: string,
    contacts: { contacts: XeroContactPayload[] },
    summarizeErrors?: boolean,
    idempotencyKey?: string,
  ): Result<{ contacts?: XeroContactResult[] }>;
  createInvoices(
    xeroTenantId: string,
    invoices: { invoices: XeroInvoicePayload[] },
    summarizeErrors?: boolean,
    unitdp?: number,
    idempotencyKey?: string,
  ): Result<{ invoices?: XeroInvoiceResult[] }>;
  getInvoice(xeroTenantId: string, invoiceID: string): Result<{ invoices?: XeroInvoiceResult[] }>;
  getInvoices(
    xeroTenantId: string,
    ifModifiedSince?: Date,
    where?: string,
    order?: string,
    iDs?: string[],
    invoiceNumbers?: string[],
    contactIDs?: string[],
    statuses?: string[],
    page?: number,
    includeArchived?: boolean,
    createdByMyApp?: boolean,
    unitdp?: number,
    summaryOnly?: boolean,
    pageSize?: number,
  ): Result<{ invoices?: XeroInvoiceResult[] }>;
  updateInvoice(
    xeroTenantId: string,
    invoiceID: string,
    invoices: { invoices: Array<{ status: 'DELETED' }> },
    unitdp?: number,
    idempotencyKey?: string,
  ): Result<{ invoices?: XeroInvoiceResult[] }>;
  getPayments(
    xeroTenantId: string,
    ifModifiedSince?: Date,
    where?: string,
    order?: string,
    page?: number,
    pageSize?: number,
  ): Result<{ payments?: XeroPaymentResult[] }>;
  getTaxRates(xeroTenantId: string): Result<{ taxRates?: XeroTaxRateResult[] }>;
}

export interface XeroSdkClient {
  setTokenSet(tokenSet: { access_token: string; token_type: 'Bearer'; expires_at: number }): void;
  /** GET https://api.xero.com/connections; with false, no per-organisation lookups. */
  updateTenants(
    fullOrgDetails?: boolean,
  ): Promise<Array<{ tenantId: string; tenantName?: string; tenantType?: string }>>;
  accountingApi: XeroAccountingApiSlice;
}

/**
 * A real SDK client for API calls. OAuth (authorize URL with PKCE, code exchange, refresh) is
 * handled by XeroOAuthClient instead, because the SDK's consent helpers do not support PKCE and
 * perform OpenID discovery over the network on first use. A fresh client is created per call
 * so access tokens never leak between tenants.
 */
export function createXeroSdkClient(options: { accountingBasePath?: string } = {}): XeroSdkClient {
  const client = new XeroClient();
  if (options.accountingBasePath) client.accountingApi.basePath = options.accountingBasePath;
  // The SDK's generated types use TypeScript enums for status fields; their runtime values are
  // the same strings this slice declares, so the structural cast is sound.
  return client as unknown as XeroSdkClient;
}
