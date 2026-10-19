import { randomUUID } from 'node:crypto';
import type { Queryable } from './db.js';

export interface AuditInput {
  tenantId: string;
  actorType: 'user' | 'system' | 'agent';
  actorId: string | null;
  action: string;
  entityType?: string;
  entityId?: string | null;
  requestId: string;
  /** Identifiers, counts and decisions only. Never message bodies, prompts or credentials. */
  metadata?: Record<string, unknown>;
}

export async function recordAudit(client: Queryable, input: AuditInput): Promise<void> {
  await client.query(
    'INSERT INTO audit_events(id,tenant_id,actor_type,actor_id,action,entity_type,entity_id,request_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [randomUUID(), input.tenantId, input.actorType, input.actorId, input.action, input.entityType ?? null, input.entityId ?? null, input.requestId, JSON.stringify(input.metadata ?? {})],
  );
}
