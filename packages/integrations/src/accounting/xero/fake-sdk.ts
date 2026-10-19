import { centsToDecimalString } from '../../decimal.js';
import { mockLineTotals } from '../mock-totals.js';
import type { LineAmountMode, TaxCode } from '../types.js';
import type { XeroTaxTypeMap } from './mapping.js';
import type { FormFetch } from './oauth-client.js';
import type {
  XeroContactPayload,
  XeroInvoicePayload,
  XeroInvoiceResult,
  XeroPaymentResult,
  XeroSdkClient,
} from './sdk.js';

/**
 * TEST SUPPORT / MOCK. An in-memory stand-in for the slice of xero-node the adapter uses. It
 * mimics the SDK's observable behaviour that the adapter depends on (camelCase models, numbers
 * for amounts, Date objects for timestamps, JSON-string rejections carrying statusCode/headers/
 * body, idempotency-key replay), as checked against the real SDK in xero-sdk-wire.test.ts.
 * It is not Xero and proves nothing about Xero's own validation or tax rules.
 */
export interface RecordedCall {
  method: string;
  organisationId: string;
  accessToken: string;
  idempotencyKey?: string;
  payload?: unknown;
}

export interface InjectedFailure {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

const MODE: Record<XeroInvoicePayload['lineAmountTypes'], LineAmountMode> = {
  Exclusive: 'exclusive',
  Inclusive: 'inclusive',
  NoTax: 'no_tax',
};

function toMilli(quantity: number): number {
  const [whole, fraction = ''] = String(quantity).split('.');
  return Number(BigInt(whole!) * 1000n + BigInt(fraction.padEnd(3, '0').slice(0, 3)));
}
function toCents(amount: number): number {
  const [whole, fraction = ''] = String(amount).split('.');
  return Number(BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2)));
}
const money = (cents: number) => Number(centsToDecimalString(cents));

interface StoredInvoice {
  invoiceID: string;
  invoiceNumber?: string;
  reference: string;
  status: string;
  currencyCode: string;
  subtotal: number;
  tax: number;
  total: number;
  paid: number;
  updated: Date;
}

export class FakeXeroBackend {
  readonly calls: RecordedCall[] = [];
  readonly organisations = [
    {
      tenantId: '00000000-0000-4000-8000-00000000a001',
      tenantName: 'Demo Company (fake)',
      tenantType: 'ORGANISATION',
    },
  ];
  private readonly contacts = new Map<string, XeroContactPayload & { contactID: string }>();
  private readonly invoices = new Map<string, StoredInvoice>();
  private readonly payments: XeroPaymentResult[] = [];
  private readonly replay = new Map<string, unknown>();
  private readonly failures: InjectedFailure[] = [];
  private sequence = 0;
  private readonly taxCodeByType: Map<string, TaxCode>;

  constructor(
    taxTypes: XeroTaxTypeMap,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.taxCodeByType = new Map(
      Object.entries(taxTypes).map(([code, type]) => [type, code as TaxCode]),
    );
  }

  failNext(failure: InjectedFailure): void {
    this.failures.push(failure);
  }

  simulateAuthorise(invoiceID: string): void {
    const invoice = this.invoices.get(invoiceID)!;
    invoice.status = 'AUTHORISED';
    invoice.invoiceNumber = `INV-${invoiceID.slice(-4)}`;
    invoice.updated = this.now();
  }

  simulatePayment(invoiceID: string, amountCents: number, paidOn: string): string {
    const invoice = this.invoices.get(invoiceID)!;
    invoice.paid += amountCents;
    if (invoice.paid >= invoice.total) invoice.status = 'PAID';
    invoice.updated = this.now();
    const paymentID = this.id();
    this.payments.push({
      paymentID,
      invoice: { invoiceID },
      amount: money(amountCents),
      // The real SDK turns Xero's "/Date(...)/" strings into Date objects.
      date: new Date(`${paidOn}T00:00:00Z`),
      status: 'AUTHORISED',
      updatedDateUTC: this.now(),
    });
    return paymentID;
  }

  client(): XeroSdkClient {
    let accessToken = '';
    // The SDK-shaped object literal has its own `this`; the backend is captured explicitly.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const backend = this;
    const record = (call: Omit<RecordedCall, 'accessToken'>) => {
      backend.calls.push({ ...call, accessToken });
      const failure = backend.failures.shift();
      if (failure) {
        // Same shape the generated SDK rejects with: JSON.stringify(new ApiError(e).generateError()).
        throw JSON.stringify({
          response: {
            statusCode: failure.status,
            headers: failure.headers ?? {},
            body: failure.body ?? null,
          },
          body: failure.body ?? null,
        });
      }
    };
    const replayable = <T>(key: string | undefined, run: () => T): T => {
      if (key && backend.replay.has(key)) return structuredClone(backend.replay.get(key)) as T;
      const result = run();
      if (key) backend.replay.set(key, structuredClone(result));
      return result;
    };
    return {
      setTokenSet(tokenSet) {
        accessToken = tokenSet.access_token;
      },
      async updateTenants() {
        record({ method: 'updateTenants', organisationId: '' });
        return structuredClone(backend.organisations);
      },
      accountingApi: {
        async updateOrCreateContacts(organisationId, contacts, _summarize, idempotencyKey) {
          record({
            method: 'updateOrCreateContacts',
            organisationId,
            idempotencyKey,
            payload: contacts,
          });
          return replayable(idempotencyKey, () => ({
            body: { contacts: [backend.upsertContact(contacts.contacts[0]!)] },
          }));
        },
        async createInvoices(organisationId, invoices, _summarize, _unitdp, idempotencyKey) {
          record({ method: 'createInvoices', organisationId, idempotencyKey, payload: invoices });
          return replayable(idempotencyKey, () => ({
            body: { invoices: [backend.createInvoice(invoices.invoices[0]!)] },
          }));
        },
        async getInvoice(organisationId, invoiceID) {
          record({ method: 'getInvoice', organisationId, payload: { invoiceID } });
          const invoice = backend.invoices.get(invoiceID);
          if (!invoice)
            throw JSON.stringify({
              response: { statusCode: 404, headers: {}, body: null },
              body: null,
            });
          return { body: { invoices: [backend.view(invoice)] } };
        },
        async getInvoices(
          organisationId,
          ifModifiedSince,
          where,
          order,
          _ids,
          _numbers,
          _contacts,
          _statuses,
          page,
          _archived,
          _mine,
          _unitdp,
          _summary,
          pageSize,
        ) {
          record({
            method: 'getInvoices',
            organisationId,
            payload: { ifModifiedSince, where, order, page, pageSize },
          });
          const size = pageSize ?? 100;
          const all = [...backend.invoices.values()]
            .filter(
              (invoice) =>
                !ifModifiedSince || invoice.updated.getTime() >= ifModifiedSince.getTime(),
            )
            .sort((a, b) => a.updated.getTime() - b.updated.getTime());
          return {
            body: {
              invoices: all
                .slice(((page ?? 1) - 1) * size, (page ?? 1) * size)
                .map((i) => backend.view(i)),
            },
          };
        },
        async updateInvoice(organisationId, invoiceID, invoices, _unitdp, idempotencyKey) {
          record({
            method: 'updateInvoice',
            organisationId,
            idempotencyKey,
            payload: { invoiceID, ...invoices },
          });
          return replayable(idempotencyKey, () => {
            const invoice = backend.invoices.get(invoiceID)!;
            invoice.status = invoices.invoices[0]!.status;
            invoice.updated = backend.now();
            return { body: { invoices: [backend.view(invoice)] } };
          });
        },
        async getPayments(organisationId, ifModifiedSince, where, order, page, pageSize) {
          record({
            method: 'getPayments',
            organisationId,
            payload: { ifModifiedSince, where, order, page, pageSize },
          });
          const size = pageSize ?? 100;
          const all = backend.payments.filter(
            (payment) =>
              !ifModifiedSince ||
              (payment.updatedDateUTC as Date).getTime() >= ifModifiedSince.getTime(),
          );
          return {
            body: {
              payments: structuredClone(all.slice(((page ?? 1) - 1) * size, (page ?? 1) * size)),
            },
          };
        },
        async getTaxRates(organisationId) {
          record({ method: 'getTaxRates', organisationId });
          return {
            body: {
              taxRates: [
                {
                  name: '15% GST on Income',
                  taxType: 'OUTPUT2',
                  effectiveRate: 15,
                  status: 'ACTIVE',
                  canApplyToRevenue: true,
                },
                {
                  name: 'Zero Rated',
                  taxType: 'ZERORATED',
                  effectiveRate: 0,
                  status: 'ACTIVE',
                  canApplyToRevenue: true,
                },
                {
                  name: 'No GST',
                  taxType: 'NONE',
                  effectiveRate: 0,
                  status: 'ACTIVE',
                  canApplyToRevenue: true,
                },
                {
                  name: '15% GST on Expenses',
                  taxType: 'INPUT2',
                  effectiveRate: 15,
                  status: 'ACTIVE',
                  canApplyToRevenue: false,
                },
              ],
            },
          };
        },
      },
    };
  }

  private id(): string {
    this.sequence += 1;
    return `00000000-0000-4000-8000-${this.sequence.toString().padStart(12, '0')}`;
  }

  private validation(message: string): never {
    throw JSON.stringify({
      response: { statusCode: 400, headers: {}, body: null },
      body: {
        ErrorNumber: 10,
        Type: 'ValidationException',
        Message: 'A validation exception occurred',
        Elements: [{ ValidationErrors: [{ Message: message }] }],
      },
    });
  }

  private upsertContact(contact: XeroContactPayload) {
    const existing = contact.contactID
      ? this.contacts.get(contact.contactID)
      : [...this.contacts.values()].find((c) => c.contactNumber === contact.contactNumber);
    if (contact.contactID && !existing) this.validation('The contact could not be found.');
    const clash = [...this.contacts.values()].find(
      (c) =>
        c.name.toLowerCase() === contact.name.toLowerCase() && c.contactID !== existing?.contactID,
    );
    if (clash)
      this.validation(
        `The contact name ${contact.name} is already assigned to another contact. The contact name must be unique across all active contacts.`,
      );
    const stored = { ...contact, contactID: existing?.contactID ?? this.id() };
    this.contacts.set(stored.contactID, stored);
    return { contactID: stored.contactID };
  }

  private createInvoice(payload: XeroInvoicePayload): XeroInvoiceResult {
    if (!this.contacts.has(payload.contact.contactID))
      this.validation('The contact could not be found.');
    const lines = payload.lineItems.map((line) => {
      const taxCode = this.taxCodeByType.get(line.taxType);
      if (!taxCode)
        this.validation(`The TaxType code '${line.taxType}' does not exist or cannot be used.`);
      return {
        quantityMilli: toMilli(line.quantity),
        unitAmountCents: toCents(line.unitAmount),
        taxCode,
      };
    });
    const totals = mockLineTotals(lines, MODE[payload.lineAmountTypes]);
    const invoice: StoredInvoice = {
      invoiceID: this.id(),
      reference: payload.reference,
      status: payload.status,
      currencyCode: payload.currencyCode,
      subtotal: totals.subtotalCents,
      tax: totals.taxCents,
      total: totals.totalCents,
      paid: 0,
      updated: this.now(),
    };
    this.invoices.set(invoice.invoiceID, invoice);
    return this.view(invoice);
  }

  private view(invoice: StoredInvoice): XeroInvoiceResult {
    return {
      invoiceID: invoice.invoiceID,
      ...(invoice.invoiceNumber ? { invoiceNumber: invoice.invoiceNumber } : {}),
      reference: invoice.reference,
      status: invoice.status,
      currencyCode: invoice.currencyCode,
      subTotal: money(invoice.subtotal),
      totalTax: money(invoice.tax),
      total: money(invoice.total),
      amountDue: money(Math.max(0, invoice.total - invoice.paid)),
      amountPaid: money(invoice.paid),
      updatedDateUTC: new Date(invoice.updated),
    };
  }
}

/** TEST SUPPORT. Fake Xero identity token endpoint for XeroOAuthClient's injectable fetch. */
export function fakeXeroTokenEndpoint(
  validCode: string,
): FormFetch & { requests: URLSearchParams[] } {
  const requests: URLSearchParams[] = [];
  let issued = 0;
  const handler = async (_url: string, init: { body: string }) => {
    const form = new URLSearchParams(init.body);
    requests.push(form);
    const ok =
      (form.get('grant_type') === 'authorization_code' &&
        form.get('code') === validCode &&
        !!form.get('code_verifier')) ||
      (form.get('grant_type') === 'refresh_token' &&
        form.get('refresh_token') === `refresh-${issued}`);
    issued += ok ? 1 : 0;
    return {
      ok,
      status: ok ? 200 : 400,
      headers: { get: () => null },
      json: async () =>
        ok
          ? {
              access_token: `access-${issued}`,
              refresh_token: `refresh-${issued}`,
              expires_in: 1800,
              token_type: 'Bearer',
              scope:
                'offline_access accounting.contacts accounting.invoices accounting.payments.read accounting.settings.read',
            }
          : { error: 'invalid_grant' },
    };
  };
  return Object.assign(handler, { requests });
}
