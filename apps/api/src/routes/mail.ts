import { randomBytes } from 'node:crypto';
import { recordAudit, transaction, type Database } from '@opentradie/database';
import { isIntegrationError } from '@opentradie/integrations';
import type { MailRuntime, RuntimeConfig } from '@opentradie/platform';
import { z } from 'zod';
import { HttpError, iso, type RouteRegistry } from '../http.js';
import { errorResponse } from '../schemas.js';
import { claimAuthorisation, storeAuthorisation } from './oauth-flow.js';

/** MOCK: the fake mailbox has no consent screen; its callback accepts only this code. */
export const FAKE_MAIL_AUTHORISATION_CODE = 'fake-mail-authorisation-code';

const providerParam = z.object({ provider: z.enum(['gmail', 'microsoft_graph', 'fake']) }).strict();

export const mailStatusResponse = z.object({
  provider: z.enum(['none', 'gmail', 'microsoft_graph', 'fake']),
  mock: z.boolean(),
  label: z.string().nullable(),
  status: z.enum(['not_configured', 'disconnected', 'connected', 'error']),
  statusReason: z.string().nullable(),
  connectedAt: z.string().nullable(),
});

/**
 * Mailbox connection routes for Gmail and Microsoft Graph (Implemented, not integration-tested
 * against Google or Microsoft). They share the OAuth state store with the accounting routes
 * (oauth-flow.ts, ADR 0026). One mail provider per installation (MAIL_PROVIDER); a route for a
 * different provider answers 409 MAIL_PROVIDER_NOT_CONFIGURED.
 */
export function registerMailRoutes(
  api: RouteRegistry,
  deps: { db: Database; config: RuntimeConfig; mail: MailRuntime | null },
) {
  const { db, config, mail } = deps;
  const require = (provider: string) => {
    if (!mail || mail.routeProvider !== provider)
      throw new HttpError(
        409,
        'MAIL_PROVIDER_NOT_CONFIGURED',
        'This mail provider is not configured for this installation (MAIL_PROVIDER).',
      );
    return mail;
  };

  const status = async (tenantId: string) => {
    if (!mail)
      return {
        provider: 'none' as const,
        mock: false,
        label: null,
        status: 'not_configured' as const,
        statusReason: null,
        connectedAt: null,
      };
    const row = (
      await api.pool.query<{
        status: 'disconnected' | 'connected' | 'error';
        statusReason: string | null;
        connectedAt: Date | null;
      }>(
        `SELECT status,status_reason AS "statusReason",connected_at AS "connectedAt"
         FROM provider_connections WHERE tenant_id=$1 AND provider=$2`,
        [tenantId, mail.provider],
      )
    ).rows[0];
    return {
      provider: mail.routeProvider,
      mock: mail.kind === 'mock',
      label: mail.label,
      status: row?.status ?? ('disconnected' as const),
      statusReason: row?.statusReason ?? null,
      connectedAt: row?.status === 'connected' ? iso(row.connectedAt) : null,
    };
  };

  api.route(
    {
      method: 'GET',
      url: '/api/integrations/mail/status',
      summary: 'Configured mailbox provider and its connection status (owner or viewer)',
      tags: ['mail'],
      auth: 'user',
      responses: { 200: { description: 'Status', schema: mailStatusResponse } },
    },
    async ({ user }) => ({ body: await status(user.tenantId) }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/integrations/mail/:provider/status',
      summary: 'Mailbox connection status for one provider (owner or viewer)',
      tags: ['mail'],
      auth: 'user',
      params: providerParam,
      responses: {
        200: { description: 'Status', schema: mailStatusResponse },
        409: { description: 'MAIL_PROVIDER_NOT_CONFIGURED', schema: errorResponse },
      },
    },
    async ({ user, params }) => {
      require(params.provider);
      return { body: await status(user.tenantId) };
    },
  );

  api.route(
    {
      method: 'GET',
      url: '/api/integrations/mail/:provider/connect',
      summary:
        'Owner starts connecting a mailbox: returns the authorize URL. The OAuth state is stored hashed and the PKCE verifier sealed, both single-use and short-lived.',
      tags: ['mail'],
      auth: 'owner',
      params: providerParam,
      rateLimit: { max: 10, timeWindow: '1 minute' },
      responses: {
        200: {
          description: 'Authorize URL',
          schema: z.object({ authorizeUrl: z.string(), mock: z.boolean() }),
        },
        409: { description: 'MAIL_PROVIDER_NOT_CONFIGURED', schema: errorResponse },
      },
    },
    async ({ user, params, request }) => {
      const runtime = require(params.provider);
      const begun = runtime.oauth
        ? runtime.oauth.authorizationUrl(runtime.redirectUri)
        : { url: '', state: randomBytes(32).toString('base64url'), codeVerifier: null };
      await transaction(db, async (client) => {
        await storeAuthorisation(client, {
          tenantId: user.tenantId,
          userId: user.id,
          provider: runtime.provider,
          keyring: runtime.keyring,
          state: begun.state,
          codeVerifier: begun.codeVerifier,
        });
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'mail.connect_started',
          entityType: 'provider_connection',
          requestId: request.id,
          metadata: { provider: runtime.provider },
        });
      });
      // MOCK: the fake mailbox has no consent screen, so the owner goes straight to our callback.
      const authorizeUrl = runtime.oauth
        ? begun.url
        : `${runtime.redirectUri}?${new URLSearchParams({ code: FAKE_MAIL_AUTHORISATION_CODE, state: begun.state })}`;
      return { body: { authorizeUrl, mock: runtime.kind === 'mock' } };
    },
  );

  api.route(
    {
      method: 'GET',
      url: '/api/integrations/mail/:provider/callback',
      summary:
        'OAuth redirect target. Public because the SameSite=Strict session cookie is not sent on the cross-site redirect: the single-use, hashed, 10-minute state binds the request to the owner who started it. Redirects to Settings.',
      tags: ['mail'],
      auth: 'public',
      params: providerParam,
      rateLimit: { max: 20, timeWindow: '1 minute' },
      query: z
        .object({
          code: z.string().min(1).max(2000).optional(),
          state: z.string().min(1).max(200).optional(),
          error: z.string().max(200).optional(),
        })
        // Providers add their own parameters (scope, session_state, authuser); they are ignored.
        .strip(),
      responses: { 302: { description: 'Redirect to /#/settings?mail=<outcome>' } },
    },
    async ({ params, query, reply, request }) => {
      const done = (outcome: string) => {
        reply.header('location', `/#/settings?mail=${outcome}`);
        return { status: 302, body: '' };
      };
      if (!mail || mail.routeProvider !== params.provider || !query.state)
        return done('invalid_state');
      const tenantId = config.tenantId;
      const claimed = await claimAuthorisation(api.pool, {
        tenantId,
        provider: mail.provider,
        keyring: mail.keyring,
        state: query.state,
      });
      if (!claimed) return done('invalid_state');
      const audit = (action: string, metadata: Record<string, unknown>) =>
        recordAudit(api.pool, {
          tenantId,
          actorType: 'user',
          actorId: claimed.userId,
          action,
          entityType: 'provider_connection',
          requestId: request.id,
          metadata: { provider: mail.provider, ...metadata },
        });
      if (query.error || !query.code) {
        await audit('mail.connect_denied', {});
        return done('denied');
      }
      try {
        let tokens;
        if (mail.oauth) {
          tokens = await mail.oauth.exchangeCode({
            code: query.code,
            redirectUri: mail.redirectUri,
            codeVerifier: claimed.codeVerifier,
          });
        } else {
          if (query.code !== FAKE_MAIL_AUTHORISATION_CODE) throw new Error('bad fake code');
          // MOCK tokens: the fake mailbox ignores them; stored sealed like real ones.
          tokens = {
            accessToken: `fake-mail-access-${randomBytes(8).toString('hex')}`,
            refreshToken: null,
            expiresAt: new Date(Date.now() + 365 * 24 * 3600_000),
            scopes: ['mock'],
          };
        }
        if (mail.oauth && !tokens.refreshToken) {
          // Without a refresh token the connection would silently die within the hour.
          await audit('mail.connect_failed', { errorKind: 'no_refresh_token' });
          return done('failed');
        }
        await mail.tokens.save(tenantId, mail.provider, tokens);
        await audit('mail.connected', {});
        return done('connected');
      } catch (error) {
        // Error class and kind only: never codes, tokens or provider bodies.
        await audit('mail.connect_failed', {
          errorKind: isIntegrationError(error) ? error.kind : 'internal',
        });
        return done('failed');
      }
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/integrations/mail/:provider/disconnect',
      summary:
        'Owner disconnects the mailbox: stored tokens are deleted. (Also remove the app grant in the Google or Microsoft account.)',
      tags: ['mail'],
      auth: 'owner',
      params: providerParam,
      idempotent: true,
      responses: {
        200: { description: 'Disconnected', schema: z.object({ status: z.string() }) },
        409: { description: 'MAIL_PROVIDER_NOT_CONFIGURED', schema: errorResponse },
      },
    },
    async ({ user, params, request, idempotent }) => {
      const runtime = require(params.provider);
      return idempotent(async (client) => {
        await client.query(
          `UPDATE provider_connections SET status='disconnected',encrypted_credentials=NULL,encryption_key_id=NULL,
             status_reason='disconnected_by_owner',updated_at=now()
           WHERE tenant_id=$1 AND provider=$2`,
          [user.tenantId, runtime.provider],
        );
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'mail.disconnected',
          entityType: 'provider_connection',
          requestId: request.id,
          metadata: { provider: runtime.provider },
        });
        return { body: { status: 'disconnected' } };
      });
    },
  );
}
