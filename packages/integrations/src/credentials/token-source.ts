import { ReauthorisationRequiredError } from '../errors.js';
import { tokenNeedsRefresh, type OAuthTokenSet } from '../accounting/oauth.js';
import type { ConnectionProvider, TokenStore } from './stores.js';

/**
 * Returns a function that yields a current access token for one stored connection, refreshing it
 * when it is (nearly) expired. The refresh runs under the store's exclusive lock when it has one
 * (PostgreSQL: SELECT ... FOR UPDATE), so a single-use refresh token is never spent twice. A
 * revoked or expired grant marks the connection `error / reauthorisation_required` and throws
 * ReauthorisationRequiredError; nothing is retried.
 */
export function storedAccessToken(options: {
  tokens: TokenStore;
  tenantId: string;
  provider: ConnectionProvider;
  refresh: (refreshToken: string) => Promise<OAuthTokenSet>;
  now?: () => Date;
}): () => Promise<string> {
  const { tokens, tenantId, provider } = options;
  const now = options.now ?? (() => new Date());
  const reauth = async (): Promise<never> => {
    await tokens.markReauthorisationRequired(tenantId, provider);
    throw new ReauthorisationRequiredError(
      'The connection must be authorised again.',
      'reauthorisation_required',
      provider,
    );
  };
  return async () => {
    const current = await tokens.load(tenantId, provider);
    if (!current)
      throw new ReauthorisationRequiredError(
        'No stored tokens for this connection.',
        'no_tokens',
        provider,
      );
    if (!tokenNeedsRefresh(current, now())) return current.accessToken;
    const run = async (latest: OAuthTokenSet) => {
      if (!latest.refreshToken)
        throw new ReauthorisationRequiredError(
          'The connection has no refresh token.',
          'no_refresh_token',
          provider,
        );
      return options.refresh(latest.refreshToken);
    };
    try {
      const next = tokens.refreshExclusive
        ? await tokens.refreshExclusive(tenantId, provider, current, run)
        : await run(current).then(async (fresh) => {
            await tokens.save(tenantId, provider, fresh);
            return fresh;
          });
      if (!next) return reauth();
      return next.accessToken;
    } catch (error) {
      if (error instanceof ReauthorisationRequiredError) return reauth();
      throw error;
    }
  };
}
