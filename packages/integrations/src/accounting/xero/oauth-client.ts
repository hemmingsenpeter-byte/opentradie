import {
  PermanentError,
  RateLimitedError,
  ReauthorisationRequiredError,
  TransientError,
  ValidationError,
} from '../../errors.js';
import { createOAuthState, createPkcePair, type OAuthTokenSet } from '../oauth.js';

export const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
export const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';

/**
 * Granular scopes Xero requires for apps created on or after 2 March 2026 (Xero developer blog,
 * "Upcoming changes to Xero Accounting API scopes"). Verify against Xero's scopes page before
 * go-live; the exact names are not integration-tested.
 */
export const XERO_GRANULAR_SCOPES = [
  'offline_access',
  'accounting.contacts',
  'accounting.invoices',
  'accounting.payments.read',
  'accounting.settings.read',
] as const;

/** Broad scopes that apps created before 2 March 2026 may use until Xero retires them (announced: September 2027). */
export const XERO_LEGACY_SCOPES = [
  'offline_access',
  'accounting.transactions',
  'accounting.contacts',
  'accounting.settings.read',
] as const;

export type FormFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface XeroOAuthConfig {
  clientId: string;
  clientSecret: string;
  scopes?: readonly string[];
  /** Send PKCE (S256). Default true. Unverified whether Xero's web-app flow requires it. */
  pkce?: boolean;
  fetch?: FormFetch;
  timeoutMs?: number;
  now?: () => Date;
}

/** OAuth 2.0 authorization-code client for Xero's identity server. Tokens are never logged. */
export class XeroOAuthClient {
  readonly scopes: readonly string[];
  readonly pkce: boolean;
  constructor(private readonly config: XeroOAuthConfig) {
    if (!config.clientId || !config.clientSecret)
      throw new Error('Xero client id and secret are required.');
    this.scopes = config.scopes ?? XERO_GRANULAR_SCOPES;
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
    });
    let codeVerifier: string | null = null;
    if (this.pkce) {
      const pair = createPkcePair();
      codeVerifier = pair.codeVerifier;
      params.set('code_challenge', pair.codeChallenge);
      params.set('code_challenge_method', 'S256');
    }
    return { url: `${XERO_AUTHORIZE_URL}?${params.toString()}`, state, codeVerifier };
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
    return this.tokenRequest(form, 'exchange');
  }

  async refresh(refreshToken: string): Promise<OAuthTokenSet> {
    return this.tokenRequest(
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      'refresh',
    );
  }

  private async tokenRequest(
    form: Record<string, string>,
    purpose: 'exchange' | 'refresh',
  ): Promise<OAuthTokenSet> {
    const doFetch = this.config.fetch ?? (globalThis.fetch as unknown as FormFetch);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);
    let response: Awaited<ReturnType<FormFetch>>;
    try {
      response = await doFetch(XERO_TOKEN_URL, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams(form).toString(),
        signal: controller.signal,
      });
    } catch {
      throw new TransientError('Xero identity service could not be reached.', 'network', 'xero');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      if (response.status === 429) {
        const retry = Number(response.headers.get('retry-after'));
        throw new RateLimitedError(
          'Xero identity rate limit reached.',
          'rate_limit',
          'xero',
          Number.isFinite(retry) && retry >= 0 ? retry : 60,
        );
      }
      if (response.status >= 500)
        throw new TransientError(
          `Xero identity returned HTTP ${response.status}.`,
          `http_${response.status}`,
          'xero',
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
            'The Xero connection has expired or was revoked; reconnect Xero.',
            'invalid_grant',
            'xero',
          );
        throw new ValidationError('Xero rejected the authorisation code.', 'invalid_grant', 'xero');
      }
      throw new PermanentError(
        `Xero identity rejected the token request (HTTP ${response.status}).`,
        typeof errorCode === 'string' ? errorCode.slice(0, 40) : `http_${response.status}`,
        'xero',
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
        'Xero identity returned a malformed token response.',
        'malformed_token',
        'xero',
      );
    const now = (this.config.now ?? (() => new Date()))();
    return {
      accessToken,
      refreshToken: typeof body?.refresh_token === 'string' ? body.refresh_token : null,
      expiresAt: new Date(now.getTime() + expiresIn * 1000),
      scopes:
        typeof body?.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [...this.scopes],
    };
  }
}
