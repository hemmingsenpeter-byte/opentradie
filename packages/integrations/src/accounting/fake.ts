import { randomBytes } from 'node:crypto';
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
import {
  InMemoryFakeLedger,
  type FakeContact,
  type FakeInvoice,
  type FakeLedgerStore,
} from './fake-ledger.js';
import { assertWriteOptions, validateContact, validateDraftInvoice } from './validation.js';

export const FAKE_AUTHORISATION_CODE = 'fake-authorisation-code';
export const FAKE_ORGANISATION_ID = 'fake-organisation-0001';

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
  private readonly ledger: FakeLedgerStore;
  private readonly pendingVerifiers = new Map<string, string>();
  private readonly failures: IntegrationError[] = [];

  constructor(options: { tokens?: TokenStore; now?: () => Date; ledger?: FakeLedgerStore } = {}) {
    this.ledger = options.ledger ?? new InMemoryFakeLedger();
    this.tokens = options.tokens ?? new InMemoryTokenStore();
    this.now = options.now ?? (() => new Date());
  }

  // ---- test controls (mock only) ----

  /** The next adapter call throws this error (FIFO). */
  failNext(error: IntegrationError): void {
    this.failures.push(error);
  }

  async simulateAuthorise(externalInvoiceId: string): Promise<void> {
    const invoice = await this.requireInvoiceById(externalInvoiceId);
    invoice.status = 'authorised';
    invoice.providerInvoiceNumber ??= `FAKE-INV-${externalInvoiceId.slice(-4)}`;
    invoice.updatedAt = this.now();
    await this.ledger.putInvoice(invoice);
  }

  async simulatePayment(
    externalInvoiceId: string,
    amountCents: number,
    paidOn: string,
  ): Promise<PaymentRecord> {
    const invoice = await this.requireInvoiceById(externalInvoiceId);
    if (invoice.status !== 'authorised')
      throw new ConflictError('Only authorised invoices take payments.', 'state', this.provider);
    invoice.amountPaidCents += amountCents;
    invoice.amountDueCents = invoice.totalCents - invoice.amountPaidCents;
    if (invoice.amountDueCents <= 0) invoice.status = 'paid';
    invoice.updatedAt = this.now();
    const payment: PaymentRecord = {
      externalPaymentId: await this.ledger.nextId('payment'),
      externalInvoiceId,
      amountCents,
      paidOn,
      status: 'active',
      updatedAt: this.now(),
    };
    await this.ledger.putInvoice(invoice);
    await this.ledger.addPayment({ ...payment, tenantId: invoice.tenantId });
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
    const tenantId = context.tenantId;
    return this.idempotent(tenantId, 'contact', options.idempotencyKey, input, async () => {
      const duplicate = (await this.ledger.listContacts(tenantId)).find(
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
        ? await this.ledger.getContact(tenantId, input.externalContactId)
        : (await this.ledger.listContacts(tenantId)).find(
            (contact) => contact.customerId === input.customerId,
          );
      if (input.externalContactId && !existing)
        throw new PermanentError('Contact not found.', 'not_found', this.provider);
      const contact: FakeContact = {
        id: existing?.id ?? (await this.ledger.nextId('contact')),
        customerId: input.customerId,
        name: input.name.trim(),
        email: input.email ?? null,
        phone: input.phone ?? null,
      };
      await this.ledger.putContact(tenantId, contact);
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
    const tenantId = context.tenantId;
    return this.idempotent(tenantId, 'invoice', options.idempotencyKey, input, async () => {
      if (!(await this.ledger.getContact(tenantId, input.externalContactId)))
        throw new ValidationError('Contact does not exist.', 'contact', this.provider, [
          'externalContactId does not match a contact.',
        ]);
      const totals = mockLineTotals(input.lines, input.lineAmountMode);
      const invoice: FakeInvoice = {
        tenantId,
        externalInvoiceId: await this.ledger.nextId('invoice'),
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
      await this.ledger.putInvoice(invoice);
      return snapshot(invoice);
    });
  }

  async getInvoice(context: AccountingContext, externalInvoiceId: string) {
    await this.guard(context.tenantId);
    return snapshot(await this.requireInvoice(context.tenantId, externalInvoiceId));
  }

  async listInvoiceChangesSince(context: AccountingContext, since: Date) {
    await this.guard(context.tenantId);
    return (await this.ledger.listInvoices(context.tenantId))
      .filter((invoice) => invoice.updatedAt.getTime() >= since.getTime())
      .map(snapshot);
  }

  async listPaymentsSince(context: AccountingContext, since: Date) {
    await this.guard(context.tenantId);
    return (await this.ledger.listPayments(context.tenantId))
      .filter((payment) => payment.updatedAt.getTime() >= since.getTime())
      .map(({ tenantId: _tenant, ...payment }) => ({ ...payment }));
  }

  async voidDraftInvoice(
    context: AccountingContext,
    externalInvoiceId: string,
    options: WriteOptions,
  ) {
    assertWriteOptions(options, this.provider);
    await this.guard(context.tenantId);
    const tenantId = context.tenantId;
    return this.idempotent(
      tenantId,
      'void',
      options.idempotencyKey,
      { externalInvoiceId },
      async () => {
        const invoice = await this.requireInvoice(tenantId, externalInvoiceId);
        if (invoice.status !== 'draft' && invoice.status !== 'submitted')
          throw new ConflictError(
            'Only draft invoices can be withdrawn.',
            'not_draft',
            this.provider,
          );
        invoice.status = 'deleted';
        invoice.updatedAt = this.now();
        await this.ledger.putInvoice(invoice);
        return snapshot(invoice);
      },
    );
  }

  // ---- internals ----

  private issueTokens(): OAuthTokenSet {
    return {
      accessToken: `fake-access-${nonce()}`,
      refreshToken: `fake-refresh-${nonce()}`,
      expiresAt: new Date(this.now().getTime() + 30 * 60_000),
      scopes: ['fake.accounting'],
    };
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

  private async requireInvoice(tenantId: string, id: string): Promise<FakeInvoice> {
    const invoice = await this.ledger.getInvoice(tenantId, id);
    if (!invoice) throw new PermanentError('Invoice not found.', 'not_found', this.provider);
    return invoice;
  }

  private async requireInvoiceById(id: string): Promise<FakeInvoice> {
    const invoice = await this.ledger.findInvoice(id);
    if (!invoice) throw new PermanentError('Invoice not found.', 'not_found', this.provider);
    return invoice;
  }

  private idempotent<T>(
    tenantId: string,
    operation: string,
    key: string,
    payload: unknown,
    run: () => Promise<T>,
  ): Promise<T> {
    const scoped = `${operation}:${key}`;
    const fingerprint = JSON.stringify(payload);
    return this.ledger.withLock(tenantId, scoped, async () => {
      const previous = await this.ledger.getIdempotency(tenantId, scoped);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ConflictError(
            'Idempotency key reused with a different request.',
            'idempotency_key_reuse',
            this.provider,
          );
        return reviveDates(structuredClone(previous.result)) as T;
      }
      const result = await run();
      await this.ledger.putIdempotency(tenantId, scoped, {
        fingerprint,
        result: structuredClone(result),
      });
      return result;
    });
  }
}

function nonce(): string {
  return randomBytes(6).toString('hex');
}

/** JSON-backed ledgers return dates as strings. */
function reviveDates(value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { updatedAt?: unknown }).updatedAt === 'string'
  )
    (value as { updatedAt: unknown }).updatedAt = new Date(
      (value as { updatedAt: string }).updatedAt,
    );
  return value;
}

function snapshot(
  invoice: InvoiceSnapshot & { lines?: number; tenantId?: string },
): InvoiceSnapshot {
  const { lines: _lines, tenantId: _tenant, ...rest } = invoice;
  return { ...rest, updatedAt: new Date(rest.updatedAt) };
}
