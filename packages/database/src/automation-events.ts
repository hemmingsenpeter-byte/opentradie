import { randomUUID } from 'node:crypto';
import {
  AUTOMATION_EVENT_TOPIC,
  type AutomationEventName,
  type AutomationEventRefs,
} from '@opentradie/core';
import type { Queryable } from './db.js';

/** Transaction-local settings the engine sets while it executes a run (loop guard, ADR 0033). */
export const AUTOMATION_DEPTH_SETTING = 'opentradie.automation_depth';
export const AUTOMATION_ID_SETTING = 'opentradie.automation_id';

export interface AutomationEventInput {
  tenantId: string;
  event: AutomationEventName;
  refs: AutomationEventRefs;
  /** Enums and small integers only (see AUTOMATION_EVENT_DATA). */
  data?: Record<string, unknown>;
  /** Unique per occurrence, e.g. `jobevent:<id>` or `tick:invoice:<id>:<date>`. */
  occurrence: string;
}

/**
 * Record a domain event for automations in the caller's transaction, through the existing
 * outbox (ADR 0012): the business change and its event commit or roll back together, and the
 * outbox dedupe key makes a replayed write one event. The payload nests identifiers under
 * `refs` and carries the automation depth of the emitting transaction for the loop guard.
 */
export async function emitAutomationEvent(
  client: Queryable,
  input: AutomationEventInput,
): Promise<void> {
  await client.query(
    `INSERT INTO event_outbox(id,tenant_id,topic,payload,dedupe_key)
     VALUES($1,$2,$3,
       jsonb_build_object('event',$4::text,'refs',$5::jsonb,'data',$6::jsonb,'occurrence',$7::text,
         'occurredAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'depth',coalesce(nullif(current_setting('${AUTOMATION_DEPTH_SETTING}', true),'')::int,0),
         'sourceAutomationId',nullif(current_setting('${AUTOMATION_ID_SETTING}', true),'')),
       $8)
     ON CONFLICT (tenant_id,dedupe_key) DO NOTHING`,
    [
      randomUUID(),
      input.tenantId,
      AUTOMATION_EVENT_TOPIC,
      input.event,
      JSON.stringify(input.refs),
      JSON.stringify(input.data ?? {}),
      input.occurrence,
      `ae:${input.event}:${input.occurrence}`.slice(0, 200),
    ],
  );
}
