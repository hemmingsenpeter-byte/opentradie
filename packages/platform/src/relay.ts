import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '@opentradie/database';
import { transaction } from '@opentradie/database';
import type { PostgresJobQueue } from './job-queue.js';

/**
 * Relay contract (version 1). A relay is not an agent: it authenticates, deduplicates and
 * forwards external events to the one authoritative runtime, which re-validates everything.
 */
export const relayEnvelopeSchema = z
  .object({
    version: z.literal(1),
    tenantId: z.string().uuid(),
    source: z.enum(['mock_email', 'mock_sms', 'test_webhook']),
    eventId: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
    eventType: z.enum(['message.received']),
    occurredAt: z.string().datetime({ offset: true }),
    payload: z
      .object({
        from: z.string().min(1).max(254),
        subject: z.string().max(300).optional(),
        text: z.string().min(1).max(20_000),
      })
      .strict(),
  })
  .strict();
export type RelayEnvelope = z.infer<typeof relayEnvelopeSchema>;

export const RELAY_SIGNATURE_HEADER = 'x-opentradie-signature';

export function signRelayBody(rawBody: string, secret: string, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex');
  return `t=${timestampSeconds},v1=${digest}`;
}

export function verifyRelaySignature(rawBody: string, header: string | undefined, secret: string, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): boolean {
  const match = /^t=(\d{1,12}),v1=([a-f0-9]{64})$/.exec(header ?? '');
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(match[2]!, 'hex'));
}

export type ReceiveResult = { status: 'accepted' | 'duplicate'; inboxId: string } | { status: 'conflict' };

/** Runtime side: store once, enqueue processing once. Duplicate deliveries are acknowledged, not reprocessed. */
export async function receiveRelayEvent(db: Database, queue: PostgresJobQueue, envelope: RelayEnvelope): Promise<ReceiveResult> {
  const payloadSha256 = createHash('sha256').update(JSON.stringify(envelope.payload)).digest('hex');
  return transaction(db, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO relay_inbox(id,tenant_id,source,external_event_id,event_type,payload_sha256,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,source,external_event_id) DO NOTHING RETURNING id`,
      [randomUUID(), envelope.tenantId, envelope.source, envelope.eventId, envelope.eventType, payloadSha256, JSON.stringify(envelope)],
    );
    if (!inserted.rows[0]) {
      const existing = await client.query<{ id: string; payload_sha256: string }>(
        'SELECT id,payload_sha256 FROM relay_inbox WHERE tenant_id=$1 AND source=$2 AND external_event_id=$3',
        [envelope.tenantId, envelope.source, envelope.eventId],
      );
      const row = existing.rows[0]!;
      return row.payload_sha256 === payloadSha256 ? { status: 'duplicate', inboxId: row.id } : { status: 'conflict' };
    }
    const inboxId = inserted.rows[0].id;
    await queue.enqueue({ tenantId: envelope.tenantId, kind: 'relay.process', payload: { inboxId }, idempotencyKey: `relay:${inboxId}` }, client);
    return { status: 'accepted', inboxId };
  });
}

export interface RelayTransportResponse {
  status: number;
}
export type RelayTransport = (request: { body: string; headers: Record<string, string> }) => Promise<RelayTransportResponse>;

/**
 * Relay side: outbound delivery to the authoritative runtime with bounded exponential retry.
 * The same event id is re-sent on every attempt, so the runtime's dedupe makes delivery idempotent.
 */
export async function forwardRelayEvent(
  envelope: RelayEnvelope,
  options: { transport: RelayTransport; secret: string; maxAttempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<{ delivered: boolean; attempts: number; lastStatus: number | null }> {
  const body = JSON.stringify(relayEnvelopeSchema.parse(envelope));
  const maxAttempts = options.maxAttempts ?? 5;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastStatus: number | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await options.transport({
        body,
        headers: { 'content-type': 'application/json', [RELAY_SIGNATURE_HEADER]: signRelayBody(body, options.secret) },
      });
      lastStatus = response.status;
      if (response.status >= 200 && response.status < 300) return { delivered: true, attempts: attempt, lastStatus };
      // Client errors other than throttling will not succeed on retry.
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        return { delivered: false, attempts: attempt, lastStatus };
      }
    } catch {
      lastStatus = null; // network failure or runtime offline: retry
    }
    if (attempt < maxAttempts) await sleep((options.baseDelayMs ?? 500) * 2 ** (attempt - 1));
  }
  return { delivered: false, attempts: maxAttempts, lastStatus };
}
