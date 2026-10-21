import type { InvoiceSnapshot, PaymentRecord } from './types.js';

/** MOCK. The fake provider's "external system" state, kept per tenant. Demo and test only. */
export interface FakeContact {
  id: string;
  customerId: string;
  name: string;
  email: string | null;
  phone: string | null;
}
export type FakeInvoice = InvoiceSnapshot & { lines: number; tenantId: string };
export type FakePayment = PaymentRecord & { tenantId: string };

/**
 * Where the fake accounting provider keeps its ledger. The in-memory store is for unit and
 * contract tests; the PostgreSQL store (packages/platform) lets the API and a separate worker
 * process share one ledger, the way a real external system would be shared.
 */
export interface FakeLedgerStore {
  nextId(kind: string): Promise<string>;
  getContact(tenantId: string, id: string): Promise<FakeContact | null>;
  listContacts(tenantId: string): Promise<FakeContact[]>;
  putContact(tenantId: string, contact: FakeContact): Promise<void>;
  getInvoice(tenantId: string, id: string): Promise<FakeInvoice | null>;
  /** Unscoped lookup for the mock simulate controls (ids are globally unique). */
  findInvoice(id: string): Promise<FakeInvoice | null>;
  listInvoices(tenantId: string): Promise<FakeInvoice[]>;
  putInvoice(invoice: FakeInvoice): Promise<void>;
  listPayments(tenantId: string): Promise<FakePayment[]>;
  addPayment(payment: FakePayment): Promise<void>;
  getIdempotency(
    tenantId: string,
    key: string,
  ): Promise<{ fingerprint: string; result: unknown } | null>;
  putIdempotency(
    tenantId: string,
    key: string,
    value: { fingerprint: string; result: unknown },
  ): Promise<void>;
  /** Serialise concurrent callers using the same key (across processes for the PostgreSQL store). */
  withLock<T>(tenantId: string, key: string, run: () => Promise<T>): Promise<T>;
}

export class InMemoryFakeLedger implements FakeLedgerStore {
  private sequence = 0;
  private readonly contacts = new Map<string, FakeContact>();
  private readonly invoices = new Map<string, FakeInvoice>();
  private readonly payments: FakePayment[] = [];
  private readonly idempotency = new Map<string, { fingerprint: string; result: unknown }>();
  private readonly tails = new Map<string, Promise<unknown>>();

  async nextId(kind: string) {
    this.sequence += 1;
    return `fake-${kind}-${this.sequence.toString().padStart(4, '0')}`;
  }
  async getContact(tenantId: string, id: string) {
    return this.contacts.get(`${tenantId}:${id}`) ?? null;
  }
  async listContacts(tenantId: string) {
    return [...this.contacts.entries()]
      .filter(([key]) => key.startsWith(`${tenantId}:`))
      .map(([, contact]) => contact);
  }
  async putContact(tenantId: string, contact: FakeContact) {
    this.contacts.set(`${tenantId}:${contact.id}`, contact);
  }
  async getInvoice(tenantId: string, id: string) {
    const invoice = this.invoices.get(id);
    return invoice && invoice.tenantId === tenantId ? invoice : null;
  }
  async findInvoice(id: string) {
    return this.invoices.get(id) ?? null;
  }
  async listInvoices(tenantId: string) {
    return [...this.invoices.values()].filter((invoice) => invoice.tenantId === tenantId);
  }
  async putInvoice(invoice: FakeInvoice) {
    this.invoices.set(invoice.externalInvoiceId, invoice);
  }
  async listPayments(tenantId: string) {
    return this.payments.filter((payment) => payment.tenantId === tenantId);
  }
  async addPayment(payment: FakePayment) {
    this.payments.push(payment);
  }
  async getIdempotency(tenantId: string, key: string) {
    return this.idempotency.get(`${tenantId}:${key}`) ?? null;
  }
  async putIdempotency(
    tenantId: string,
    key: string,
    value: { fingerprint: string; result: unknown },
  ) {
    this.idempotency.set(`${tenantId}:${key}`, value);
  }
  async withLock<T>(tenantId: string, key: string, run: () => Promise<T>): Promise<T> {
    const slot = `${tenantId}:${key}`;
    const previous = this.tails.get(slot) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.tails.set(
      slot,
      next.catch(() => undefined),
    );
    return next;
  }
}
