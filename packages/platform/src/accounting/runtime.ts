import type { Database } from '@opentradie/database';
import {
  createKeyring,
  EncryptedTokenStore,
  FakeAccountingAdapter,
  XERO_TAX_PRESETS,
  XeroAccountingAdapter,
  XeroOAuthClient,
  type AccountingAdapter,
  type ConnectionProvider,
  type CredentialKeyring,
  type ExternalReferenceStore,
} from '@opentradie/integrations';
import type { RuntimeConfig } from '../config.js';
import { PostgresConnectionStore, PostgresExternalReferenceStore } from './stores.js';

/**
 * Everything the API routes and worker handlers need to talk to the configured accounting
 * provider. One instance per process: the fake adapter keeps its (mock) ledger in memory, so the
 * API and the in-process worker must share it.
 */
export interface AccountingRuntime {
  adapter: AccountingAdapter;
  provider: ConnectionProvider;
  /** "mock" is the fake adapter: never evidence of a real integration. */
  kind: 'provider' | 'mock';
  label: string;
  keyring: CredentialKeyring;
  connections: PostgresConnectionStore;
  tokens: EncryptedTokenStore;
  references: ExternalReferenceStore;
  /** OAuth redirect URI registered with the provider. */
  redirectUri: string;
}

export interface AccountingRuntimeOverrides {
  /** Build a different adapter over the encrypted PostgreSQL token store (tests). */
  adapter?: (tokens: EncryptedTokenStore) => AccountingAdapter;
  references?: ExternalReferenceStore;
  now?: () => Date;
}

/** Returns null when ACCOUNTING_PROVIDER=none. Configuration validation already ran. */
export function createAccountingRuntime(
  config: RuntimeConfig,
  db: Database,
  overrides: AccountingRuntimeOverrides = {},
): AccountingRuntime | null {
  if (config.accounting.provider === 'none') return null;
  if (!config.credentialKeys)
    throw new Error('Accounting needs CREDENTIAL_ENCRYPTION_KEY to store provider tokens.');
  const keyring = createKeyring(config.credentialKeys.activeKeyId, config.credentialKeys.keys);
  const connections = new PostgresConnectionStore(db);
  const tokens = new EncryptedTokenStore(connections, keyring, {
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  const references = overrides.references ?? new PostgresExternalReferenceStore(db.pool);
  const now = overrides.now;
  if (config.accounting.provider === 'fake') {
    const adapter =
      overrides.adapter?.(tokens) ?? new FakeAccountingAdapter({ tokens, ...(now ? { now } : {}) });
    return {
      adapter,
      provider: adapter.provider,
      kind: adapter.kind,
      label: 'Fake accounting (mock, not a real integration)',
      keyring,
      connections,
      tokens,
      references,
      redirectUri: `${config.appOrigin}/api/integrations/xero/callback`,
    };
  }
  const xero = config.accounting;
  const adapter =
    overrides.adapter?.(tokens) ??
    new XeroAccountingAdapter({
      oauth: new XeroOAuthClient({
        clientId: xero.clientId,
        clientSecret: xero.clientSecret,
        pkce: xero.pkce,
        ...(now ? { now } : {}),
      }),
      tokens,
      taxTypes: XERO_TAX_PRESETS[xero.taxPreset],
      ...(now ? { now } : {}),
    });
  return {
    adapter,
    provider: adapter.provider,
    kind: adapter.kind,
    label: 'Xero',
    keyring,
    connections,
    tokens,
    references,
    redirectUri: xero.redirectUri,
  };
}
