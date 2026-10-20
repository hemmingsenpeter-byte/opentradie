import { createHash, randomUUID } from 'node:crypto';
import { recordAudit, transaction, type Database } from '@opentradie/database';
import {
  FAKE_AUTHORISATION_CODE,
  FakeAccountingAdapter,
  isIntegrationError,
  openCredentials,
  sealCredentials,
} from '@opentradie/integrations';
import type { AccountingRuntime, RuntimeConfig } from '@opentradie/platform';
import { z } from 'zod';
import { HttpError, iso, type RouteRegistry } from '../http.js';
import { accountingStatusResponse } from '../invoice-schemas.js';
import { errorResponse, id } from '../schemas.js';

/** OAuth state rows live this long; the owner has to finish consent within it. */
const AUTHORISATION_TTL_MS = 10 * 60_000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** The PKCE verifier is sealed under its own AAD purpose, so it can never open as a token row. */
const verifierBinding = (tenantId: string, provider: string) => ({
  tenantId,
  provider: `${provider}:oauth_verifier`,
});

/**
 * Xero connection routes (Implemented, not integration-tested against Xero). With
 * ACCOUNTING_PROVIDER=fake the same routes drive the mock adapter, whose consent step is skipped.
 */
export function registerAccountingRoutes(
  api: RouteRegistry,
  deps: { db: Database; config: RuntimeConfig; accounting: AccountingRuntime | null },
) {
  const { db, config, accounting } = deps;
  const require = () => {
    if (!accounting)
      throw new HttpError(
        409,
        'ACCOUNTING_NOT_CONFIGURED',
        'No accounting provider is configured for this installation (ACCOUNTING_PROVIDER).',
      );
    return accounting;
  };

  api.route(
    {
      method: 'GET',
      url: '/api/integrations/xero/status',
      summary: 'Accounting connection status and invoices whose sync failed (owner or viewer)',
      tags: ['accounting'],
      auth: 'user',
      responses: { 200: { description: 'Status', schema: accountingStatusResponse } },
    },
    async ({ user }) => {
      const failures = await api.pool.query<{
        invoiceId: string;
        invoiceNumber: string;
        kind: string;
        message: string;
      }>(
        `SELECT id AS "invoiceId",invoice_number AS "invoiceNumber",sync_error_kind AS kind,coalesce(sync_error_message,'') AS message
         FROM invoices WHERE tenant_id=$1 AND status='sync_failed' ORDER BY updated_at DESC LIMIT 50`,
        [user.tenantId],
      );
      if (!accounting)
        return {
          body: {
            provider: 'none' as const,
            mock: false,
            label: null,
            status: 'not_configured' as const,
            statusReason: null,
            organisationId: null,
            pendingOrganisations: [],
            connectedAt: null,
            syncFailures: failures.rows,
          },
        };
      const row = (
        await api.pool.query<{
          status: 'disconnected' | 'connected' | 'error';
          statusReason: string | null;
          organisationId: string | null;
          pending: Array<{ organisationId: string; name: string }>;
          connectedAt: Date | null;
        }>(
          `SELECT status,status_reason AS "statusReason",external_account_id AS "organisationId",
             pending_organisations AS pending,connected_at AS "connectedAt"
           FROM provider_connections WHERE tenant_id=$1 AND provider=$2`,
          [user.tenantId, accounting.provider],
        )
      ).rows[0];
      return {
        body: {
          provider: accounting.kind === 'mock' ? ('fake' as const) : ('xero' as const),
          mock: accounting.kind === 'mock',
          label: accounting.label,
          status: row?.status ?? 'disconnected',
          statusReason: row?.statusReason ?? null,
          organisationId: row?.status === 'connected' ? row.organisationId : null,
          pendingOrganisations: row?.status === 'connected' ? row.pending : [],
          connectedAt: row?.status === 'connected' ? iso(row.connectedAt) : null,
          syncFailures: failures.rows,
        },
      };
    },
  );

  api.route(
    {
      method: 'GET',
      url: '/api/integrations/xero/connect',
      summary:
        'Owner starts connecting the accounting provider: returns the authorize URL. The OAuth state is stored hashed and the PKCE verifier sealed, both single-use and short-lived.',
      tags: ['accounting'],
      auth: 'owner',
      rateLimit: { max: 10, timeWindow: '1 minute' },
      responses: {
        200: {
          description: 'Authorize URL',
          schema: z.object({ authorizeUrl: z.string(), mock: z.boolean() }),
        },
        409: { description: 'ACCOUNTING_NOT_CONFIGURED', schema: errorResponse },
      },
    },
    async ({ user, request }) => {
      const runtime = require();
      const begun = await runtime.adapter.beginAuthorisation({ redirectUri: runtime.redirectUri });
      const sealed = begun.codeVerifier
        ? sealCredentials(
            begun.codeVerifier,
            runtime.keyring,
            verifierBinding(user.tenantId, runtime.provider),
          )
        : null;
      await transaction(db, async (client) => {
        await client.query(
          `INSERT INTO oauth_authorisations(id,tenant_id,provider,user_id,state_hash,sealed_verifier,verifier_key_id,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            randomUUID(),
            user.tenantId,
            runtime.provider,
            user.id,
            sha256(begun.state),
            sealed?.ciphertext ?? null,
            sealed?.keyId ?? null,
            new Date(Date.now() + AUTHORISATION_TTL_MS),
          ],
        );
        await client.query(
          "DELETE FROM oauth_authorisations WHERE tenant_id=$1 AND expires_at < now() - interval '1 day'",
          [user.tenantId],
        );
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'accounting.connect_started',
          entityType: 'provider_connection',
          requestId: request.id,
          metadata: { provider: runtime.provider },
        });
      });
      // MOCK: the fake provider has no consent screen, so the owner is sent straight back to
      // our callback with the fake code. A real provider's URL goes to its consent screen.
      const authorizeUrl =
        runtime.kind === 'mock'
          ? `${runtime.redirectUri}?${new URLSearchParams({ code: FAKE_AUTHORISATION_CODE, state: begun.state })}`
          : begun.url;
      return { body: { authorizeUrl, mock: runtime.kind === 'mock' } };
    },
  );

  api.route(
    {
      method: 'GET',
      url: '/api/integrations/xero/callback',
      summary:
        'OAuth redirect target. Public because the session cookie is SameSite=Strict and is not sent on the cross-site redirect: the single-use, hashed, 10-minute state binds the request to the owner who started it. Redirects to the Settings screen.',
      tags: ['accounting'],
      auth: 'public',
      rateLimit: { max: 20, timeWindow: '1 minute' },
      query: z
        .object({
          code: z.string().min(1).max(2000).optional(),
          state: z.string().min(1).max(200).optional(),
          error: z.string().max(200).optional(),
        })
        // Providers add their own parameters (scope, session_state); they are ignored.
        .strip(),
      responses: { 302: { description: 'Redirect to /#/settings?accounting=<outcome>' } },
    },
    async ({ query, reply, request }) => {
      const done = (outcome: string) => {
        reply.header('location', `/#/settings?accounting=${outcome}`);
        return { status: 302, body: '' };
      };
      if (!accounting || !query.state) return done('invalid_state');
      const tenantId = config.tenantId;
      const claimed = (
        await api.pool.query<{ userId: string; sealed: Buffer | null; keyId: string | null }>(
          `UPDATE oauth_authorisations SET used_at=now()
           WHERE tenant_id=$1 AND provider=$2 AND state_hash=$3 AND used_at IS NULL AND expires_at > now()
           RETURNING user_id AS "userId",sealed_verifier AS sealed,verifier_key_id AS "keyId"`,
          [tenantId, accounting.provider, sha256(query.state)],
        )
      ).rows[0];
      if (!claimed) return done('invalid_state');
      const audit = (action: string, metadata: Record<string, unknown>) =>
        recordAudit(api.pool, {
          tenantId,
          actorType: 'user',
          actorId: claimed.userId,
          action,
          entityType: 'provider_connection',
          requestId: request.id,
          metadata: { provider: accounting.provider, ...metadata },
        });
      if (query.error || !query.code) {
        await audit('accounting.connect_denied', {});
        return done('denied');
      }
      try {
        const codeVerifier =
          claimed.sealed && claimed.keyId
            ? openCredentials(
                { keyId: claimed.keyId, ciphertext: claimed.sealed },
                accounting.keyring,
                verifierBinding(tenantId, accounting.provider),
              )
            : null;
        await accounting.adapter.completeAuthorisation({
          tenantId,
          code: query.code,
          redirectUri: accounting.redirectUri,
          codeVerifier,
        });
        const organisations = await accounting.adapter.listOrganisations(tenantId);
        const previous = await accounting.connections.get(tenantId, accounting.provider);
        const chosen = organisations.length === 1 ? organisations[0]!.organisationId : null;
        await transaction(db, async (client) => {
          if (chosen && previous?.externalAccountId && previous.externalAccountId !== chosen)
            // Contacts belong to the previous organisation; invoice links are kept for history.
            await client.query(
              "DELETE FROM external_references WHERE tenant_id=$1 AND provider=$2 AND entity_type='contact'",
              [tenantId, accounting.provider],
            );
          await client.query(
            `UPDATE provider_connections SET external_account_id=$3,pending_organisations=$4,updated_at=now()
             WHERE tenant_id=$1 AND provider=$2`,
            [
              tenantId,
              accounting.provider,
              chosen,
              JSON.stringify(
                chosen
                  ? []
                  : organisations.slice(0, 50).map((org) => ({
                      organisationId: org.organisationId,
                      name: org.name.slice(0, 200),
                    })),
              ),
            ],
          );
        });
        await audit('accounting.connected', { organisations: organisations.length });
        return done(chosen ? 'connected' : 'choose_organisation');
      } catch (error) {
        // Error class and kind only: never codes, tokens or provider bodies.
        await audit('accounting.connect_failed', {
          errorKind: isIntegrationError(error) ? error.kind : 'internal',
        });
        return done('failed');
      }
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/integrations/xero/organisation',
      summary:
        'Owner chooses which connected organisation to use when the provider offered several',
      tags: ['accounting'],
      auth: 'owner',
      idempotent: true,
      body: z.object({ organisationId: z.string().min(1).max(100) }).strict(),
      responses: {
        200: {
          description: 'Organisation chosen',
          schema: z.object({ organisationId: z.string() }),
        },
        422: { description: 'UNKNOWN_ORGANISATION', schema: errorResponse },
      },
    },
    async ({ user, body, request, idempotent }) => {
      const runtime = require();
      return idempotent(async (client) => {
        const row = (
          await client.query<{ pending: Array<{ organisationId: string }> }>(
            `SELECT pending_organisations AS pending FROM provider_connections
             WHERE tenant_id=$1 AND provider=$2 AND status='connected' FOR UPDATE`,
            [user.tenantId, runtime.provider],
          )
        ).rows[0];
        if (!row?.pending.some((org) => org.organisationId === body.organisationId))
          throw new HttpError(
            422,
            'UNKNOWN_ORGANISATION',
            'Choose one of the offered organisations.',
          );
        await client.query(
          "DELETE FROM external_references WHERE tenant_id=$1 AND provider=$2 AND entity_type='contact'",
          [user.tenantId, runtime.provider],
        );
        await client.query(
          `UPDATE provider_connections SET external_account_id=$3,pending_organisations='[]',updated_at=now()
           WHERE tenant_id=$1 AND provider=$2`,
          [user.tenantId, runtime.provider, body.organisationId],
        );
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'accounting.organisation_chosen',
          entityType: 'provider_connection',
          requestId: request.id,
          metadata: { provider: runtime.provider },
        });
        return { body: { organisationId: body.organisationId } };
      });
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/integrations/xero/disconnect',
      summary:
        'Owner disconnects the accounting provider: stored tokens are deleted. Posted invoices keep their ledger links. (The app connection should also be removed in the provider.)',
      tags: ['accounting'],
      auth: 'owner',
      idempotent: true,
      responses: { 200: { description: 'Disconnected', schema: z.object({ status: z.string() }) } },
    },
    async ({ user, request, idempotent }) => {
      const runtime = require();
      return idempotent(async (client) => {
        await client.query(
          `UPDATE provider_connections SET status='disconnected',encrypted_credentials=NULL,encryption_key_id=NULL,
             pending_organisations='[]',status_reason='disconnected_by_owner',updated_at=now()
           WHERE tenant_id=$1 AND provider=$2`,
          [user.tenantId, runtime.provider],
        );
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'accounting.disconnected',
          entityType: 'provider_connection',
          requestId: request.id,
          metadata: { provider: runtime.provider },
        });
        return { body: { status: 'disconnected' } };
      });
    },
  );

  // MOCK ONLY: lets demos and e2e tests record a payment in the fake ledger. Registered only when
  // the fake adapter is configured (which configuration refuses in the cloud profile).
  if (accounting?.adapter instanceof FakeAccountingAdapter) {
    const fake = accounting.adapter;
    api.route(
      {
        method: 'POST',
        url: '/api/integrations/accounting/mock/payments',
        summary:
          'MOCK: record a payment against a posted invoice in the fake accounting adapter (demo and tests only)',
        tags: ['accounting'],
        auth: 'owner',
        idempotent: true,
        body: z
          .object({
            invoiceId: id,
            amountCents: z.number().int().min(1).max(1_000_000_000_000).optional(),
          })
          .strict(),
        responses: {
          200: {
            description: 'Payment recorded in the mock',
            schema: z.object({ mock: z.literal(true) }),
          },
          409: { description: 'INVOICE_NOT_POSTED', schema: errorResponse },
        },
      },
      async ({ user, body, request, idempotent }) =>
        idempotent(async (client) => {
          const invoice = (
            await client.query<{ externalId: string | null; issueDate: string }>(
              `SELECT external_invoice_id AS "externalId",to_char(issue_date,'YYYY-MM-DD') AS "issueDate"
               FROM invoices WHERE tenant_id=$1 AND id=$2 AND status IN ('posted','part_paid')`,
              [user.tenantId, body.invoiceId],
            )
          ).rows[0];
          if (!invoice?.externalId)
            throw new HttpError(409, 'INVOICE_NOT_POSTED', 'The invoice is not posted yet.');
          const context = { tenantId: user.tenantId, organisationId: 'mock' };
          const current = await fake.getInvoice(context, invoice.externalId);
          if (current.status === 'draft' || current.status === 'submitted')
            fake.simulateAuthorise(invoice.externalId);
          fake.simulatePayment(
            invoice.externalId,
            body.amountCents ?? current.amountDueCents,
            invoice.issueDate,
          );
          await recordAudit(client, {
            tenantId: user.tenantId,
            actorType: 'user',
            actorId: user.id,
            action: 'accounting.mock_payment_recorded',
            entityType: 'invoice',
            entityId: body.invoiceId,
            requestId: request.id,
            metadata: { mock: true },
          });
          return { body: { mock: true as const } };
        }),
    );
  }
}
