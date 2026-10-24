import {
  PermanentError,
  RateLimitedError,
  ReauthorisationRequiredError,
  TransientError,
  ValidationError,
} from '../errors.js';
import { createOAuthState, createPkcePair, type OAuthTokenSet } from '../accounting/oauth.js';

/** Injectable form POST used for token requests (global fetch by default; fakes in tests). */
export type FormFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface OAuthCodeClientConfig {
  /** Provider id used in errors (`xero`, `gmail`, `microsoft_graph`). */
  provider: string;
  /** Human name used in error messages ("reconnect Xero"). */
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  /** Send PKCE (S256). Default true. */
  pkce?: boolean;
  /** How the client authenticates at the token endpoint. Default `basic` (RFC 6749 §2.3.1). */
  clientAuth?: 'basic' | 'body';
  /** Extra authorize-URL parameters (Google: access_type=offline, prompt=consent). */
  authorizeParams?: Record<string, string>;
  /** Send `scope` with refresh requests (Microsoft identity platform). */
  scopeOnRefresh?: boolean;
  fetch?: FormFetch;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * OAuth 2.0 authorization-code client (RFC 6749 + RFC 7636 PKCE) shared by every provider
 * OPENTRADIE connects to. Tokens, codes and provider bodies are never logged; only the RFC 6749
 * §5.2 error code is inspected.
 */
export class OAuthCodeClient {
  readonly scopes: readonly string[];
  readonly pkce: boolean;
  constructor(protected readonly config: OAuthCodeClientConfig) {
    if (!config.clientId || !config.clientSecret)
      throw new Error(`${config.label} client id and secret are required.`);
    this.scopes = config.scopes;
    this.pkce = config.pkce ?? true;
  }

  authorizationUrl(redirectUri: string): {
    url: string;
    state: string;
    codeVerifier: string | null;
  } {
    const state = createOAuthState();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      scope: this.scopes.join(' '),
      state,
      ...this.config.authorizeParams,
    });
    let codeVerifier: string | null = null;
    if (this.pkce) {
      const pair = createPkcePair();
      codeVerifier = pair.codeVerifier;
      params.set('code_challenge', pair.codeChallenge);
      params.set('code_challenge_method', 'S256');
    }
    return { url: `${this.config.authorizeUrl}?${params.toString()}`, state, codeVerifier };
  }

  async exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string | null;
  }): Promise<OAuthTokenSet> {
    const form: Record<string, string> = {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
    };
    if (input.codeVerifier) form.code_verifier = input.codeVerifier;
    return this.tokenRequest(form, 'exchange', null);
  }

  async refresh(refreshToken: string): Promise<OAuthTokenSet> {
    const form: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    };
    if (this.config.scopeOnRefresh) form.scope = this.scopes.join(' ');
    return this.tokenRequest(form, 'refresh', refreshToken);
  }

  private async tokenRequest(
    form: Record<string, string>,
    purpose: 'exchange' | 'refresh',
    previousRefreshToken: string | null,
  ): Promise<OAuthTokenSet> {
    const { provider, label, clientId, clientSecret } = this.config;
    const doFetch = this.config.fetch ?? (globalThis.fetch as unknown as FormFetch);
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if ((this.config.clientAuth ?? 'basic') === 'basic')
      headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
    else Object.assign(form, { client_id: clientId, client_secret: clientSecret });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);
    let response: Awaited<ReturnType<FormFetch>>;
    try {
      response = await doFetch(this.config.tokenUrl, {
        method: 'POST',
        headers,
        body: new URLSearchParams(form).toString(),
        signal: controller.signal,
      });
    } catch {
      throw new TransientError(
        `${label} identity service could not be reached.`,
        'network',
        provider,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      if (response.status === 429) {
        const retry = Number(response.headers.get('retry-after'));
        throw new RateLimitedError(
          `${label} identity rate limit reached.`,
          'rate_limit',
          provider,
          Number.isFinite(retry) && retry >= 0 ? retry : 60,
        );
      }
      if (response.status >= 500)
        throw new TransientError(
          `${label} identity returned HTTP ${response.status}.`,
          `http_${response.status}`,
          provider,
        );
      // The OAuth error code is a fixed vocabulary (RFC 6749 §5.2), safe to inspect; nothing else is read.
      const errorCode = await response
        .json()
        .then((body) =>
          body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined,
        )
        .catch(() => undefined);
      if (errorCode === 'invalid_grant') {
        if (purpose === 'refresh')
          throw new ReauthorisationRequiredError(
            `The ${label} connection has expired or was revoked; reconnect ${label}.`,
            'invalid_grant',
            provider,
          );
        throw new ValidationError(
          `${label} rejected the authorisation code.`,
          'invalid_grant',
          provider,
        );
      }
      throw new PermanentError(
        `${label} identity rejected the token request (HTTP ${response.status}).`,
        typeof errorCode === 'string' ? errorCode.slice(0, 40) : `http_${response.status}`,
        provider,
      );
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const accessToken = body?.access_token;
    const expiresIn = body?.expires_in;
    if (
      typeof accessToken !== 'string' ||
      typeof expiresIn !== 'number' ||
      !Number.isFinite(expiresIn)
    )
      throw new PermanentError(
        `${label} identity returned a malformed token response.`,
        'malformed_token',
        provider,
      );
    const now = (this.config.now ?? (() => new Date()))();
    return {
      accessToken,
      // Google does not rotate refresh tokens: keep the one we refreshed with.
      refreshToken:
        typeof body?.refresh_token === 'string' ? body.refresh_token : previousRefreshToken,
      expiresAt: new Date(now.getTime() + expiresIn * 1000),
      scopes:
        typeof body?.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [...this.scopes],
    };
  }
}
