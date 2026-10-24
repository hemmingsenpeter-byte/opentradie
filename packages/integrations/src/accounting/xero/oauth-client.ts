import { OAuthCodeClient, type FormFetch } from '../../oauth/code-client.js';

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

export type { FormFetch } from '../../oauth/code-client.js';

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
export class XeroOAuthClient extends OAuthCodeClient {
  constructor(config: XeroOAuthConfig) {
    super({
      ...config,
      provider: 'xero',
      label: 'Xero',
      authorizeUrl: XERO_AUTHORIZE_URL,
      tokenUrl: XERO_TOKEN_URL,
      scopes: config.scopes ?? XERO_GRANULAR_SCOPES,
      clientAuth: 'basic',
    });
  }
}
