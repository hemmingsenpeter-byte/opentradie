import type { Database } from '@opentradie/database';
import {
  createKeyring,
  EncryptedTokenStore,
  ReauthorisationRequiredError,
  storedAccessToken,
  type ConnectionProvider,
  type CredentialKeyring,
  type FormFetch,
  type OAuthCodeClient,
} from '@opentradie/integrations';
import {
  createGmailOAuthClient,
  createMicrosoftMailOAuthClient,
  FakeMailAdapter,
  GmailMailAdapter,
  MicrosoftGraphMailAdapter,
  type MailConnections,
  type MailFetch,
  type MailProvider,
} from '@opentradie/integrations/mail';
import type { RuntimeConfig } from '../config.js';
import { PostgresConnectionStore } from '../accounting/stores.js';

/** URL segment of the mail routes: /api/integrations/mail/:provider/... */
export type MailRouteProvider = 'gmail' | 'microsoft_graph' | 'fake';

/**
 * Everything the mail routes and the inbox.send handler need for the configured mailbox
 * provider. Tokens live sealed in provider_connections (credential envelope, AAD bound to
 * tenant + provider), exactly like the accounting connection.
 */
export interface MailRuntime {
  routeProvider: MailRouteProvider;
  /** provider_connections.provider / oauth_authorisations.provider. */
  provider: ConnectionProvider;
  /** "mock" is FakeMailAdapter: never evidence of a real integration. */
  kind: 'provider' | 'mock';
  label: string;
  keyring: CredentialKeyring;
  connections: PostgresConnectionStore;
  tokens: EncryptedTokenStore;
  /** Null for the fake provider, which has no consent screen. */
  oauth: OAuthCodeClient | null;
  redirectUri: string;
  /** The in-memory mock mailbox when MAIL_PROVIDER=fake. */
  fake: FakeMailAdapter | null;
  /** Resolves a MailProvider from the stored connection (used by inbox.send). */
  mail: MailConnections;
}

export interface MailRuntimeOverrides {
  /** Token endpoint HTTP (tests). */
  tokenFetch?: FormFetch;
  /** Mail API HTTP (tests). */
  mailFetch?: MailFetch;
  fake?: FakeMailAdapter;
  now?: () => Date;
}

/** Returns null when MAIL_PROVIDER=none. Configuration validation already ran. */
export function createMailRuntime(
  config: RuntimeConfig,
  db: Database,
  overrides: MailRuntimeOverrides = {},
): MailRuntime | null {
  const mail = config.mail;
  if (mail.provider === 'none') return null;
  if (!config.credentialKeys)
    throw new Error('Mail needs CREDENTIAL_ENCRYPTION_KEY to store mailbox tokens.');
  const keyring = createKeyring(config.credentialKeys.activeKeyId, config.credentialKeys.keys);
  const connections = new PostgresConnectionStore(db);
  const now = overrides.now;
  const tokens = new EncryptedTokenStore(connections, keyring, now ? { now } : {});
  const common = {
    keyring,
    connections,
    tokens,
    redirectUri:
      mail.provider === 'fake'
        ? `${config.appOrigin}/api/integrations/mail/fake/callback`
        : mail.redirectUri,
  };
  const http = {
    ...(overrides.tokenFetch ? { fetch: overrides.tokenFetch } : {}),
    ...(now ? { now } : {}),
  };
  const oauth =
    mail.provider === 'gmail'
      ? createGmailOAuthClient({
          clientId: mail.clientId,
          clientSecret: mail.clientSecret,
          ...http,
        })
      : mail.provider === 'microsoft_graph'
        ? createMicrosoftMailOAuthClient({
            clientId: mail.clientId,
            clientSecret: mail.clientSecret,
            tenant: mail.tenant,
            ...http,
          })
        : null;
  const fake = mail.provider === 'fake' ? (overrides.fake ?? new FakeMailAdapter()) : null;
  const provider: ConnectionProvider = mail.provider === 'fake' ? 'fake_mail' : mail.provider;

  const resolver: MailConnections = {
    async forTenant(tenantId: string): Promise<MailProvider | null> {
      const row = await connections.get(tenantId, provider);
      if (!row || row.status === 'disconnected') return null;
      if (row.status === 'error')
        throw new ReauthorisationRequiredError(
          'The mailbox connection must be authorised again.',
          'reauthorisation_required',
          provider,
        );
      if (fake) return fake;
      const accessToken = storedAccessToken({
        tokens,
        tenantId,
        provider,
        refresh: (refreshToken) => oauth!.refresh(refreshToken),
        ...(now ? { now } : {}),
      });
      const options = {
        accessToken,
        ...(overrides.mailFetch ? { fetch: overrides.mailFetch } : {}),
      };
      return mail.provider === 'gmail'
        ? new GmailMailAdapter(options)
        : new MicrosoftGraphMailAdapter(options);
    },
  };

  return {
    ...common,
    routeProvider: mail.provider,
    provider,
    kind: fake ? 'mock' : 'provider',
    label:
      mail.provider === 'fake'
        ? 'Fake mailbox (mock, not a real integration)'
        : mail.provider === 'gmail'
          ? 'Gmail'
          : 'Microsoft 365',
    oauth,
    fake,
    mail: resolver,
  };
}
