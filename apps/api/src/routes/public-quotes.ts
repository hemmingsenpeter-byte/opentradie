import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { formatNzGstNumber } from '@opentradie/core';
import {
  expireLapsedQuotes,
  recordAudit,
  recordJobEvent,
  transaction,
  type Database,
  type Transaction,
} from '@opentradie/database';
import { buildQuoteDocumentModel, formatDocumentDate } from '@opentradie/documents';
import type { FileStore, RuntimeConfig } from '@opentradie/platform';
import { HttpError, iso, type RouteRegistry } from '../http.js';
import {
  acceptanceTokenParams,
  customerDecisionBody,
  errorResponse,
  publicQuoteResponse,
} from '../schemas.js';
import { contentDisposition } from '../services/evidence.js';
import { loadLineInputs } from '../services/quotes.js';
import { loadBusiness } from '../services/records.js';

/**
 * Unauthenticated customer routes, reached only with a single-use acceptance token. The token
 * is looked up by its SHA-256 (never stored in plaintext) within this runtime's tenant only.
 * They live under /api/public so the global Origin check still applies to the POSTs.
 */

interface TokenRow {
  tokenId: string;
  tokenHash: string;
  quoteId: string;
  documentId: string | null;
  usedAt: Date | null;
  revokedAt: Date | null;
  status: string;
  jobId: string;
  quoteNumber: string;
  revision: number;
  totalCents: number;
  gstRegistered: boolean;
  pricesEntered: 'exclusive' | 'inclusive';
  taxBasisPoints: number;
  validUntil: string | null;
  sentAt: Date | null;
  customerName: string;
  site: string | null;
  lapsed: boolean;
}

const GONE_SUPERSEDED = () =>
  new HttpError(
    410,
    'QUOTE_SUPERSEDED',
    'This quote has been replaced by a newer version. Use the link in the latest message.',
  );
const GONE_EXPIRED = () =>
  new HttpError(
    410,
    'QUOTE_EXPIRED',
    'This quote has expired. Contact the business for a new one.',
  );
const NOT_FOUND = () =>
  new HttpError(
    404,
    'LINK_NOT_FOUND',
    'This quote link is not valid. Check the link you were sent.',
  );

export function registerPublicQuoteRoutes(
  api: RouteRegistry,
  deps: { db: Database; config: RuntimeConfig; fileStore: FileStore },
) {
  const { db, config, fileStore } = deps;
  const tenantId = config.tenantId;

  async function findToken(client: Pick<Transaction, 'query'>, token: string, lock: boolean) {
    const hash = createHash('sha256').update(token).digest('hex');
    const result = await client.query<TokenRow>(
      `SELECT t.id AS "tokenId",t.token_hash AS "tokenHash",t.quote_id AS "quoteId",t.document_id AS "documentId",
         t.used_at AS "usedAt",t.revoked_at AS "revokedAt",q.status,q.job_id AS "jobId",q.quote_number AS "quoteNumber",
         q.revision,q.total_cents AS "totalCents",q.gst_registered AS "gstRegistered",q.prices_entered AS "pricesEntered",
         q.tax_basis_points AS "taxBasisPoints",to_char(q.valid_until,'YYYY-MM-DD') AS "validUntil",q.sent_at AS "sentAt",
         c.name AS "customerName",j.site_address AS site,
         (q.valid_until < (now() AT TIME ZONE b.time_zone)::date) AS lapsed
       FROM quote_acceptance_tokens t
         JOIN quotes q ON q.tenant_id=t.tenant_id AND q.id=t.quote_id
         JOIN customers c ON c.tenant_id=q.tenant_id AND c.id=q.customer_id
         JOIN jobs j ON j.tenant_id=q.tenant_id AND j.id=q.job_id
         JOIN businesses b ON b.id=t.tenant_id
       WHERE t.tenant_id=$1 AND t.token_hash=$2 ${lock ? 'FOR UPDATE OF t, q' : ''}`,
      [tenantId, hash],
    );
    const row = result.rows[0];
    // Defence in depth: compare the full hash in constant time even after the index lookup.
    if (!row || !timingSafeEqual(Buffer.from(row.tokenHash, 'hex'), Buffer.from(hash, 'hex')))
      return null;
    return row;
  }

  /** Expire a lapsed sent quote in its own transaction so the expiry survives the 410. */
  async function expireNow(quoteId: string, requestId: string) {
    await transaction(db, (client) => expireLapsedQuotes(client, { tenantId, quoteId, requestId }));
  }

  async function view(row: TokenRow) {
    const business = await loadBusiness(db.pool, tenantId);
    const lines = await loadLineInputs(db.pool, tenantId, row.quoteId);
    const issueDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: business.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(row.sentAt!);
    const model = buildQuoteDocumentModel({
      business: {
        name: business.name,
        gstNumber: business.gstNumber ? formatNzGstNumber(business.gstNumber) : null,
      },
      customer: { name: row.customerName },
      site: row.site,
      tax: {
        gstRegistered: row.gstRegistered,
        pricesEntered: row.pricesEntered,
        standardRateBasisPoints: row.taxBasisPoints,
      },
      quote: {
        quoteNumber: row.quoteNumber,
        version: row.revision,
        status: 'sent',
        issueDate,
        validUntil: row.validUntil!,
        lines,
        terms: '',
        sentAt: null,
        decidedAt: null,
        supersededByVersion: null,
      },
    });
    const decision = await db.pool.query<{
      decision: 'accepted' | 'declined';
      signerName: string;
      decidedAt: Date;
    }>(
      'SELECT decision,signer_name AS "signerName",decided_at AS "decidedAt" FROM quote_decisions WHERE tenant_id=$1 AND quote_id=$2',
      [tenantId, row.quoteId],
    );
    const decided = decision.rows[0];
    return {
      status: row.status as 'sent' | 'accepted' | 'rejected',
      title: model.title,
      quoteNumber: row.quoteNumber,
      revision: row.revision,
      business: { name: model.business.name, gstNumberLabel: model.business.gstNumberLabel },
      customerName: model.customer.name,
      siteLabel: model.siteLabel,
      dates: model.dates,
      validUntil: formatDocumentDate(row.validUntil!),
      amountColumnLabel: model.amountColumnLabel,
      lines: model.lines,
      totals: model.totals,
      notes: model.notes,
      totalCents: model.totalsCents.totalInclCents,
      decision: decided
        ? {
            decision: decided.decision,
            signerName: decided.signerName,
            decidedAt: iso(decided.decidedAt)!,
          }
        : null,
    };
  }

  /** Statuses a customer may view. Anything else is gone for them. */
  async function viewable(row: TokenRow | null, requestId: string): Promise<TokenRow> {
    if (!row) throw NOT_FOUND();
    if (row.status === 'superseded' || row.revokedAt) throw GONE_SUPERSEDED();
    if (row.status === 'expired') throw GONE_EXPIRED();
    if (row.status === 'sent' && row.lapsed) {
      await expireNow(row.quoteId, requestId);
      throw GONE_EXPIRED();
    }
    if (!['sent', 'accepted', 'rejected'].includes(row.status) || !row.sentAt) throw NOT_FOUND();
    return row;
  }

  const getLimit = { max: 30, timeWindow: '1 minute' };
  const postLimit = { max: 10, timeWindow: '1 minute' };

  api.route(
    {
      method: 'GET',
      url: '/api/public/quotes/:token',
      summary:
        'Customer view of a sent quote by its acceptance token (no sign-in). 404 unknown link, 410 superseded or expired.',
      tags: ['public'],
      auth: 'public',
      params: acceptanceTokenParams,
      rateLimit: getLimit,
      responses: {
        200: { description: 'Quote for the customer', schema: publicQuoteResponse },
        404: { description: 'LINK_NOT_FOUND', schema: errorResponse },
        410: { description: 'QUOTE_SUPERSEDED or QUOTE_EXPIRED', schema: errorResponse },
      },
    },
    async ({ params, request }) => {
      const row = await viewable(await findToken(db.pool, params.token, false), request.id);
      return { body: await view(row) };
    },
  );

  api.route(
    {
      method: 'GET',
      url: '/api/public/quotes/:token/pdf',
      summary: 'Customer download of the quote PDF by acceptance token (no sign-in)',
      tags: ['public'],
      auth: 'public',
      params: acceptanceTokenParams,
      rateLimit: getLimit,
      responses: {
        200: { description: 'application/pdf' },
        404: { description: 'LINK_NOT_FOUND', schema: errorResponse },
        410: { description: 'QUOTE_SUPERSEDED or QUOTE_EXPIRED', schema: errorResponse },
      },
    },
    async ({ params, request, reply }) => {
      const row = await viewable(await findToken(db.pool, params.token, false), request.id);
      const document = await db.pool.query<{
        storageKey: string;
        fileName: string;
        sha256: string;
      }>(
        'SELECT storage_key AS "storageKey",file_name AS "fileName",sha256 FROM documents WHERE tenant_id=$1 AND id=$2',
        [tenantId, row.documentId],
      );
      const stored = document.rows[0];
      if (!stored) throw NOT_FOUND();
      const content = await fileStore.get(stored.storageKey);
      if (createHash('sha256').update(content).digest('hex') !== stored.sha256)
        throw new HttpError(
          500,
          'DOCUMENT_INTEGRITY',
          'The stored PDF does not match its checksum.',
        );
      reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', contentDisposition(stored.fileName))
        .header('cache-control', 'private, no-store');
      return { body: content };
    },
  );

  for (const decision of ['accepted', 'declined'] as const) {
    const verb = decision === 'accepted' ? 'accept' : 'decline';
    api.route(
      {
        method: 'POST',
        url: `/api/public/quotes/:token/${verb}`,
        summary: `Customer ${decision === 'accepted' ? 'accepts' : 'declines'} a sent quote, typing their name as a signature. Single use; requires Origin = APP_ORIGIN.`,
        tags: ['public'],
        auth: 'public',
        params: acceptanceTokenParams,
        body: customerDecisionBody,
        rateLimit: postLimit,
        responses: {
          200: { description: 'Recorded decision', schema: publicQuoteResponse },
          404: { description: 'LINK_NOT_FOUND', schema: errorResponse },
          409: { description: 'QUOTE_ALREADY_DECIDED', schema: errorResponse },
          410: { description: 'QUOTE_SUPERSEDED or QUOTE_EXPIRED', schema: errorResponse },
        },
      },
      async ({ params, body, request }) => {
        const outcome = await transaction(db, async (client) => {
          const row = await findToken(client, params.token, true);
          if (!row) throw NOT_FOUND();
          if (row.status === 'superseded' || row.revokedAt) throw GONE_SUPERSEDED();
          if (row.usedAt || row.status === 'accepted' || row.status === 'rejected')
            throw new HttpError(
              409,
              'QUOTE_ALREADY_DECIDED',
              'A decision has already been recorded for this quote.',
            );
          if (row.status === 'expired') throw GONE_EXPIRED();
          if (row.status !== 'sent') throw NOT_FOUND();
          if (row.lapsed) return { expired: true as const, row };
          const document = await client.query<{ sha256: string }>(
            'SELECT sha256 FROM documents WHERE tenant_id=$1 AND id=$2',
            [tenantId, row.documentId],
          );
          await client.query(
            decision === 'accepted'
              ? "UPDATE quotes SET status='accepted',accepted_at=now(),decision_source='customer',version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2"
              : "UPDATE quotes SET status='rejected',declined_at=now(),decision_source='customer',version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
            [tenantId, row.quoteId],
          );
          await client.query(
            'UPDATE quote_acceptance_tokens SET used_at=now() WHERE tenant_id=$1 AND id=$2',
            [tenantId, row.tokenId],
          );
          const decisionId = randomUUID();
          await client.query(
            `INSERT INTO quote_decisions(id,tenant_id,quote_id,decision,source,token_id,signer_name,comment,quote_number,revision,total_cents,document_sha256)
             VALUES($1,$2,$3,$4,'customer',$5,$6,$7,$8,$9,$10,$11)`,
            [
              decisionId,
              tenantId,
              row.quoteId,
              decision,
              row.tokenId,
              body.name,
              body.comment ?? null,
              row.quoteNumber,
              row.revision,
              row.totalCents,
              document.rows[0]?.sha256 ?? null,
            ],
          );
          // Identifiers only: the signer's name and comment stay in quote_decisions.
          const metadata = {
            quoteNumber: row.quoteNumber,
            revision: row.revision,
            totalCents: row.totalCents,
            decisionId,
            tokenId: row.tokenId,
            hasComment: body.comment !== undefined,
          };
          await recordAudit(client, {
            tenantId,
            actorType: 'customer',
            actorId: null,
            action: decision === 'accepted' ? 'quote.accepted' : 'quote.declined',
            entityType: 'quote',
            entityId: row.quoteId,
            requestId: request.id,
            metadata,
          });
          await recordJobEvent(client, {
            tenantId,
            jobId: row.jobId,
            type: decision === 'accepted' ? 'quote_accepted' : 'quote_declined',
            actorType: 'customer',
            actorId: null,
            summary: `Customer ${decision} quote ${row.quoteNumber}${row.revision > 1 ? ` version ${row.revision}` : ''} online`,
            metadata: { quoteId: row.quoteId, ...metadata },
          });
          return {
            expired: false as const,
            row: { ...row, status: decision === 'accepted' ? 'accepted' : 'rejected' },
          };
        });
        if (outcome.expired) {
          await expireNow(outcome.row.quoteId, request.id);
          throw GONE_EXPIRED();
        }
        return { body: await view(outcome.row) };
      },
    );
  }
}
