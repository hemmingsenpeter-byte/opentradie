import {
  centsToDecimalString,
  decimalStringToWireNumber,
  decimalToCents,
  milliToDecimalString,
  percentToBasisPoints,
} from '../../decimal.js';
import { PermanentError, ValidationError } from '../../errors.js';
import type {
  ContactInput,
  DraftInvoiceInput,
  InvoiceSnapshot,
  InvoiceStatus,
  LineAmountMode,
  PaymentRecord,
  ProviderTaxRate,
  TaxCode,
} from '../types.js';
import type {
  XeroContactPayload,
  XeroInvoicePayload,
  XeroInvoiceResult,
  XeroPaymentResult,
  XeroTaxRateResult,
} from './sdk.js';

export type XeroTaxTypeMap = Record<TaxCode, string>;

/**
 * Starting points for the tax-type mapping. Xero tax types are per region and per organisation
 * (custom rates exist), so the owner must confirm the mapping against GET /TaxRates for their
 * organisation during setup. These defaults are not integration-tested.
 */
export const XERO_TAX_PRESETS: Record<'NZ' | 'AU', XeroTaxTypeMap> = {
  // NZ: GST on Income 15%, Zero Rated, No GST. ("ZERORATED" is from memory of Xero's NZ tax
  // type table and could not be re-verified while writing this; confirm via GET /TaxRates.)
  NZ: { standard: 'OUTPUT2', zero_rated: 'ZERORATED', exempt: 'NONE' },
  // AU: GST on Income 10%, GST Free Income, Input Taxed sales.
  AU: { standard: 'OUTPUT', zero_rated: 'EXEMPTOUTPUT', exempt: 'INPUTTAXED' },
};

const LINE_AMOUNT_TYPES: Record<LineAmountMode, XeroInvoicePayload['lineAmountTypes']> = {
  exclusive: 'Exclusive',
  inclusive: 'Inclusive',
  no_tax: 'NoTax',
};

/** Exact decimal string → SDK number; the number is guaranteed to serialise to the same decimal. */
function wire(decimal: string): number {
  try {
    return decimalStringToWireNumber(decimal);
  } catch {
    throw new ValidationError('Amount cannot be sent to Xero exactly.', 'amount_precision', 'xero');
  }
}

export function buildXeroContact(input: ContactInput): XeroContactPayload {
  const contact: XeroContactPayload = {
    // Our customer id is stored as Xero ContactNumber so the link survives a lost mapping row.
    contactNumber: input.customerId,
    name: input.name.trim(),
  };
  if (input.externalContactId) contact.contactID = input.externalContactId;
  if (input.email) contact.emailAddress = input.email;
  if (input.phone) contact.phones = [{ phoneType: 'MOBILE', phoneNumber: input.phone }];
  return contact;
}

export function buildXeroInvoice(
  input: DraftInvoiceInput,
  taxTypes: XeroTaxTypeMap,
): XeroInvoicePayload {
  return {
    type: 'ACCREC',
    status: 'DRAFT',
    contact: { contactID: input.externalContactId },
    date: input.issueDate,
    dueDate: input.dueDate,
    reference: input.invoiceNumber,
    currencyCode: input.currency,
    lineAmountTypes: LINE_AMOUNT_TYPES[input.lineAmountMode],
    lineItems: input.lines.map((line) => ({
      description: line.description,
      quantity: wire(milliToDecimalString(line.quantityMilli)),
      unitAmount: wire(centsToDecimalString(line.unitAmountCents)),
      accountCode: line.accountCode,
      // NoTax invoices still carry a tax type; Xero requires one that resolves to 0%.
      taxType: input.lineAmountMode === 'no_tax' ? taxTypes.exempt : taxTypes[line.taxCode],
    })),
  };
}

const STATUS: Record<string, InvoiceStatus> = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  AUTHORISED: 'authorised',
  PAID: 'paid',
  VOIDED: 'voided',
  DELETED: 'deleted',
};

/** Xero dates arrive as Date objects, ISO strings or MS-JSON "/Date(1700000000000+0000)/". */
export function parseXeroDate(value: Date | string | undefined): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;
  const ms = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(value);
  if (ms) return new Date(Number(ms[1]));
  const parsed = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function cents(value: number | undefined, field: string): number {
  if (value === undefined || value === null) return 0;
  try {
    return decimalToCents(value);
  } catch {
    throw new PermanentError(`Xero returned an unexpected ${field}.`, 'malformed_response', 'xero');
  }
}

export function toInvoiceSnapshot(invoice: XeroInvoiceResult | undefined): InvoiceSnapshot {
  if (!invoice?.invoiceID || !invoice.status || !STATUS[invoice.status])
    throw new PermanentError('Xero returned an incomplete invoice.', 'malformed_response', 'xero');
  return {
    externalInvoiceId: invoice.invoiceID,
    providerInvoiceNumber: invoice.invoiceNumber || null,
    reference: invoice.reference || null,
    status: STATUS[invoice.status]!,
    currency: invoice.currencyCode ?? '',
    subtotalCents: cents(invoice.subTotal, 'subtotal'),
    taxCents: cents(invoice.totalTax, 'tax'),
    totalCents: cents(invoice.total, 'total'),
    amountDueCents: cents(invoice.amountDue, 'amount due'),
    amountPaidCents: cents(invoice.amountPaid, 'amount paid'),
    updatedAt: parseXeroDate(invoice.updatedDateUTC) ?? new Date(0),
  };
}

export function toPaymentRecord(payment: XeroPaymentResult): PaymentRecord | null {
  if (!payment.paymentID || !payment.invoice?.invoiceID) return null;
  const paid = parseXeroDate(payment.date);
  return {
    externalPaymentId: payment.paymentID,
    externalInvoiceId: payment.invoice.invoiceID,
    amountCents: cents(payment.amount, 'payment amount'),
    paidOn: paid ? paid.toISOString().slice(0, 10) : '',
    status: payment.status === 'DELETED' ? 'deleted' : 'active',
    updatedAt: parseXeroDate(payment.updatedDateUTC) ?? new Date(0),
  };
}

export function toTaxRate(rate: XeroTaxRateResult): ProviderTaxRate | null {
  if (!rate.taxType || rate.status === 'DELETED' || rate.status === 'ARCHIVED') return null;
  if (rate.canApplyToRevenue === false) return null;
  let rateBasisPoints: number;
  try {
    rateBasisPoints = percentToBasisPoints(rate.effectiveRate ?? 0);
  } catch {
    return null;
  }
  return { code: rate.taxType, name: rate.name ?? rate.taxType, rateBasisPoints };
}
