import { randomUUID } from 'node:crypto';
import {
  decideModelUse,
  embedWithPolicy,
  type EmbeddingProvider,
  type PrivacyMode,
} from '@opentradie/core';
import { expireLapsedQuotes, recordAudit, transaction } from '@opentradie/database';
import { PermanentTaskError, type PostgresJobQueue, type TaskHandler } from './job-queue.js';
import { relayEnvelopeSchema } from './relay.js';
import { createReminderHandlers } from './reminders.js';

/** Background task handlers. Each is idempotent because the queue delivers at least once. */
export function createTaskHandlers(options: {
  queue: PostgresJobQueue;
  privacyMode: PrivacyMode;
  embeddingProvider: EmbeddingProvider | null;
}): Record<string, TaskHandler> {
  return {
    // Scheduled for the moment a sent quote's validity ends. Expires that quote (or, without a
    // quoteId, every lapsed sent quote of the tenant) unless it was decided or revised first.
    'quote.expire': async (task, { db }) => {
      const quoteId = typeof task.payload.quoteId === 'string' ? task.payload.quoteId : null;
      if (quoteId !== null && !/^[0-9a-f-]{36}$/i.test(quoteId))
        throw new PermanentTaskError('Invalid quote id.');
      await transaction(db, (client) =>
        expireLapsedQuotes(client, {
          tenantId: task.tenantId,
          quoteId,
          requestId: `task:${task.id}`,
        }),
      );
    },

    ...createReminderHandlers(),
    'relay.process': async (task, { db }) => {
      const inboxId = String(task.payload.inboxId ?? '');
      await transaction(db, async (client) => {
        const row = await client.query<{ payload: unknown; status: string }>(
          'SELECT payload,status FROM relay_inbox WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
          [task.tenantId, inboxId],
        );
        if (!row.rows[0]) throw new PermanentTaskError('Relay event not found for this tenant.');
        if (row.rows[0].status === 'processed') return;
        const envelope = relayEnvelopeSchema.parse(row.rows[0].payload);
        if (envelope.tenantId !== task.tenantId)
          throw new PermanentTaskError('Relay event tenant mismatch.');
        const customer = await client.query<{ id: string }>(
          'SELECT id FROM customers WHERE tenant_id=$1 AND lower(email)=lower($2) AND archived_at IS NULL',
          [task.tenantId, envelope.payload.from],
        );
        const customerId = customer.rows.length === 1 ? customer.rows[0]!.id : null;
        const communicationId = randomUUID();
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO communications(id,tenant_id,customer_id,direction,channel,status,sender,subject,text,external_reference,created_at)
           VALUES($1,$2,$3,'inbound','mock','received',$4,$5,$6,$7,$8)
           ON CONFLICT (tenant_id,channel,external_reference) WHERE external_reference IS NOT NULL DO NOTHING RETURNING id`,
          [
            communicationId,
            task.tenantId,
            customerId,
            envelope.payload.from,
            envelope.payload.subject ?? null,
            envelope.payload.text,
            `${envelope.source}:${envelope.eventId}`,
            envelope.occurredAt,
          ],
        );
        if (inserted.rows[0]) {
          const knowledgeId = randomUUID();
          await client.query(
            "INSERT INTO knowledge_items(id,tenant_id,customer_id,source_type,source_id,source_created_at,content,provenance) VALUES($1,$2,$3,'communication',$4,$5,$6,'user_supplied')",
            [
              knowledgeId,
              task.tenantId,
              customerId,
              communicationId,
              envelope.occurredAt,
              envelope.payload.text,
            ],
          );
          await options.queue.enqueue(
            {
              tenantId: task.tenantId,
              kind: 'knowledge.embed',
              payload: { knowledgeItemId: knowledgeId },
              idempotencyKey: `embed:${knowledgeId}`,
            },
            client,
          );
          await recordAudit(client, {
            tenantId: task.tenantId,
            actorType: 'system',
            actorId: null,
            action: 'communication.received',
            entityType: 'communication',
            entityId: communicationId,
            requestId: `task:${task.id}`,
            metadata: { source: envelope.source, matchedCustomer: customerId !== null },
          });
        }
        await client.query(
          "UPDATE relay_inbox SET status='processed', processed_at=now() WHERE tenant_id=$1 AND id=$2",
          [task.tenantId, inboxId],
        );
      });
    },

    'knowledge.embed': async (task, { db }) => {
      const id = String(task.payload.knowledgeItemId ?? '');
      const item = await db.pool.query<{
        content: string;
        embedding_status: string;
        source_type: string;
      }>(
        'SELECT content, embedding_status, source_type FROM knowledge_items WHERE tenant_id=$1 AND id=$2',
        [task.tenantId, id],
      );
      const row = item.rows[0];
      if (!row) throw new PermanentTaskError('Knowledge item not found for this tenant.');
      if (row.embedding_status === 'embedded') return;
      const setStatus = (status: string) =>
        db.pool.query(
          'UPDATE knowledge_items SET embedding_status=$3 WHERE tenant_id=$1 AND id=$2',
          [task.tenantId, id, status],
        );
      if (!options.embeddingProvider) return void (await setStatus('not_configured'));
      const context = {
        mode: options.privacyMode,
        dataCategories: [
          row.source_type === 'job_note' ? ('job_notes' as const) : ('communication_text' as const),
        ],
      };
      // The privacy decision comes first, independent of storage capability, and is always recorded.
      const decision = decideModelUse({
        ...context,
        purpose: 'knowledge_embedding',
        destination: options.embeddingProvider.destination,
      });
      if (!decision.allowed) {
        await setStatus('policy_denied');
        await recordAudit(db.pool, {
          tenantId: task.tenantId,
          actorType: 'system',
          actorId: null,
          action: 'model.policy_denied',
          entityType: 'knowledge_item',
          entityId: id,
          requestId: `task:${task.id}`,
          metadata: {
            purpose: 'knowledge_embedding',
            reason: decision.reason,
            provider: decision.destination.provider,
            mode: decision.mode,
          },
        });
        // Denial is final: no retry, no fallback provider.
        throw new PermanentTaskError('Embedding blocked by privacy policy.');
      }
      const table = await db.pool.query<{ name: string | null }>(
        "SELECT to_regclass('public.knowledge_embeddings') AS name",
      );
      if (!table.rows[0]!.name) return void (await setStatus('unsupported'));
      const { vectors } = await embedWithPolicy(context, options.embeddingProvider, [row.content]);
      await transaction(db, async (client) => {
        await client.query(
          'INSERT INTO knowledge_embeddings(tenant_id,knowledge_item_id,provider,dimensions,embedding) VALUES($1,$2,$3,$4,$5::vector) ON CONFLICT (tenant_id,knowledge_item_id) DO NOTHING',
          [
            task.tenantId,
            id,
            decision.destination.provider,
            vectors[0]!.length,
            `[${vectors[0]!.join(',')}]`,
          ],
        );
        await client.query(
          "UPDATE knowledge_items SET embedding_status='embedded' WHERE tenant_id=$1 AND id=$2",
          [task.tenantId, id],
        );
      });
    },
  };
}
