import { createHash, randomUUID } from 'node:crypto';
import { approvalBlockers, calculateQuote, type QuoteStatus } from '@opentradie/core';
import { recordAudit, type Transaction } from '@opentradie/database';
import type { FileStore } from '@opentradie/platform';
import { z } from 'zod';
import { HttpError, type RouteRegistry, type UserContext } from '../http.js';
import {
  errorResponse,
  idParams,
  quoteDecisionBody,
  quoteRejectBody,
  quoteResponse,
  quoteUpdateBody,
} from '../schemas.js';
import {
  getQuote,
  listQuotes,
  loadBusiness,
  loadRates,
  writeQuoteLines,
} from '../services/records.js';

interface LockedQuote {
  status: QuoteStatus;
  version: number;
  missingInformation: string[];
  assumptions: string[];
  lineCount: number;
}

async function lockQuote(
  client: Transaction,
  user: UserContext,
  id: string,
  version: number,
): Promise<LockedQuote> {
  const result = await client.query<LockedQuote>(
    `SELECT status,version,missing_information AS "missingInformation",assumptions,
       (SELECT count(*)::integer FROM quote_line_items l WHERE l.tenant_id=q.tenant_id AND l.quote_id=q.id) AS "lineCount"
     FROM quotes q WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
    [user.tenantId, id],
  );
  const quote = result.rows[0];
  if (!quote) throw new HttpError(404, 'QUOTE_NOT_FOUND', 'Quote not found.');
  if (quote.version !== version)
    throw new HttpError(409, 'STALE_QUOTE', 'The quote has changed. Reload it and try again.');
  return quote;
}

export function registerQuoteRoutes(api: RouteRegistry, deps: { fileStore: FileStore }) {
  api.route(
    {
      method: 'GET',
      url: '/api/quotes',
      summary: 'List quotes',
      tags: ['quotes'],
      auth: 'user',
      query: z.object({ status: z.enum(['draft', 'approved', 'rejected']).optional() }).strict(),
      responses: {
        200: { description: 'Quotes', schema: z.object({ quotes: z.array(quoteResponse) }) },
      },
    },
    async ({ user, query }) => ({
      body: { quotes: await listQuotes(api.pool, user.tenantId, query) },
    }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/quotes/:id',
      summary: 'Get a quote',
      tags: ['quotes'],
      auth: 'user',
      params: idParams,
      responses: {
        200: { description: 'Quote', schema: quoteResponse },
        404: { description: 'Not found', schema: errorResponse },
      },
    },
    async ({ user, params }) => ({ body: await getQuote(api.pool, user.tenantId, params.id) }),
  );

  api.route(
    {
      method: 'PATCH',
      url: '/api/quotes/:id',
      summary:
        'Owner revises a draft quote. Lines reference approved rates only; prices and tax are recalculated by the server.',
      tags: ['quotes'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: quoteUpdateBody,
      responses: {
        200: { description: 'Revised quote', schema: quoteResponse },
        409: { description: 'STALE_QUOTE or QUOTE_NOT_DRAFT', schema: errorResponse },
        422: { description: 'UNKNOWN_RATE', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const quote = await lockQuote(client, user, params.id, body.version);
        if (quote.status !== 'draft')
          throw new HttpError(409, 'QUOTE_NOT_DRAFT', 'Only draft quotes can be revised.');
        const [rates, business] = await Promise.all([
          loadRates(client, user.tenantId),
          loadBusiness(client, user.tenantId),
        ]);
        const unknown = body.lines
          .filter((line) => !rates.some((rate) => rate.code === line.rateCode))
          .map((line) => line.rateCode);
        if (unknown.length)
          throw new HttpError(
            422,
            'UNKNOWN_RATE',
            `Not an approved, active rate: ${unknown.join(', ')}. Quotes can only use approved rates.`,
          );
        const calculation = calculateQuote({
          requested: body.lines,
          approvedRates: rates,
          // The owner's line list is authoritative on revision, including whether a call-out applies.
          policy: {
            taxBasisPoints: business.taxBasisPoints,
            taxLabel: business.taxLabel,
            callOutRateCode: null,
          },
          assumptions: quote.assumptions,
          missingInformation: body.missingInformation,
        });
        await client.query(
          'UPDATE quotes SET version=version+1,assumptions=$3,missing_information=$4,subtotal_cents=$5,tax_cents=$6,total_cents=$7,updated_at=now() WHERE tenant_id=$1 AND id=$2',
          [
            user.tenantId,
            params.id,
            JSON.stringify(calculation.assumptions),
            JSON.stringify(calculation.missingInformation),
            calculation.subtotalCents,
            calculation.taxCents,
            calculation.totalCents,
          ],
        );
        await writeQuoteLines(client, user.tenantId, params.id, calculation);
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'quote.revised',
          entityType: 'quote',
          entityId: params.id,
          requestId: request.id,
          metadata: {
            fromVersion: body.version,
            toVersion: body.version + 1,
            totalCents: calculation.totalCents,
            missing: calculation.missingInformation.length,
          },
        });
        return { body: await getQuote(client, user.tenantId, params.id) };
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/quotes/:id/approve',
      summary:
        'Owner approves a complete draft quote. Viewers receive 403. Stores the approved quote document.',
      tags: ['quotes'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: quoteDecisionBody,
      responses: {
        200: { description: 'Approved quote', schema: quoteResponse },
        403: { description: 'OWNER_REQUIRED', schema: errorResponse },
        409: {
          description: 'STALE_QUOTE or QUOTE_NOT_APPROVABLE (with blockers)',
          schema: errorResponse,
        },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const quote = await lockQuote(client, user, params.id, body.version);
        const blockers = approvalBlockers(quote);
        if (blockers.length)
          throw new HttpError(409, 'QUOTE_NOT_APPROVABLE', blockers.join(' '), { blockers });
        await client.query(
          "UPDATE quotes SET status='approved',version=version+1,decided_by=$3,decided_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [user.tenantId, params.id, user.id],
        );
        await client.query(
          "UPDATE approval_requests SET status='approved',decided_by=$3,decided_at=now() WHERE tenant_id=$1 AND quote_id=$2",
          [user.tenantId, params.id, user.id],
        );
        const approved = await getQuote(client, user.tenantId, params.id);
        const business = await loadBusiness(client, user.tenantId);
        const document = Buffer.from(
          JSON.stringify(
            {
              format: 'opentradie-approved-quote-v1',
              business: {
                name: business.name,
                currency: business.currency,
                taxLabel: business.taxLabel,
              },
              approvedBy: user.email,
              quote: approved,
            },
            null,
            2,
          ),
        );
        const key = `tenants/${user.tenantId}/quotes/${params.id}/v${approved.version}.json`;
        const stored = await deps.fileStore.put(key, document, { contentType: 'application/json' });
        const documentId = randomUUID();
        await client.query(
          "INSERT INTO documents(id,tenant_id,customer_id,job_id,quote_id,kind,storage_key,file_name,media_type,size_bytes,sha256) VALUES($1,$2,$3,$4,$5,'approved_quote',$6,$7,'application/json',$8,$9)",
          [
            documentId,
            user.tenantId,
            approved.customerId,
            approved.jobId,
            params.id,
            key,
            `quote-${params.id}-v${approved.version}.json`,
            stored.sizeBytes,
            stored.sha256,
          ],
        );
        if (createHash('sha256').update(document).digest('hex') !== stored.sha256)
          throw new Error('Stored document checksum mismatch.');
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'quote.approved',
          entityType: 'quote',
          entityId: params.id,
          requestId: request.id,
          metadata: {
            approvedVersion: body.version,
            totalCents: approved.totalCents,
            documentId,
            documentSha256: stored.sha256,
          },
        });
        return { body: { ...approved, documentId } };
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/quotes/:id/reject',
      summary: 'Owner rejects a draft quote',
      tags: ['quotes'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: quoteRejectBody,
      responses: {
        200: { description: 'Rejected quote', schema: quoteResponse },
        409: { description: 'STALE_QUOTE or QUOTE_NOT_DRAFT', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const quote = await lockQuote(client, user, params.id, body.version);
        if (quote.status !== 'draft')
          throw new HttpError(409, 'QUOTE_NOT_DRAFT', 'Only draft quotes can be rejected.');
        await client.query(
          "UPDATE quotes SET status='rejected',version=version+1,decided_by=$3,decided_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [user.tenantId, params.id, user.id],
        );
        await client.query(
          "UPDATE approval_requests SET status='rejected',decided_by=$3,decided_at=now(),reason=$4 WHERE tenant_id=$1 AND quote_id=$2",
          [user.tenantId, params.id, user.id, body.reason ?? null],
        );
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'quote.rejected',
          entityType: 'quote',
          entityId: params.id,
          requestId: request.id,
          metadata: { version: body.version },
        });
        return { body: await getQuote(client, user.tenantId, params.id) };
      }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/approvals',
      summary: 'Pending approval requests',
      tags: ['quotes'],
      auth: 'user',
      responses: { 200: { description: 'Pending approvals with their quotes' } },
    },
    async ({ user }) => {
      const quotes = (await listQuotes(api.pool, user.tenantId, { status: 'draft' })).filter(
        (quote) => quote.approval?.status === 'pending',
      );
      return {
        body: {
          approvals: quotes.map((quote) => ({ id: quote.approval!.id, status: 'pending', quote })),
        },
      };
    },
  );
}
