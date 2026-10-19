import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  addDays,
  approvalBlockers,
  canTransitionQuote,
  checkJobTransition,
  formatNzGstNumber,
  formatSignedCents,
  localDate,
  type JobStatus,
  type LineInput,
  type QuoteStatus,
} from '@opentradie/core';
import { recordAudit, recordJobEvent, type Transaction } from '@opentradie/database';
import { buildQuoteDocumentModel, formatDocumentDate, renderQuotePdf } from '@opentradie/documents';
import type { FileStore, PostgresJobQueue, RuntimeConfig } from '@opentradie/platform';
import { z } from 'zod';
import { HttpError, type RouteRegistry, type UserContext } from '../http.js';
import {
  errorResponse,
  idParams,
  quoteDecisionBody,
  quoteRejectBody,
  quoteResponse,
  quoteSendResponse,
  quoteStatus,
  quoteUpdateBody,
} from '../schemas.js';
import { contentDisposition } from '../services/evidence.js';
import {
  linesFromRequest,
  loadLineInputs,
  withPricingAssumptions,
  writeQuotePricing,
} from '../services/quotes.js';
import { getQuote, listQuotes, loadBusiness, loadRates } from '../services/records.js';

interface LockedQuote {
  status: QuoteStatus;
  version: number;
  jobId: string;
  customerId: string;
  quoteNumber: string;
  revision: number;
  quoteGroupId: string;
  currency: string;
  gstRegistered: boolean;
  pricesEntered: 'exclusive' | 'inclusive';
  taxBasisPoints: number;
  totalCents: number;
  missingInformation: string[];
  assumptions: string[];
  lineCount: number;
}

async function lockQuote(
  client: Transaction,
  user: UserContext,
  id: string,
  version: number | null,
): Promise<LockedQuote> {
  const result = await client.query<LockedQuote>(
    `SELECT status,version,job_id AS "jobId",customer_id AS "customerId",quote_number AS "quoteNumber",revision,
       quote_group_id AS "quoteGroupId",currency,gst_registered AS "gstRegistered",prices_entered AS "pricesEntered",
       tax_basis_points AS "taxBasisPoints",total_cents AS "totalCents",missing_information AS "missingInformation",assumptions,
       (SELECT count(*)::integer FROM quote_line_items l WHERE l.tenant_id=q.tenant_id AND l.quote_id=q.id) AS "lineCount"
     FROM quotes q WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
    [user.tenantId, id],
  );
  const quote = result.rows[0];
  if (!quote) throw new HttpError(404, 'QUOTE_NOT_FOUND', 'Quote not found.');
  if (version !== null && quote.version !== version)
    throw new HttpError(409, 'STALE_QUOTE', 'The quote has changed. Reload it and try again.');
  return quote;
}

const ACCEPTANCE_PATH = /\/q\/([A-Za-z0-9_-]{43})/;

export function hashAcceptanceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function registerQuoteRoutes(
  api: RouteRegistry,
  deps: { fileStore: FileStore; queue: PostgresJobQueue; config: RuntimeConfig },
) {
  const { fileStore, queue, config } = deps;
  const audit = (
    client: Transaction,
    user: UserContext,
    requestId: string,
    action: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ) =>
    recordAudit(client, {
      tenantId: user.tenantId,
      actorType: 'user',
      actorId: user.id,
      action,
      entityType: 'quote',
      entityId,
      requestId,
      metadata,
    });

  api.route(
    {
      method: 'GET',
      url: '/api/quotes',
      summary: 'List quotes',
      tags: ['quotes'],
      auth: 'user',
      query: z.object({ status: quoteStatus.optional() }).strict(),
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
        'Owner edits the lines of a draft quote (approved rates, material cost plus markup, or an owner-entered price). The server prices every line and recalculates GST and totals; clients never send totals.',
      tags: ['quotes'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: quoteUpdateBody,
      responses: {
        200: { description: 'Updated draft quote', schema: quoteResponse },
        403: { description: 'OWNER_REQUIRED', schema: errorResponse },
        409: { description: 'STALE_QUOTE or QUOTE_NOT_DRAFT', schema: errorResponse },
        422: { description: 'UNKNOWN_RATE or INVALID_QUOTE_LINES', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const quote = await lockQuote(client, user, params.id, body.version);
        if (quote.status !== 'draft')
          throw new HttpError(
            409,
            'QUOTE_NOT_DRAFT',
            'Only draft quotes can be edited. Revise an approved or sent quote to create a new version.',
          );
        const [rates, business] = await Promise.all([
          loadRates(client, user.tenantId),
          loadBusiness(client, user.tenantId),
        ]);
        const lines = linesFromRequest(body.lines, { rates, business, user });
        const totals = await writeQuotePricing(client, {
          tenantId: user.tenantId,
          quoteId: params.id,
          lines,
          business,
          assumptions: withPricingAssumptions(quote.assumptions, business),
          missingInformation: body.missingInformation ?? quote.missingInformation,
        });
        await client.query(
          'UPDATE quotes SET version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',
          [user.tenantId, params.id],
        );
        const sources = Object.fromEntries(
          ['approved_rate', 'cost_plus_markup', 'owner_entered'].map((source) => [
            source,
            totals.lines.filter((line) => line.priceSource === source).length,
          ]),
        );
        await audit(client, user, request.id, 'quote.revised', params.id, {
          fromVersion: body.version,
          toVersion: body.version + 1,
          lines: totals.lines.length,
          priceSources: sources,
          totalCents: totals.totalInclCents,
          missing: (body.missingInformation ?? quote.missingInformation).length,
        });
        await recordJobEvent(client, {
          tenantId: user.tenantId,
          jobId: quote.jobId,
          type: 'quote_updated',
          actorType: 'user',
          actorId: user.id,
          summary: `Quote ${quote.quoteNumber} lines updated`,
          metadata: {
            quoteId: params.id,
            version: body.version + 1,
            totalCents: totals.totalInclCents,
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
        'Owner approves a complete draft quote (internal approval before sending). Viewers receive 403. Stores the approved quote record.',
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
        const stored = await fileStore.put(key, document, { contentType: 'application/json' });
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
            `quote-${approved.quoteNumber}-r${approved.revision}-approved.json`,
            stored.sizeBytes,
            stored.sha256,
          ],
        );
        if (createHash('sha256').update(document).digest('hex') !== stored.sha256)
          throw new Error('Stored document checksum mismatch.');
        await audit(client, user, request.id, 'quote.approved', params.id, {
          approvedVersion: body.version,
          quoteNumber: approved.quoteNumber,
          revision: approved.revision,
          totalCents: approved.totalCents,
          documentId,
          documentSha256: stored.sha256,
        });
        await recordJobEvent(client, {
          tenantId: user.tenantId,
          jobId: approved.jobId,
          type: 'quote_approved',
          actorType: 'user',
          actorId: user.id,
          summary: `Quote ${approved.quoteNumber} approved by the owner`,
          metadata: { quoteId: params.id, documentId, totalCents: approved.totalCents },
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
          "UPDATE quotes SET status='rejected',decision_source='owner',version=version+1,decided_by=$3,decided_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [user.tenantId, params.id, user.id],
        );
        await client.query(
          "UPDATE approval_requests SET status='rejected',decided_by=$3,decided_at=now(),reason=$4 WHERE tenant_id=$1 AND quote_id=$2",
          [user.tenantId, params.id, user.id, body.reason ?? null],
        );
        await audit(client, user, request.id, 'quote.rejected', params.id, {
          version: body.version,
        });
        await recordJobEvent(client, {
          tenantId: user.tenantId,
          jobId: quote.jobId,
          type: 'quote_rejected',
          actorType: 'user',
          actorId: user.id,
          summary: `Quote ${quote.quoteNumber} rejected by the owner`,
          metadata: { quoteId: params.id },
        });
        return { body: await getQuote(client, user.tenantId, params.id) };
      }),
  );

  /** The acceptance link already issued for a sent quote (from its outbound message draft). */
  async function existingSend(client: Transaction, user: UserContext, quoteId: string) {
    const result = await client.query<{
      text: string;
      communicationId: string;
      documentId: string;
      validUntil: string;
    }>(
      `SELECT m.text,t.communication_id AS "communicationId",t.document_id AS "documentId",to_char(q.valid_until,'YYYY-MM-DD') AS "validUntil"
       FROM quote_acceptance_tokens t
         JOIN communications m ON m.tenant_id=t.tenant_id AND m.id=t.communication_id
         JOIN quotes q ON q.tenant_id=t.tenant_id AND q.id=t.quote_id
       WHERE t.tenant_id=$1 AND t.quote_id=$2 AND t.used_at IS NULL AND t.revoked_at IS NULL`,
      [user.tenantId, quoteId],
    );
    const row = result.rows[0];
    const token = row ? ACCEPTANCE_PATH.exec(row.text)?.[1] : undefined;
    if (!row || !token)
      throw new HttpError(409, 'QUOTE_ALREADY_SENT', 'This quote was already sent.');
    return {
      quote: await getQuote(client, user.tenantId, quoteId),
      acceptanceUrl: `${config.appOrigin}/q/${token}`,
      messageDraftId: row.communicationId,
      pdfDocumentId: row.documentId,
      validUntil: row.validUntil,
    };
  }

  api.route(
    {
      method: 'POST',
      url: '/api/quotes/:id/send',
      summary:
        'Owner sends an approved quote: renders and stores the PDF, issues a single-use customer acceptance link (only its SHA-256 is stored), records an outbound message DRAFT containing the link and marks the quote sent. No email is sent: there is no email provider yet. Re-sending a sent quote returns the same link.',
      tags: ['quotes'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: quoteDecisionBody,
      responses: {
        200: { description: 'Sent quote with its acceptance link', schema: quoteSendResponse },
        403: { description: 'OWNER_REQUIRED', schema: errorResponse },
        409: {
          description:
            'STALE_QUOTE, QUOTE_NOT_APPROVED, QUOTE_EXPIRED or QUOTE_TAX_SETTINGS_CHANGED',
          schema: errorResponse,
        },
        422: { description: 'GST_NUMBER_REQUIRED', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const current = await lockQuote(client, user, params.id, null);
        if (current.status === 'sent') return { body: await existingSend(client, user, params.id) };
        if (current.version !== body.version)
          throw new HttpError(
            409,
            'STALE_QUOTE',
            'The quote has changed. Reload it and try again.',
          );
        if (!canTransitionQuote(current.status, 'sent'))
          throw new HttpError(
            409,
            'QUOTE_NOT_APPROVED',
            current.status === 'draft'
              ? 'Approve the quote before sending it.'
              : `A ${current.status} quote cannot be sent.`,
          );
        if (current.lineCount === 0)
          throw new HttpError(409, 'QUOTE_NOT_APPROVED', 'A quote needs at least one line.');
        const business = await loadBusiness(client, user.tenantId);
        if (
          business.gstRegistered !== current.gstRegistered ||
          (business.gstRegistered &&
            (business.pricesEntered !== current.pricesEntered ||
              business.taxBasisPoints !== current.taxBasisPoints))
        )
          throw new HttpError(
            409,
            'QUOTE_TAX_SETTINGS_CHANGED',
            'GST settings changed after this quote was priced. Revise the quote so it is priced with the current settings.',
          );
        if (business.gstRegistered && !business.gstNumber)
          throw new HttpError(
            422,
            'GST_NUMBER_REQUIRED',
            'Add your GST number in Settings before sending quotes as a GST-registered business.',
          );
        const details = await client.query<{
          customerName: string;
          customerEmail: string | null;
          customerPhone: string | null;
          customerAddress: string | null;
          jobTitle: string;
          jobStatus: JobStatus;
          site: string | null;
        }>(
          `SELECT c.name AS "customerName",c.email AS "customerEmail",c.phone AS "customerPhone",c.address AS "customerAddress",
             j.title AS "jobTitle",j.status AS "jobStatus",j.site_address AS site
           FROM jobs j JOIN customers c ON c.tenant_id=j.tenant_id AND c.id=j.customer_id
           WHERE j.tenant_id=$1 AND j.id=$2 FOR UPDATE OF j`,
          [user.tenantId, current.jobId],
        );
        const detail = details.rows[0]!;
        const lines: LineInput[] = await loadLineInputs(client, user.tenantId, params.id);
        const now = new Date();
        const issueDate = localDate(now, business.timeZone);
        const validUntil = addDays(issueDate, business.quoteValidityDays);
        const model = buildQuoteDocumentModel({
          business: {
            name: business.name,
            gstNumber: business.gstNumber ? formatNzGstNumber(business.gstNumber) : null,
          },
          customer: {
            name: detail.customerName,
            email: detail.customerEmail,
            phone: detail.customerPhone,
            address: detail.customerAddress,
          },
          site: detail.site,
          tax: {
            gstRegistered: current.gstRegistered,
            pricesEntered: current.pricesEntered,
            standardRateBasisPoints: current.taxBasisPoints,
          },
          quote: {
            quoteNumber: current.quoteNumber,
            version: current.revision,
            status: 'sent',
            issueDate,
            validUntil,
            lines,
            terms: '',
            sentAt: now.toISOString(),
            decidedAt: null,
            supersededByVersion: null,
          },
        });
        if (model.totalsCents.totalInclCents !== current.totalCents)
          throw new Error('Quote totals differ from the stored totals.');
        // The PDF never contains the acceptance link: a stored file must not be a credential.
        model.acceptanceNote = `To accept or decline online, open the link in the message that came with this quote, or reply to ${model.business.name} quoting ${current.quoteNumber} version ${current.revision} on or before ${formatDocumentDate(validUntil)}.`;
        const pdf = await renderQuotePdf(model);
        const key = `tenants/${user.tenantId}/quotes/${params.id}/${current.quoteNumber}-r${current.revision}.pdf`;
        const stored = await fileStore.put(key, pdf, { contentType: 'application/pdf' });
        if (createHash('sha256').update(pdf).digest('hex') !== stored.sha256)
          throw new Error('Stored document checksum mismatch.');
        const documentId = randomUUID();
        await client.query(
          `INSERT INTO documents(id,tenant_id,customer_id,job_id,quote_id,kind,storage_key,file_name,media_type,size_bytes,sha256)
           VALUES($1,$2,$3,$4,$5,'quote_pdf',$6,$7,'application/pdf',$8,$9)
           ON CONFLICT (tenant_id,storage_key) DO NOTHING`,
          [
            documentId,
            user.tenantId,
            current.customerId,
            current.jobId,
            params.id,
            key,
            `${current.quoteNumber}${current.revision > 1 ? `-v${current.revision}` : ''}.pdf`,
            stored.sizeBytes,
            stored.sha256,
          ],
        );

        const token = randomBytes(32).toString('base64url');
        const acceptanceUrl = `${config.appOrigin}/q/${token}`;
        const total = formatSignedCents(current.totalCents);
        const communicationId = randomUUID();
        await client.query(
          `INSERT INTO communications(id,tenant_id,customer_id,job_id,direction,channel,status,subject,text)
           VALUES($1,$2,$3,$4,'outbound',$5,'draft',$6,$7)`,
          [
            communicationId,
            user.tenantId,
            current.customerId,
            current.jobId,
            detail.customerEmail ? 'email' : 'manual',
            `Quote ${current.quoteNumber} from ${business.name}`,
            [
              `Kia ora ${detail.customerName},`,
              '',
              `Here is quote ${current.quoteNumber}${current.revision > 1 ? ` (version ${current.revision})` : ''} for "${detail.jobTitle}": ${total}${current.gstRegistered ? ' including GST' : ''}.`,
              `It is valid until ${formatDocumentDate(validUntil)}.`,
              '',
              `View, accept or decline it here: ${acceptanceUrl}`,
              '',
              business.name,
            ].join('\n'),
          ],
        );
        const tokenId = randomUUID();
        const expiry = await client.query<{ expiresAt: Date }>(
          `INSERT INTO quote_acceptance_tokens(id,tenant_id,quote_id,token_hash,document_id,communication_id,expires_at,created_by)
           VALUES($1,$2,$3,$4,$5,$6,(($7::date + 1)::timestamp AT TIME ZONE $8),$9) RETURNING expires_at AS "expiresAt"`,
          [
            tokenId,
            user.tenantId,
            params.id,
            createHash('sha256').update(token).digest('hex'),
            documentId,
            communicationId,
            validUntil,
            business.timeZone,
            user.id,
          ],
        );
        await client.query(
          "UPDATE quotes SET status='sent',sent_at=now(),valid_until=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [user.tenantId, params.id, validUntil],
        );
        await queue.enqueue(
          {
            tenantId: user.tenantId,
            kind: 'quote.expire',
            payload: { quoteId: params.id },
            idempotencyKey: `quote-expire:${params.id}`,
            runAt: expiry.rows[0]!.expiresAt,
          },
          client,
        );
        if (detail.jobStatus === 'new' && checkJobTransition('new', 'quoted').allowed) {
          await client.query(
            "UPDATE jobs SET status='quoted',updated_at=now() WHERE tenant_id=$1 AND id=$2",
            [user.tenantId, current.jobId],
          );
          await recordJobEvent(client, {
            tenantId: user.tenantId,
            jobId: current.jobId,
            type: 'status_changed',
            actorType: 'user',
            actorId: user.id,
            fromStatus: 'new',
            toStatus: 'quoted',
            summary: 'Status changed when the quote was sent',
            metadata: { quoteId: params.id },
          });
        }
        await audit(client, user, request.id, 'quote.sent', params.id, {
          quoteNumber: current.quoteNumber,
          revision: current.revision,
          totalCents: current.totalCents,
          validUntil,
          documentId,
          documentSha256: stored.sha256,
          messageDraftId: communicationId,
          tokenId,
          delivery: 'draft_only',
        });
        await recordJobEvent(client, {
          tenantId: user.tenantId,
          jobId: current.jobId,
          type: 'quote_sent',
          actorType: 'user',
          actorId: user.id,
          summary: `Quote ${current.quoteNumber} marked sent; message drafted with the acceptance link`,
          metadata: {
            quoteId: params.id,
            revision: current.revision,
            documentId,
            messageDraftId: communicationId,
            validUntil,
          },
        });
        return {
          body: {
            quote: await getQuote(client, user.tenantId, params.id),
            acceptanceUrl,
            messageDraftId: communicationId,
            pdfDocumentId: documentId,
            validUntil,
          },
        };
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/quotes/:id/revise',
      summary:
        'Owner revises an approved or sent quote: creates the next version as a draft (same quote number), supersedes this one and revokes its acceptance link.',
      tags: ['quotes'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: quoteDecisionBody,
      responses: {
        201: { description: 'New draft version', schema: quoteResponse },
        403: { description: 'OWNER_REQUIRED', schema: errorResponse },
        409: { description: 'STALE_QUOTE or QUOTE_NOT_REVISABLE', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const quote = await lockQuote(client, user, params.id, body.version);
        if (quote.status === 'draft' || !canTransitionQuote(quote.status, 'superseded'))
          throw new HttpError(
            409,
            'QUOTE_NOT_REVISABLE',
            quote.status === 'draft'
              ? 'Edit the draft directly; only approved or sent quotes are revised.'
              : `A ${quote.status} quote cannot be revised.`,
          );
        const [rates, business] = await Promise.all([
          loadRates(client, user.tenantId),
          loadBusiness(client, user.tenantId),
        ]);
        await client.query(
          "UPDATE quotes SET status='superseded',superseded_at=now(),version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [user.tenantId, params.id],
        );
        const revoked = await client.query(
          'UPDATE quote_acceptance_tokens SET revoked_at=now() WHERE tenant_id=$1 AND quote_id=$2 AND used_at IS NULL AND revoked_at IS NULL',
          [user.tenantId, params.id],
        );
        const nextId = randomUUID();
        await client.query(
          `INSERT INTO quotes(id,tenant_id,customer_id,job_id,currency,subtotal_cents,tax_cents,total_cents,tax_basis_points,created_by,
             quote_number,quote_group_id,revision,previous_version_id)
           VALUES($1,$2,$3,$4,$5,0,0,0,$6,$7,$8,$9,$10,$11)`,
          [
            nextId,
            user.tenantId,
            quote.customerId,
            quote.jobId,
            quote.currency,
            business.taxBasisPoints,
            user.id,
            quote.quoteNumber,
            quote.quoteGroupId,
            quote.revision + 1,
            params.id,
          ],
        );
        // Approved-rate lines are re-priced from the current rate card; a line whose rate is no
        // longer active keeps its price and becomes an open question the owner must resolve.
        const card = new Map(rates.map((rate) => [rate.code, rate.unitPriceCents]));
        const missing = [...quote.missingInformation];
        const lines = (await loadLineInputs(client, user.tenantId, params.id)).map((line) => {
          if (line.price.source !== 'approved_rate') return line;
          const price = card.get(line.price.rateCode);
          if (price === undefined) {
            missing.push(
              `Rate "${line.price.rateCode}" is no longer active. Replace the "${line.description}" line.`,
            );
            return line;
          }
          return { ...line, price: { ...line.price, unitPriceCents: price } };
        });
        const totals = await writeQuotePricing(client, {
          tenantId: user.tenantId,
          quoteId: nextId,
          lines,
          business,
          assumptions: withPricingAssumptions(quote.assumptions, business),
          missingInformation: missing,
        });
        await client.query(
          "INSERT INTO approval_requests(id,tenant_id,subject_type,quote_id,status,requested_by) VALUES($1,$2,'quote',$3,'pending',$4)",
          [randomUUID(), user.tenantId, nextId, user.id],
        );
        const metadata = {
          quoteNumber: quote.quoteNumber,
          fromQuoteId: params.id,
          toQuoteId: nextId,
          fromRevision: quote.revision,
          toRevision: quote.revision + 1,
          linksRevoked: revoked.rowCount ?? 0,
          totalCents: totals.totalInclCents,
        };
        await audit(client, user, request.id, 'quote.superseded', params.id, metadata);
        await audit(client, user, request.id, 'quote.version_created', nextId, metadata);
        await recordJobEvent(client, {
          tenantId: user.tenantId,
          jobId: quote.jobId,
          type: 'quote_revised',
          actorType: 'user',
          actorId: user.id,
          summary: `Quote ${quote.quoteNumber} revised: version ${quote.revision + 1} drafted, version ${quote.revision} superseded`,
          metadata,
        });
        return { status: 201, body: await getQuote(client, user.tenantId, nextId) };
      }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/quotes/:id/pdf',
      summary: 'Download the PDF generated when the quote was sent (owner or viewer)',
      tags: ['quotes'],
      auth: 'user',
      params: idParams,
      responses: {
        200: { description: 'application/pdf' },
        404: { description: 'QUOTE_NOT_FOUND or PDF_NOT_FOUND', schema: errorResponse },
      },
    },
    async ({ user, params, reply }) => {
      const quote = await getQuote(api.pool, user.tenantId, params.id);
      const result = await api.pool.query<{ storageKey: string; fileName: string; sha256: string }>(
        `SELECT storage_key AS "storageKey",file_name AS "fileName",sha256 FROM documents
         WHERE tenant_id=$1 AND quote_id=$2 AND kind='quote_pdf' ORDER BY created_at DESC LIMIT 1`,
        [user.tenantId, quote.id],
      );
      const document = result.rows[0];
      if (!document)
        throw new HttpError(
          404,
          'PDF_NOT_FOUND',
          'No PDF yet: one is created when the quote is sent.',
        );
      const content = await fileStore.get(document.storageKey);
      if (createHash('sha256').update(content).digest('hex') !== document.sha256)
        throw new HttpError(
          500,
          'DOCUMENT_INTEGRITY',
          'The stored PDF does not match its checksum.',
        );
      reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', contentDisposition(document.fileName))
        .header('cache-control', 'private, no-store');
      return { body: content };
    },
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
