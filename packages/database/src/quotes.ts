import { recordAudit } from './audit.js';
import type { Queryable } from './db.js';
import { recordJobEvent } from './job-events.js';

export interface ExpiredQuote {
  id: string;
  jobId: string;
  quoteNumber: string;
  revision: number;
}

/**
 * Mark sent quotes whose validity day has ended (in the business time zone) as expired, with
 * an audit event and a timeline entry for each. Pass `quoteId` to check one quote only.
 * Idempotent: an already-expired or decided quote is never touched. Run inside a transaction.
 */
export async function expireLapsedQuotes(
  client: Queryable,
  input: { tenantId: string; quoteId?: string | null; requestId: string },
): Promise<ExpiredQuote[]> {
  const result = await client.query<ExpiredQuote>(
    `UPDATE quotes q SET status='expired', expired_at=now(), version=q.version+1, updated_at=now()
     FROM businesses b
     WHERE b.id=q.tenant_id AND q.tenant_id=$1 AND q.status='sent'
       AND q.valid_until < (now() AT TIME ZONE b.time_zone)::date
       AND ($2::uuid IS NULL OR q.id=$2)
     RETURNING q.id, q.job_id AS "jobId", q.quote_number AS "quoteNumber", q.revision`,
    [input.tenantId, input.quoteId ?? null],
  );
  for (const quote of result.rows) {
    await recordAudit(client, {
      tenantId: input.tenantId,
      actorType: 'system',
      actorId: null,
      action: 'quote.expired',
      entityType: 'quote',
      entityId: quote.id,
      requestId: input.requestId,
      metadata: { quoteNumber: quote.quoteNumber, revision: quote.revision },
    });
    await recordJobEvent(client, {
      tenantId: input.tenantId,
      jobId: quote.jobId,
      type: 'quote_expired',
      actorType: 'system',
      actorId: null,
      summary: `Quote ${quote.quoteNumber} expired without a decision`,
      metadata: { quoteId: quote.id, revision: quote.revision },
    });
  }
  return result.rows;
}
