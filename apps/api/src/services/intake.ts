import { randomUUID } from 'node:crypto';
import { knowledge, recordJobEvent, type Queryable, type Transaction } from '@opentradie/database';
import type { PostgresJobQueue } from '@opentradie/platform';

/**
 * Deterministic intake services shared by POST /api/enquiries, POST /api/customers, the inbox
 * pipeline and the `customer.create` / `job.create` proposal executors, so a customer or job is
 * created the same way whichever path it came from. Callers own the transaction and the audit
 * events.
 */

export interface Actor {
  type: 'user' | 'system' | 'agent';
  id: string | null;
}

export async function createCustomerRecord(
  client: Queryable,
  input: {
    tenantId: string;
    name: string;
    preferredName?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await client.query(
    'INSERT INTO customers(id,tenant_id,name,preferred_name,email,phone,address) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      id,
      input.tenantId,
      input.name,
      input.preferredName ?? null,
      input.email ?? null,
      input.phone ?? null,
      input.address ?? null,
    ],
  );
  return id;
}

/**
 * A job proposed from an enquiry. Without an explicit `property`, the job site is linked only
 * when the customer has exactly one active property; with several, the owner picks one rather
 * than the system guessing. An explicit `property` (already checked to belong to the customer)
 * or `null` (no site) skips the inference.
 */
export async function createEnquiryJob(
  client: Queryable,
  input: {
    tenantId: string;
    customerId: string;
    title: string;
    description: string | null;
    status: 'new' | 'quoted';
    origin: 'assistant_proposed' | 'email';
    actor: Actor;
    eventSummary: string;
    eventMetadata: Record<string, unknown>;
    property?: { id: string; address: string | null } | null;
  },
): Promise<string> {
  const jobId = randomUUID();
  if (input.property !== undefined) {
    await client.query(
      'INSERT INTO jobs(id,tenant_id,customer_id,title,description,status,site_address,property_id,origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        jobId,
        input.tenantId,
        input.customerId,
        input.title.slice(0, 300),
        input.description,
        input.status,
        input.property?.address ?? null,
        input.property?.id ?? null,
        input.origin,
      ],
    );
  } else {
    await insertWithInferredSite(client, jobId, input);
  }
  await recordJobEvent(client, {
    tenantId: input.tenantId,
    jobId,
    type: 'created',
    actorType: input.actor.type,
    actorId: input.actor.id,
    toStatus: input.status,
    summary: input.eventSummary,
    metadata: { origin: input.origin, ...input.eventMetadata },
  });
  return jobId;
}

async function insertWithInferredSite(
  client: Queryable,
  jobId: string,
  input: {
    tenantId: string;
    customerId: string;
    title: string;
    description: string | null;
    status: string;
    origin: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO jobs(id,tenant_id,customer_id,title,description,status,site_address,property_id,origin)
     SELECT $1,$2,$3,$4,$5,$6,coalesce(site.address,c.address),site.id,$7
     FROM customers c
     LEFT JOIN LATERAL (
       SELECT max(p.id::text)::uuid AS id,
         max(concat_ws(', ', p.address_line1, p.address_line2, p.suburb, nullif(concat_ws(' ', p.city, p.postcode), ''))) AS address
       FROM properties p WHERE p.tenant_id=c.tenant_id AND p.customer_id=c.id AND p.archived_at IS NULL
       HAVING count(*) = 1
     ) site ON true
     WHERE c.tenant_id=$2 AND c.id=$3`,
    [
      jobId,
      input.tenantId,
      input.customerId,
      input.title.slice(0, 300),
      input.description,
      input.status,
      input.origin,
    ],
  );
}

/**
 * Index an inbound message as a knowledge item and queue its embedding (the embedding task
 * applies the privacy policy). The content is stored, never logged.
 */
export async function indexCommunication(
  client: Transaction,
  queue: PostgresJobQueue,
  input: {
    tenantId: string;
    communicationId: string;
    customerId: string | null;
    jobId: string | null;
    content: string;
  },
): Promise<string> {
  const knowledgeId = await knowledge(
    client,
    input.tenantId,
    input.customerId,
    input.jobId,
    'communication',
    input.communicationId,
    input.content,
  );
  await queue.enqueue(
    {
      tenantId: input.tenantId,
      kind: 'knowledge.embed',
      payload: { knowledgeItemId: knowledgeId },
      idempotencyKey: `embed:${knowledgeId}`,
    },
    client,
  );
  return knowledgeId;
}
