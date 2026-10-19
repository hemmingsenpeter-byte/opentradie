import { randomUUID } from 'node:crypto';
import type { Queryable } from './db.js';

export const JOB_EVENT_TYPES = [
  'created',
  'status_changed',
  'details_updated',
  'property_changed',
  'note_added',
  'evidence_added',
  'quote_drafted',
  'quote_updated',
  'quote_approved',
  'quote_rejected',
  'quote_sent',
  'quote_accepted',
  'quote_declined',
  'quote_expired',
  'quote_revised',
] as const;
export type JobEventType = (typeof JOB_EVENT_TYPES)[number];

export interface JobEventInput {
  tenantId: string;
  jobId: string;
  type: JobEventType;
  actorType: 'user' | 'system' | 'agent' | 'customer';
  actorId: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  /** Short, generic description. Never message bodies, prompts or credentials. */
  summary: string;
  /** Identifiers, counts and decisions only. */
  metadata?: Record<string, unknown>;
  /** Only for seeds and imports that record history; defaults to the database clock. */
  createdAt?: string | Date | null;
}

/**
 * Append one row to a job's timeline. Call it inside the same transaction as the job mutation
 * so the history can never disagree with the record. The table rejects UPDATE and DELETE.
 */
export async function recordJobEvent(client: Queryable, input: JobEventInput): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO job_events(id,tenant_id,job_id,type,actor_type,actor_id,from_status,to_status,summary,metadata,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11::timestamptz, clock_timestamp()))`,
    [
      id,
      input.tenantId,
      input.jobId,
      input.type,
      input.actorType,
      input.actorId,
      input.fromStatus ?? null,
      input.toStatus ?? null,
      input.summary,
      JSON.stringify(input.metadata ?? {}),
      input.createdAt ?? null,
    ],
  );
  return id;
}
