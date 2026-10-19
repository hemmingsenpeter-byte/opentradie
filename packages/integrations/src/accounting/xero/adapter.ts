import {
  ConflictError,
  PermanentError,
  ReauthorisationRequiredError,
  ValidationError,
} from '../../errors.js';
import type { TokenStore } from '../../credentials/stores.js';
import { SingleFlight, tokenNeedsRefresh, type OAuthTokenSet } from '../oauth.js';
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
} from '../types.js';
import { assertWriteOptions, validateContact, validateDraftInvoice } from '../validation.js';
import { mapXeroError } from './errors.js';
import {
  buildXeroContact,
  buildXeroInvoice,
  toInvoiceSnapshot,
  toPaymentRecord,
  toTaxRate,
  type XeroTaxTypeMap,
} from './mapping.js';
import type { XeroOAuthClient } from './oauth-client.js';
import { createXeroSdkClient, type XeroSdkClient } from './sdk.js';

export interface XeroAccountingAdapterOptions {
  oauth: XeroOAuthClient;
  tokens: TokenStore;
  /** Owner-confirmed mapping from our tax codes to this organisation's Xero tax types. */
  taxTypes: XeroTaxTypeMap;
  /** Injected in tests; production uses the official xero-node SDK. */
  sdkFactory?: () => XeroSdkClient;
  now?: () => Date;
  pageSize?: number;
}

const MAX_PAGES = 100;
const ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Xero implementation of the accounting contract, built on the official xero-node SDK.
 * Implemented, not integration-tested: verified against a fake SDK and against the real SDK's
 * serialisation with a local HTTP server, never against Xero itself.
 */
export class XeroAccountingAdapter implements AccountingAdapter {
  readonly provider = 'xero' as const;
  readonly kind = 'provider' as const;
  readonly capabilities: { pkce: boolean };
  private readonly sdkFactory: () => XeroSdkClient;
  private readonly now: () => Date;
  private readonly pageSize: number;
  private readonly refreshes = new SingleFlight<OAuthTokenSet>();

  constructor(private readonly options: XeroAccountingAdapterOptions) {
    this.sdkFactory = options.sdkFactory ?? (() => createXeroSdkClient());
    this.now = options.now ?? (() => new Date());
    this.pageSize = options.pageSize ?? 100;
    this.capabilities = { pkce: options.oauth.pkce };
  }

  async beginAuthorisation(input: BeginAuthorisationInput) {
    return this.options.oauth.authorizationUrl(input.redirectUri);
  }

  async completeAuthorisation(input: CompleteAuthorisationInput) {
    const tokens = await this.options.oauth.exchangeCode(input);
    await this.options.tokens.save(input.tenantId, this.provider, tokens);
    return { scopes: tokens.scopes, expiresAt: tokens.expiresAt };
  }

  async refreshTokens(tenantId: string) {
    const current = await this.loadTokens(tenantId);
    const tokens = await this.refresh(tenantId, current);
    return { scopes: tokens.scopes, expiresAt: tokens.expiresAt };
  }

  async listOrganisations(tenantId: string) {
    return this.call(tenantId, async (sdk) => {
      const connections = await sdk.updateTenants(false);
      return connections
        .filter((connection) => !connection.tenantType || connection.tenantType === 'ORGANISATION')
        .map((connection) => ({
          organisationId: connection.tenantId,
          name: connection.tenantName ?? connection.tenantId,
        }));
    });
  }

  async listTaxRates(context: AccountingContext) {
    return this.call(context.tenantId, async (sdk) => {
      const { body } = await sdk.accountingApi.getTaxRates(context.organisationId);
      return (body.taxRates ?? []).flatMap((rate) => toTaxRate(rate) ?? []);
    });
  }

  async upsertContact(context: AccountingContext, input: ContactInput, options: WriteOptions) {
    assertWriteOptions(options, this.provider);
    validateContact(input, this.provider);
    const payload = buildXeroContact(input);
    return this.call(context.tenantId, async (sdk) => {
      const { body } = await sdk.accountingApi.updateOrCreateContacts(
        context.organisationId,
        { contacts: [payload] },
        true,
        options.idempotencyKey,
      );
      const contactID = body.contacts?.[0]?.contactID;
      if (!contactID)
        throw new PermanentError(
          'Xero returned no contact id.',
          'malformed_response',
          this.provider,
        );
      return { externalContactId: contactID };
    });
  }

  async createDraftInvoice(
    context: AccountingContext,
    input: DraftInvoiceInput,
    options: WriteOptions,
  ) {
    assertWriteOptions(options, this.provider);
    validateDraftInvoice(input, this.provider);
    const payload = buildXeroInvoice(input, this.options.taxTypes);
    return this.call(context.tenantId, async (sdk) => {
      const { body } = await sdk.accountingApi.createInvoices(
        context.organisationId,
        { invoices: [payload] },
        true,
        undefined,
        options.idempotencyKey,
      );
      return toInvoiceSnapshot(body.invoices?.[0]);
    });
  }

  async getInvoice(context: AccountingContext, externalInvoiceId: string) {
    this.assertId(externalInvoiceId);
    return this.call(context.tenantId, async (sdk) => {
      const { body } = await sdk.accountingApi.getInvoice(
        context.organisationId,
        externalInvoiceId,
      );
      return toInvoiceSnapshot(body.invoices?.[0]);
    });
  }

  async listInvoiceChangesSince(context: AccountingContext, since: Date) {
    return this.call(context.tenantId, async (sdk) => {
      const all: InvoiceSnapshot[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const { body } = await sdk.accountingApi.getInvoices(
          context.organisationId,
          since,
          'Type=="ACCREC"',
          'UpdatedDateUTC ASC',
          undefined,
          undefined,
          undefined,
          undefined,
          page,
          undefined,
          undefined,
          undefined,
          undefined,
          this.pageSize,
        );
        const invoices = body.invoices ?? [];
        all.push(...invoices.map(toInvoiceSnapshot));
        if (invoices.length < this.pageSize) return all;
      }
      throw new PermanentError(
        'Too many changed invoices to page through.',
        'too_many_pages',
        this.provider,
      );
    });
  }

  async listPaymentsSince(context: AccountingContext, since: Date) {
    return this.call(context.tenantId, async (sdk) => {
      const all: PaymentRecord[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const { body } = await sdk.accountingApi.getPayments(
          context.organisationId,
          since,
          undefined,
          'UpdatedDateUTC ASC',
          page,
          this.pageSize,
        );
        const payments = body.payments ?? [];
        all.push(...payments.flatMap((payment) => toPaymentRecord(payment) ?? []));
        if (payments.length < this.pageSize) return all;
      }
      throw new PermanentError(
        'Too many changed payments to page through.',
        'too_many_pages',
        this.provider,
      );
    });
  }

  async voidDraftInvoice(
    context: AccountingContext,
    externalInvoiceId: string,
    options: WriteOptions,
  ) {
    assertWriteOptions(options, this.provider);
    this.assertId(externalInvoiceId);
    return this.call(context.tenantId, async (sdk) => {
      const current = toInvoiceSnapshot(
        (await sdk.accountingApi.getInvoice(context.organisationId, externalInvoiceId)).body
          .invoices?.[0],
      );
      if (current.status === 'deleted') return current;
      if (current.status !== 'draft' && current.status !== 'submitted')
        throw new ConflictError(
          'Only draft invoices can be withdrawn from OPENTRADIE; void posted invoices in Xero.',
          'not_draft',
          this.provider,
        );
      const { body } = await sdk.accountingApi.updateInvoice(
        context.organisationId,
        externalInvoiceId,
        { invoices: [{ status: 'DELETED' }] },
        undefined,
        options.idempotencyKey,
      );
      return toInvoiceSnapshot(body.invoices?.[0]);
    });
  }

  // ---- token handling ----

  private assertId(id: string): void {
    if (!ID.test(id)) throw new ValidationError('Invalid Xero id.', 'external_id', this.provider);
  }

  private async loadTokens(tenantId: string): Promise<OAuthTokenSet> {
    const tokens = await this.options.tokens.load(tenantId, this.provider);
    if (!tokens)
      throw new ReauthorisationRequiredError(
        'Xero is not connected.',
        'not_connected',
        this.provider,
      );
    return tokens;
  }

  private refresh(tenantId: string, current: OAuthTokenSet): Promise<OAuthTokenSet> {
    return this.refreshes.run(tenantId, async () => {
      if (!current.refreshToken) {
        await this.options.tokens.markReauthorisationRequired(tenantId, this.provider);
        throw new ReauthorisationRequiredError(
          'Xero connection has no refresh token; reconnect Xero.',
          'no_refresh_token',
          this.provider,
        );
      }
      try {
        const next = await this.options.oauth.refresh(current.refreshToken);
        await this.options.tokens.save(tenantId, this.provider, next);
        return next;
      } catch (error) {
        if (error instanceof ReauthorisationRequiredError)
          await this.options.tokens.markReauthorisationRequired(tenantId, this.provider);
        throw error;
      }
    });
  }

  private async call<T>(tenantId: string, run: (sdk: XeroSdkClient) => Promise<T>): Promise<T> {
    let tokens = await this.loadTokens(tenantId);
    if (tokenNeedsRefresh(tokens, this.now())) tokens = await this.refresh(tenantId, tokens);
    const sdk = this.sdkFactory();
    sdk.setTokenSet({
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_at: Math.floor(tokens.expiresAt.getTime() / 1000),
    });
    try {
      return await run(sdk);
    } catch (error) {
      throw mapXeroError(error);
    }
  }
}
