import {
  needsReencryption,
  openCredentials,
  sealCredentials,
  type CredentialKeyring,
} from './envelope.js';
import { tokenNeedsRefresh, type OAuthTokenSet } from '../accounting/oauth.js';

/** Providers allowed by the provider_connections.provider CHECK constraint (migration 0001). */
export type ConnectionProvider =
  'xero' | 'gmail' | 'microsoft_graph' | 'whatsapp_business' | 'test' | 'fake_mail';

/** One provider_connections row. Persistence is wired by the database package; tests use memory. */
export interface ProviderConnectionRecord {
  id: string;
  tenantId: string;
  provider: ConnectionProvider;
  status: 'disconnected' | 'connected' | 'error';
  encryptedCredentials: Buffer | null;
  encryptionKeyId: string | null;
  externalAccountId: string | null;
  updatedAt: Date;
}

/**
 * Repository over provider_connections. Every method is tenant-scoped. A Postgres implementation
 * must read with SELECT ... FOR UPDATE when refreshing tokens so two workers cannot both spend
 * the same single-use refresh token.
 */
export interface ConnectionStore {
  get(tenantId: string, provider: ConnectionProvider): Promise<ProviderConnectionRecord | null>;
  upsert(record: ProviderConnectionRecord): Promise<void>;
  /**
   * Optional: run `work` while holding an exclusive lock on the connection row
   * (PostgreSQL: SELECT ... FOR UPDATE in one transaction). `work` receives a store bound to the
   * locking transaction and must do all its reads and writes through it.
   */
  withLock?<T>(
    tenantId: string,
    provider: ConnectionProvider,
    work: (locked: ConnectionStore) => Promise<T>,
  ): Promise<T>;
}

export class InMemoryConnectionStore implements ConnectionStore {
  private readonly rows = new Map<string, ProviderConnectionRecord>();
  async get(tenantId: string, provider: ConnectionProvider) {
    const row = this.rows.get(`${tenantId}:${provider}`);
    return row ? { ...row } : null;
  }
  async upsert(record: ProviderConnectionRecord) {
    if ((record.encryptedCredentials === null) !== (record.encryptionKeyId === null))
      throw new Error('encrypted_credentials and encryption_key_id must be set together.');
    this.rows.set(`${record.tenantId}:${record.provider}`, { ...record });
  }
}

/** Token persistence used by OAuth adapters. Implementations never log token values. */
export interface TokenStore {
  load(tenantId: string, provider: ConnectionProvider): Promise<OAuthTokenSet | null>;
  save(
    tenantId: string,
    provider: ConnectionProvider,
    tokens: OAuthTokenSet,
    meta?: { externalAccountId?: string | null },
  ): Promise<void>;
  /** Marks the connection unusable until the owner reconnects; tokens are discarded. */
  markReauthorisationRequired(tenantId: string, provider: ConnectionProvider): Promise<void>;
  /**
   * Optional: refresh under an exclusive lock. Implementations re-read the stored tokens while
   * holding the lock; when another process already rotated them (and they are still fresh) the
   * stored tokens are returned without calling `refresh`, so a single-use refresh token is never
   * spent twice. Returns null when the connection no longer holds tokens.
   */
  refreshExclusive?(
    tenantId: string,
    provider: ConnectionProvider,
    current: OAuthTokenSet,
    refresh: (latest: OAuthTokenSet) => Promise<OAuthTokenSet>,
  ): Promise<OAuthTokenSet | null>;
}

interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  scopes: string[];
}

/** TokenStore that seals tokens with the credential envelope before they reach a ConnectionStore. */
export class EncryptedTokenStore implements TokenStore {
  constructor(
    private readonly connections: ConnectionStore,
    private readonly keyring: CredentialKeyring,
    private readonly options: { newId?: () => string; now?: () => Date } = {},
  ) {}

  async load(tenantId: string, provider: ConnectionProvider): Promise<OAuthTokenSet | null> {
    const row = await this.connections.get(tenantId, provider);
    if (!row || row.status !== 'connected' || !row.encryptedCredentials || !row.encryptionKeyId)
      return null;
    const sealed = { keyId: row.encryptionKeyId, ciphertext: row.encryptedCredentials };
    const stored = JSON.parse(
      openCredentials(sealed, this.keyring, { tenantId, provider }),
    ) as StoredTokens;
    const tokens: OAuthTokenSet = {
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken,
      expiresAt: new Date(stored.expiresAt),
      scopes: stored.scopes,
    };
    // Lazy key rotation: rows sealed with a retired key are rewritten with the active key.
    if (needsReencryption(sealed, this.keyring)) await this.save(tenantId, provider, tokens);
    return tokens;
  }

  async save(
    tenantId: string,
    provider: ConnectionProvider,
    tokens: OAuthTokenSet,
    meta: { externalAccountId?: string | null } = {},
  ): Promise<void> {
    const existing = await this.connections.get(tenantId, provider);
    const payload: StoredTokens = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt.toISOString(),
      scopes: [...tokens.scopes],
    };
    const sealed = sealCredentials(JSON.stringify(payload), this.keyring, { tenantId, provider });
    await this.connections.upsert({
      id: existing?.id ?? (this.options.newId ?? (() => crypto.randomUUID()))(),
      tenantId,
      provider,
      status: 'connected',
      encryptedCredentials: sealed.ciphertext,
      encryptionKeyId: sealed.keyId,
      externalAccountId:
        meta.externalAccountId !== undefined
          ? meta.externalAccountId
          : (existing?.externalAccountId ?? null),
      updatedAt: (this.options.now ?? (() => new Date()))(),
    });
  }

  async refreshExclusive(
    tenantId: string,
    provider: ConnectionProvider,
    current: OAuthTokenSet,
    refresh: (latest: OAuthTokenSet) => Promise<OAuthTokenSet>,
  ): Promise<OAuthTokenSet | null> {
    const run = async (store: ConnectionStore) => {
      const locked = new EncryptedTokenStore(store, this.keyring, this.options);
      const latest = await locked.load(tenantId, provider);
      if (!latest) return null;
      const now = (this.options.now ?? (() => new Date()))();
      // Another process refreshed while we waited for the lock: use its tokens.
      if (latest.accessToken !== current.accessToken && !tokenNeedsRefresh(latest, now))
        return latest;
      const next = await refresh(latest);
      await locked.save(tenantId, provider, next);
      return next;
    };
    return this.connections.withLock
      ? this.connections.withLock(tenantId, provider, run)
      : run(this.connections);
  }

  async markReauthorisationRequired(tenantId: string, provider: ConnectionProvider) {
    const existing = await this.connections.get(tenantId, provider);
    if (!existing) return;
    await this.connections.upsert({
      ...existing,
      status: 'error',
      encryptedCredentials: null,
      encryptionKeyId: null,
      updatedAt: (this.options.now ?? (() => new Date()))(),
    });
  }
}

/** Plain in-memory TokenStore for tests and the demo fake. Not for production use. */
export class InMemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, OAuthTokenSet>();
  readonly reauthorisationRequired = new Set<string>();
  async load(tenantId: string, provider: ConnectionProvider) {
    const found = this.tokens.get(`${tenantId}:${provider}`);
    return found ? { ...found, scopes: [...found.scopes] } : null;
  }
  async save(tenantId: string, provider: ConnectionProvider, tokens: OAuthTokenSet) {
    this.tokens.set(`${tenantId}:${provider}`, { ...tokens, scopes: [...tokens.scopes] });
    this.reauthorisationRequired.delete(`${tenantId}:${provider}`);
  }
  async markReauthorisationRequired(tenantId: string, provider: ConnectionProvider) {
    this.tokens.delete(`${tenantId}:${provider}`);
    this.reauthorisationRequired.add(`${tenantId}:${provider}`);
  }
}

/** Maps our entity ids to provider ids (customer → contact, invoice → provider invoice). */
export type ExternalEntityType = 'contact' | 'invoice';

export interface ExternalReferenceStore {
  get(
    tenantId: string,
    provider: ConnectionProvider,
    entityType: ExternalEntityType,
    internalId: string,
  ): Promise<string | null>;
  put(
    tenantId: string,
    provider: ConnectionProvider,
    entityType: ExternalEntityType,
    internalId: string,
    externalId: string,
  ): Promise<void>;
}

export class InMemoryExternalReferenceStore implements ExternalReferenceStore {
  private readonly refs = new Map<string, string>();
  async get(tenantId: string, provider: string, entityType: string, internalId: string) {
    return this.refs.get(`${tenantId}:${provider}:${entityType}:${internalId}`) ?? null;
  }
  async put(
    tenantId: string,
    provider: string,
    entityType: string,
    internalId: string,
    externalId: string,
  ) {
    this.refs.set(`${tenantId}:${provider}:${entityType}:${internalId}`, externalId);
  }
}
