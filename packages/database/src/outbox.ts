import { randomUUID } from 'node:crypto';
import type { Queryable } from './db.js';

export interface OutboxEventInput {
  tenantId: string;
  /** Becomes the job-queue task kind when dispatched, e.g. "accounting.post_invoice". */
  topic: string;
  /** Identifiers only. Never message bodies, prompts, credentials or provider responses. */
  payload: Record<string, unknown>;
  /** Unique per tenant: writing the same key twice records one event (ADR 0012). */
  dedupeKey: string;
}

/**
 * Record an outbox event inside the caller's transaction, so the business change and the work
 * it implies commit (or roll back) together. A dispatcher later copies it into the job queue.
 */
export async function writeOutboxEvent(
  client: Queryable,
  input: OutboxEventInput,
): Promise<{ id: string; created: boolean }> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO event_outbox(id,tenant_id,topic,payload,dedupe_key) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id,dedupe_key) DO NOTHING RETURNING id`,
    [randomUUID(), input.tenantId, input.topic, JSON.stringify(input.payload), input.dedupeKey],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM event_outbox WHERE tenant_id=$1 AND dedupe_key=$2',
    [input.tenantId, input.dedupeKey],
  );
  return { id: existing.rows[0]!.id, created: false };
}
