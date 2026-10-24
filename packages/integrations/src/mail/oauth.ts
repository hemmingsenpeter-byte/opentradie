import { OAuthCodeClient, type FormFetch } from '../oauth/code-client.js';
import { GMAIL_SCOPES } from './gmail.js';
import { GRAPH_MAIL_SCOPES } from './graph.js';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Microsoft identity platform v2.0 endpoints for a tenant (`common`, `organizations` or a GUID). */
export const microsoftAuthorizeUrl = (tenant: string) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`;
export const microsoftTokenUrl = (tenant: string) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;

interface MailOAuthOptions {
  clientId: string;
  clientSecret: string;
  fetch?: FormFetch;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * Google OAuth for Gmail (web-server flow with PKCE). `access_type=offline` asks for a refresh
 * token and `prompt=consent` makes Google issue one again on reconnect. Implemented, not
 * integration-tested against Google.
 */
export function createGmailOAuthClient(options: MailOAuthOptions): OAuthCodeClient {
  return new OAuthCodeClient({
    ...options,
    provider: 'gmail',
    label: 'Google',
    authorizeUrl: GOOGLE_AUTHORIZE_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    scopes: GMAIL_SCOPES,
    clientAuth: 'body',
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
  });
}

/**
 * Microsoft identity platform OAuth for Graph mail (delegated permissions, PKCE). Implemented,
 * not integration-tested against Microsoft.
 */
export function createMicrosoftMailOAuthClient(
  options: MailOAuthOptions & { tenant: string },
): OAuthCodeClient {
  const { tenant, ...rest } = options;
  if (!/^[A-Za-z0-9.-]{1,100}$/.test(tenant)) throw new Error('Invalid Microsoft tenant.');
  return new OAuthCodeClient({
    ...rest,
    provider: 'microsoft_graph',
    label: 'Microsoft',
    authorizeUrl: microsoftAuthorizeUrl(tenant),
    tokenUrl: microsoftTokenUrl(tenant),
    scopes: GRAPH_MAIL_SCOPES,
    clientAuth: 'body',
    scopeOnRefresh: true,
  });
}
