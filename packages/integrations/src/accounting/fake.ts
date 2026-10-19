import {
  ConflictError,
  PermanentError,
  ReauthorisationRequiredError,
  ValidationError,
  type IntegrationError,
} from '../errors.js';
import { InMemoryTokenStore, type TokenStore } from '../credentials/stores.js';
import { mockLineTotals, MOCK_TAX_BASIS_POINTS } from './mock-totals.js';
import { createOAuthState, createPkcePair, pkceChallenge, type OAuthTokenSet } from './oauth.js';
import type {
  AccountingAdapter,
  AccountingContext,
  BeginAuthorisationInput,
  CompleteAuthorisationInput,
  ContactInput,
  DraftInvoiceInput,
  InvoiceSnapshot,
  PaymentRecord,
  WriteOptions,
} from './types.js';
import { assertWriteOptions, validateContact, validateDraftInvoice } from './validation.js';

export const FAKE_AUTHORISATION_CODE = 'fake-authorisation-code';
export const FAKE_ORGANISATION_ID = 'fake-organisation-0001';

interface FakeContact {
  id: string;
  customerId: string;
  name: string;
  email: string | null;
  phone: string | null;
}

/**
 * MOCK. Deterministic in-memory accounting provider for CI and demos. It follows the contract and
 * the same pre-flight validation as real adapters, but it is not evidence that any real
 * accounting integration works. Data lives only in this object.
 */
export class FakeAccountingAdapter implements AccountingAdapter {
  readonly provider = 'test' as const;
  readonly kind = 'mock' as const;
  readonly capabilities = { pkce: true };

  private readonly tokens: TokenStore;
  private readonly now: () => Date;
  private readonly contacts = new Map<string, FakeContact>();
  private readonly invoices = new Map<string, InvoiceSnapshot & { lines: number }>();
  private readonly payments: PaymentRecord[] = [];
  private readonly idempotency = new Map<string, { fingerprint: string; result: unknown }>();
  private readonly pendingVerifiers = new Map<string, string>();
  private readonly failures: IntegrationError[] = [];
  private sequence = 0;

  constructor(options: { tokens?: TokenStore; now?: () => Date } = {}) {
    this.tokens = options.tokens ?? new InMemoryTokenStore();
    this.now = options.now ?? (() => new Date());
  }

  // ---- test controls (mock only) ----

  /** The next adapter call throws this error (FIFO). */
  failNext(error: IntegrationError): void {
    this.failures.push(error);
  }

  simulateAuthorise(externalInvoiceId: string): void {
    const invoice = this.requireInvoice(externalInvoiceId);
    invoice.status = 'authorised';
    invoice.providerInvoiceNumber ??= `FAKE-INV-${externalInvoiceId.slice(-4)}`;
    invoice.updatedAt = this.now();
  }

  simulatePayment(externalInvoiceId: string, amountCents: number, paidOn: string): PaymentRecord {
    const invoice = this.requireInvoice(externalInvoiceId);
    if (invoice.status !== 'authorised')
      throw new ConflictError('Only authorised invoices take payments.', 'state', this.provider);
    invoice.amountPaidCents += amountCents;
    invoice.amountDueCents = invoice.totalCents - invoice.amountPaidCents;
    if (invoice.amountDueCents <= 0) invoice.status = 'paid';
    invoice.updatedAt = this.now();
    const payment: PaymentRecord = {
      externalPaymentId: this.nextId('payment'),
      externalInvoiceId,
      amountCents,
      paidOn,
      status: 'active',
      updatedAt: this.now(),
    };
    this.payments.push(payment);
    return payment;
  }

  // ---- contract ----

  async beginAuthorisation(input: BeginAuthorisationInput) {
    const state = createOAuthState();
    const { codeVerifier, codeChallenge } = createPkcePair();
    this.pendingVerifiers.set(codeChallenge, codeVerifier);
    const url = new URL('https://accounting.fake.invalid/authorize');
    url.search = new URLSearchParams({
      redirect_uri: input.redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString(), state, codeVerifier };
  }

  async completeAuthorisation(input: CompleteAuthorisationInput) {
    this.takeFailure();
    const verifierKnown =
      input.codeVerifier !== null && this.pendingVerifiers.has(pkceChallenge(input.codeVerifier));
    if (input.code !== FAKE_AUTHORISATION_CODE || !verifierKnown)
      throw new ValidationError(
        'The authorisation code was rejected.',
        'invalid_grant',
        this.provider,
      );
    this.pendingVerifiers.delete(pkceChallenge(input.codeVerifier!));
    const tokens = this.issueTokens();
    await this.tokens.save(input.tenantId, this.provider, tokens, {
      externalAccountId: FAKE_ORGANISATION_ID,
    });
    return { scopes: tokens.scopes, expiresAt: tokens.expiresAt };
  }

  async refreshTokens(tenantId: string) {
    this.takeFailure();
    await this.requireConnection(tenantId);
    const tokens = this.issueTokens();
    await this.tokens.save(tenantId, this.provider, tokens);
    return { scopes: tokens.scopes, expiresAt: tokens.expiresAt };
  }

  async listOrganisations(tenantId: string) {
    await this.guard(tenantId);
    return [{ organisationId: FAKE_ORGANISATION_ID, name: 'Fake Accounting Organisation (mock)' }];
  }

  async listTaxRates(context: AccountingContext) {
    await this.guard(context.tenantId);
    return Object.entries(MOCK_TAX_BASIS_POINTS).map(([code, rateBasisPoints]) => ({
      code: `FAKE_${code.toUpperCase()}`,
      name: `Fake ${code.replace('_', ' ')}`,
      rateBasisPoints,
    }));
  }

  async upsertContact(context: AccountingContext, input: ContactInput, options: WriteOptions) {
    assertWriteOptions(options, this.provider);
    validateContact(input, this.provider);
    await this.guard(context.tenantId);
    return this.idempotent('contact', options.idempotencyKey, input, () => {
      const duplicate = [...this.contacts.values()].find(
        (contact) =>
          contact.name.toLowerCase() === input.name.trim().toLowerCase() &&
          contact.id !== input.externalContactId &&
          contact.customerId !== input.customerId,
      );
      if (duplicate)
        throw new ConflictError(
          'A contact with this name already exists.',
          'duplicate',
          this.provider,
        );
      const existing = input.externalContactId
        ? this.contacts.get(input.externalContactId)
        : [...this.contacts.values()].find((contact) => contact.customerId === input.customerId);
      if (input.externalContactId && !existing)
        throw new PermanentError('Contact not found.', 'not_found', this.provider);
      const contact: FakeContact = {
        id: existing?.id ?? this.nextId('contact'),
        customerId: input.customerId,
        name: input.name.trim(),
        email: input.email ?? null,
        phone: input.phone ?? null,
      };
      this.contacts.set(contact.id, contact);
      return { externalContactId: contact.id };
    });
  }

  async createDraftInvoice(
    context: AccountingContext,
    input: DraftInvoiceInput,
    options: WriteOptions,
  ) {
    assertWriteOptions(options, this.provider);
    validateDraftInvoice(input, this.provider);
    await this.guard(context.tenantId);
    return this.idempotent('invoice', options.idempotencyKey, input, () => {
      if (!this.contacts.has(input.externalContactId))
        throw new ValidationError('Contact does not exist.', 'contact', this.provider, [
          'externalContactId does not match a contact.',
        ]);
      const totals = mockLineTotals(input.lines, input.lineAmountMode);
      const invoice = {
        externalInvoiceId: this.nextId('invoice'),
        providerInvoiceNumber: null,
        reference: input.invoiceNumber,
        status: 'draft' as const,
        currency: input.currency,
        ...totals,
        amountDueCents: totals.totalCents,
        amountPaidCents: 0,
        updatedAt: this.now(),
        lines: input.lines.length,
      };
      this.invoices.set(invoice.externalInvoiceId, invoice);
      return snapshot(invoice);
    });
  }

  async getInvoice(context: AccountingContext, externalInvoiceId: string) {
    await this.guard(context.tenantId);
    return snapshot(this.requireInvoice(externalInvoiceId));
  }

  async listInvoiceChangesSince(context: AccountingContext, since: Date) {
    await this.guard(context.tenantId);
    return [...this.invoices.values()]
      .filter((invoice) => invoice.updatedAt.getTime() >= since.getTime())
      .map(snapshot);
  }

  async listPaymentsSince(context: AccountingContext, since: Date) {
    await this.guard(context.tenantId);
    return this.payments
      .filter((payment) => payment.updatedAt.getTime() >= since.getTime())
      .map((payment) => ({ ...payment }));
  }

  async voidDraftInvoice(
    context: AccountingContext,
    externalInvoiceId: string,
    options: WriteOptions,
  ) {
    assertWriteOptions(options, this.provider);
    await this.guard(context.tenantId);
    return this.idempotent('void', options.idempotencyKey, { externalInvoiceId }, () => {
      const invoice = this.requireInvoice(externalInvoiceId);
      if (invoice.status !== 'draft' && invoice.status !== 'submitted')
        throw new ConflictError(
          'Only draft invoices can be withdrawn.',
          'not_draft',
          this.provider,
        );
      invoice.status = 'deleted';
      invoice.updatedAt = this.now();
      return snapshot(invoice);
    });
  }

  // ---- internals ----

  private issueTokens(): OAuthTokenSet {
    return {
      accessToken: `fake-access-${this.nextId('token')}`,
      refreshToken: `fake-refresh-${this.nextId('token')}`,
      expiresAt: new Date(this.now().getTime() + 30 * 60_000),
      scopes: ['fake.accounting'],
    };
  }

  private nextId(kind: string): string {
    this.sequence += 1;
    return `fake-${kind}-${this.sequence.toString().padStart(4, '0')}`;
  }

  private takeFailure(): void {
    const failure = this.failures.shift();
    if (failure) throw failure;
  }

  private async requireConnection(tenantId: string): Promise<void> {
    if (!(await this.tokens.load(tenantId, this.provider)))
      throw new ReauthorisationRequiredError(
        'Connect the accounting provider first.',
        'not_connected',
        this.provider,
      );
  }

  private async guard(tenantId: string): Promise<void> {
    await this.requireConnection(tenantId);
    this.takeFailure();
  }

  private requireInvoice(id: string) {
    const invoice = this.invoices.get(id);
    if (!invoice) throw new PermanentError('Invoice not found.', 'not_found', this.provider);
    return invoice;
  }

  private idempotent<T>(operation: string, key: string, payload: unknown, run: () => T): T {
    const scoped = `${operation}:${key}`;
    const fingerprint = JSON.stringify(payload);
    const previous = this.idempotency.get(scoped);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new ConflictError(
          'Idempotency key reused with a different request.',
          'idempotency_key_reuse',
          this.provider,
        );
      return structuredClone(previous.result) as T;
    }
    const result = run();
    this.idempotency.set(scoped, { fingerprint, result: structuredClone(result) });
    return result;
  }
}

function snapshot(invoice: InvoiceSnapshot & { lines?: number }): InvoiceSnapshot {
  const { lines: _lines, ...rest } = invoice;
  return { ...rest, updatedAt: new Date(rest.updatedAt) };
}
