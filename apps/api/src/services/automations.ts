/**
 * Automations engine (ADR 0033). Definitions are data, validated by packages/core/src/automations.ts.
 * The engine is deterministic: an `automation.event` task (dispatched from the outbox) matches
 * enabled automations, evaluates their conditions against current records, and schedules a run;
 * the `automation.run` task re-evaluates when due and turns each action into an ordinary action
 * proposal (source `automation`) through createProposal, so the tool registry, price-field refusal
 * and approval policy apply exactly as for the AI operator. No model is called at run time.
 */
import { randomUUID } from 'node:crypto';
import {
  actionApproval,
  addLocalDays,
  AUTOMATION_EVENTS,
  automationDueAt,
  automationEventEnvelopeSchema,
  evaluateCondition,
  instantToLocal,
  localTimeToInstant,
  MAX_AUTOMATION_DEPTH,
  parseToolCall,
  renderTemplate,
  scheduleOccurrence,
  summariseAutomation,
  validateAutomation,
  type AutomationAction,
  type AutomationDefinition,
  type AutomationEventEnvelope,
  type AutomationEventName,
  type AutomationEventRefs,
  type AutomationFacts,
  type PlaceholderValues,
  type ToolName,
} from '@opentradie/core';
import {
  AUTOMATION_DEPTH_SETTING,
  AUTOMATION_ID_SETTING,
  emitAutomationEvent,
  recordAudit,
  transaction,
  type AutomationRunStatus,
  type AutomationSource,
  type Database,
  type Queryable,
} from '@opentradie/database';
import { PermanentTaskError, type PostgresJobQueue, type TaskHandler } from '@opentradie/platform';
import { HttpError, iso } from '../http.js';
import { approvalPolicyFor, createProposal } from '../tools/proposals.js';

export const AUTOMATION_EVENT_KIND = 'automation.event';
export const AUTOMATION_RUN_KIND = 'automation.run';
export const AUTOMATION_TICK_KIND = 'automation.tick';
const HOUR_MS = 3_600_000;

// ------------------------------------------------------------------ records

export interface AutomationRecord {
  id: string;
  name: string;
  definition: AutomationDefinition;
  version: number;
  enabled: boolean;
  source: AutomationSource;
  templateKey: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lastRunAt: Date | null;
  lastRunStatus: AutomationRunStatus | null;
}

const COLUMNS = `a.id,a.name,a.definition,a.version,a.enabled,a.source,a.template_key AS "templateKey",
  a.approved_at AS "approvedAt",a.created_at AS "createdAt",a.updated_at AS "updatedAt",
  r.created_at AS "lastRunAt",r.status AS "lastRunStatus"`;
const FROM = `automations a LEFT JOIN LATERAL (
    SELECT created_at,status FROM automation_runs WHERE tenant_id=a.tenant_id AND automation_id=a.id
    ORDER BY created_at DESC LIMIT 1) r ON true`;

export function automationDto(row: AutomationRecord) {
  return {
    id: row.id,
    name: row.name,
    definition: row.definition,
    summary: summariseAutomation(row.definition),
    trigger: row.definition.trigger.event,
    version: row.version,
    enabled: row.enabled,
    source: row.source,
    templateKey: row.templateKey,
    approvedAt: iso(row.approvedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    lastRun: row.lastRunAt ? { at: iso(row.lastRunAt), status: row.lastRunStatus } : null,
  };
}

export async function listAutomations(client: Queryable, tenantId: string) {
  const result = await client.query<AutomationRecord>(
    `SELECT ${COLUMNS} FROM ${FROM} WHERE a.tenant_id=$1 AND a.deleted_at IS NULL ORDER BY a.created_at`,
    [tenantId],
  );
  return result.rows.map(automationDto);
}

export async function getAutomation(
  client: Queryable,
  tenantId: string,
  id: string,
  lock = false,
): Promise<AutomationRecord> {
  const result = await client.query<AutomationRecord>(
    lock
      ? `SELECT a.id,a.name,a.definition,a.version,a.enabled,a.source FROM automations a WHERE a.tenant_id=$1 AND a.id=$2 AND a.deleted_at IS NULL FOR UPDATE`
      : `SELECT ${COLUMNS} FROM ${FROM} WHERE a.tenant_id=$1 AND a.id=$2 AND a.deleted_at IS NULL`,
    [tenantId, id],
  );
  if (!result.rows[0]) throw new HttpError(404, 'AUTOMATION_NOT_FOUND', 'Automation not found.');
  return result.rows[0];
}

/** Drop any auto-approval from a definition the AI operator wrote: only the owner may enable it. */
export function agentSafeDefinition(definition: AutomationDefinition): AutomationDefinition {
  return {
    ...definition,
    actions: definition.actions.map((action) => {
      const { approval: _approval, ...rest } = action;
      return rest as AutomationAction;
    }),
  };
}

export function parseDefinition(input: unknown): AutomationDefinition {
  const checked = validateAutomation(input);
  if (!checked.ok)
    throw new HttpError(400, 'VALIDATION_ERROR', 'The automation definition is invalid.', {
      issues: checked.errors,
    });
  return checked.definition;
}

export async function createAutomation(
  client: Queryable,
  input: {
    tenantId: string;
    requestId: string;
    actorId: string;
    definition: AutomationDefinition;
    source: AutomationSource;
    enabled: boolean;
    templateKey?: string | null;
    proposalId?: string | null;
  },
): Promise<{ id: string }> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO automations(id,tenant_id,name,definition,trigger_event,enabled,source,template_key,created_by,
       approved_by,approved_at,proposal_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,now(),$10)`,
    [
      id,
      input.tenantId,
      input.definition.name,
      JSON.stringify(input.definition),
      input.definition.trigger.event,
      input.enabled,
      input.source,
      input.templateKey ?? null,
      input.actorId,
      input.proposalId ?? null,
    ],
  );
  await recordAudit(client, {
    tenantId: input.tenantId,
    actorType: 'user',
    actorId: input.actorId,
    action: 'automation.created',
    entityType: 'automation',
    entityId: id,
    requestId: input.requestId,
    metadata: {
      source: input.source,
      trigger: input.definition.trigger.event,
      tools: input.definition.actions.map((action) => action.tool),
      enabled: input.enabled,
      ...(input.proposalId ? { proposalId: input.proposalId } : {}),
    },
  });
  return { id };
}

export async function updateAutomation(
  client: Queryable,
  input: {
    tenantId: string;
    requestId: string;
    actorId: string;
    id: string;
    version: number;
    definition?: AutomationDefinition;
    enabled?: boolean;
    deleted?: boolean;
  },
): Promise<void> {
  const current = await getAutomation(client, input.tenantId, input.id, true);
  if (current.version !== input.version)
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'This automation was changed elsewhere. Reload it.',
    );
  const definition = input.definition ?? current.definition;
  const enabled = input.deleted ? false : (input.enabled ?? current.enabled);
  await client.query(
    `UPDATE automations SET name=$3,definition=$4,trigger_event=$5,enabled=$6,version=version+1,updated_at=now(),
       approved_by=CASE WHEN $8 THEN $7::uuid ELSE approved_by END,
       approved_at=CASE WHEN $8 THEN now() ELSE approved_at END,
       deleted_at=CASE WHEN $9 THEN now() ELSE NULL END
     WHERE tenant_id=$1 AND id=$2`,
    [
      input.tenantId,
      input.id,
      definition.name,
      JSON.stringify(definition),
      definition.trigger.event,
      enabled,
      input.actorId,
      Boolean(input.definition) || (enabled && !current.enabled),
      input.deleted === true,
    ],
  );
  await recordAudit(client, {
    tenantId: input.tenantId,
    actorType: 'user',
    actorId: input.actorId,
    action: input.deleted
      ? 'automation.deleted'
      : input.definition
        ? 'automation.updated'
        : enabled
          ? 'automation.enabled'
          : 'automation.disabled',
    entityType: 'automation',
    entityId: input.id,
    requestId: input.requestId,
    metadata: { version: current.version + 1, enabled },
  });
}

export async function listRuns(client: Queryable, tenantId: string, automationId: string) {
  await getAutomation(client, tenantId, automationId);
  const result = await client.query<{
    id: string;
    automationVersion: number;
    event: string;
    entityType: string;
    entityId: string;
    jobId: string | null;
    status: AutomationRunStatus;
    scheduledFor: Date;
    finishedAt: Date | null;
    proposalIds: string[];
    outcomeCode: string | null;
    createdAt: Date;
  }>(
    `SELECT id,automation_version AS "automationVersion",event,entity_type AS "entityType",entity_id AS "entityId",
       job_id AS "jobId",status,scheduled_for AS "scheduledFor",finished_at AS "finishedAt",
       proposal_ids AS "proposalIds",outcome_code AS "outcomeCode",created_at AS "createdAt"
     FROM automation_runs WHERE tenant_id=$1 AND automation_id=$2 ORDER BY created_at DESC LIMIT 50`,
    [tenantId, automationId],
  );
  return result.rows.map((row) => ({
    ...row,
    scheduledFor: iso(row.scheduledFor),
    finishedAt: iso(row.finishedAt),
    createdAt: iso(row.createdAt),
  }));
}

/** Recent automation events (identifiers and enums only) for the dry-run picker. */
export async function recentEvents(client: Queryable, tenantId: string, event?: string) {
  const result = await client.query<{ id: string; payload: AutomationEventEnvelope }>(
    `SELECT id,payload FROM event_outbox WHERE tenant_id=$1 AND topic='automation.event'
       AND ($2::text IS NULL OR payload->>'event'=$2) ORDER BY created_at DESC LIMIT 20`,
    [tenantId, event ?? null],
  );
  return result.rows.map((row) => ({
    id: row.id,
    event: row.payload.event,
    refs: row.payload.refs,
    data: row.payload.data,
    occurredAt: row.payload.occurredAt,
  }));
}

// ------------------------------------------------------------------ facts

interface Business {
  name: string;
  timeZone: string;
  locale: string;
}

async function loadBusinessBasics(client: Queryable, tenantId: string): Promise<Business> {
  const result = await client.query<Business>(
    'SELECT name,time_zone AS "timeZone",locale FROM businesses WHERE id=$1',
    [tenantId],
  );
  if (!result.rows[0]) throw new PermanentTaskError('Business not found.');
  return result.rows[0];
}

export interface EventContext {
  facts: AutomationFacts;
  placeholders: PlaceholderValues;
  jobId: string | null;
  customerId: string | null;
  /** False when a referenced record no longer exists (e.g. erased): the run is skipped. */
  found: boolean;
}

/** Current facts about the records an event refers to, read tenant-scoped. */
export async function loadEventContext(
  client: Queryable,
  tenantId: string,
  envelope: Pick<AutomationEventEnvelope, 'refs' | 'data'>,
  business: Business,
  nowMs: number,
): Promise<EventContext> {
  const refs: AutomationEventRefs = { ...envelope.refs };
  const facts: AutomationFacts = {};
  const placeholders: PlaceholderValues = { 'business.name': business.name };
  let found = true;
  const data = envelope.data as Record<string, unknown>;
  for (const key of ['from', 'to', 'daysOverdue', 'daysUntil', 'channel'] as const)
    if (typeof data[key] === 'string' || typeof data[key] === 'number')
      facts[`event.${key}`] = data[key] as string | number;
  const one = async <T>(sql: string, id: string | undefined): Promise<T | null> => {
    if (!id) return null;
    const row = (await client.query<T & Record<string, unknown>>(sql, [tenantId, id])).rows[0];
    if (!row) found = false;
    return row ?? null;
  };

  const quote = await one<{ jobId: string; number: string; status: string; totalCents: number }>(
    'SELECT job_id AS "jobId",quote_number AS number,status,total_cents AS "totalCents" FROM quotes WHERE tenant_id=$1 AND id=$2',
    refs.quoteId,
  );
  if (quote) {
    refs.jobId ??= quote.jobId;
    facts['quote.totalCents'] = Number(quote.totalCents);
    facts['quote.status'] = quote.status;
    placeholders['quote.number'] = quote.number;
  }
  const appointment = await one<{ jobId: string; status: string; startsAt: Date }>(
    'SELECT job_id AS "jobId",status,starts_at AS "startsAt" FROM appointments WHERE tenant_id=$1 AND id=$2',
    refs.appointmentId,
  );
  if (appointment) {
    refs.jobId ??= appointment.jobId;
    facts['appointment.status'] = appointment.status;
    try {
      placeholders['appointment.date'] = new Intl.DateTimeFormat(business.locale, {
        timeZone: business.timeZone,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }).format(appointment.startsAt);
      placeholders['appointment.time'] = new Intl.DateTimeFormat(business.locale, {
        timeZone: business.timeZone,
        hour: 'numeric',
        minute: '2-digit',
      }).format(appointment.startsAt);
    } catch {
      placeholders['appointment.date'] = appointment.startsAt.toISOString().slice(0, 10);
    }
  }
  const invoice = await one<{ jobId: string; number: string; status: string; dueDate: string }>(
    `SELECT job_id AS "jobId",invoice_number AS number,status,to_char(due_date,'YYYY-MM-DD') AS "dueDate"
     FROM invoices WHERE tenant_id=$1 AND id=$2`,
    refs.invoiceId,
  );
  if (invoice) {
    refs.jobId ??= invoice.jobId;
    facts['invoice.status'] = invoice.status;
    placeholders['invoice.number'] = invoice.number;
    const today = instantToLocal(nowMs, business.timeZone).date;
    const overdue = Math.round((Date.parse(today) - Date.parse(invoice.dueDate)) / 86_400_000);
    facts['invoice.daysOverdue'] =
      ['posted', 'part_paid'].includes(invoice.status) && overdue > 0 ? overdue : 0;
  }
  const communication = await one<{ jobId: string | null; customerId: string | null }>(
    'SELECT job_id AS "jobId",customer_id AS "customerId" FROM communications WHERE tenant_id=$1 AND id=$2',
    refs.communicationId,
  );
  if (communication) {
    refs.jobId ??= communication.jobId ?? undefined;
    refs.customerId ??= communication.customerId ?? undefined;
  }
  const task = await one<{ jobId: string | null; customerId: string | null; kind: string }>(
    'SELECT job_id AS "jobId",customer_id AS "customerId",kind FROM tasks WHERE tenant_id=$1 AND id=$2',
    refs.taskId,
  );
  if (task) {
    refs.jobId ??= task.jobId ?? undefined;
    refs.customerId ??= task.customerId ?? undefined;
    facts['task.kind'] = task.kind;
  }
  const job = await one<{
    customerId: string;
    title: string;
    status: string;
    hasSite: boolean;
  }>(
    `SELECT customer_id AS "customerId",title,status,(property_id IS NOT NULL OR site_address IS NOT NULL) AS "hasSite"
     FROM jobs WHERE tenant_id=$1 AND id=$2`,
    refs.jobId,
  );
  if (job) {
    refs.customerId ??= job.customerId;
    facts['job.title'] = job.title;
    facts['job.status'] = job.status;
    facts['job.hasSite'] = job.hasSite ? 'yes' : 'no';
    placeholders['job.title'] = job.title;
  }
  const customer = await one<{ name: string; preferredName: string | null; email: string | null }>(
    `SELECT name,preferred_name AS "preferredName",email FROM customers
     WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL`,
    refs.customerId,
  );
  if (customer) {
    facts['customer.name'] = customer.name;
    facts['customer.hasEmail'] = customer.email ? 'yes' : 'no';
    placeholders['customer.name'] = customer.name;
    placeholders['customer.firstName'] =
      customer.preferredName?.trim() || customer.name.trim().split(/\s+/)[0] || null;
  }
  return {
    facts,
    placeholders,
    jobId: refs.jobId ?? null,
    customerId: refs.customerId ?? null,
    found,
  };
}

// ------------------------------------------------------------------ actions → tool calls

/** The registry tool call an action becomes, fully bound and rendered. Not yet validated. */
export function bindAction(
  action: AutomationAction,
  context: EventContext,
  business: Business,
  nowMs: number,
): { tool: ToolName; args: Record<string, unknown> } | { skip: string } {
  const render = (text: string) => renderTemplate(text, context.placeholders);
  const today = instantToLocal(nowMs, business.timeZone).date;
  const nineAm = (days: number) =>
    new Date(
      localTimeToInstant(addLocalDays(today, days), 9 * 60, business.timeZone),
    ).toISOString();
  const links = {
    ...(context.jobId ? { jobId: context.jobId } : {}),
    ...(context.customerId ? { customerId: context.customerId } : {}),
  };
  switch (action.tool) {
    case 'task.create':
      return {
        tool: 'task.create',
        args: {
          kind: action.kind ?? 'custom',
          title: render(action.title),
          ...(action.notes ? { notes: render(action.notes) } : {}),
          ...(action.priority ? { priority: action.priority } : {}),
          ...(action.dueInDays !== undefined ? { dueAt: nineAm(action.dueInDays) } : {}),
          ...links,
        },
      };
    case 'communication.draft':
      if (!context.customerId) return { skip: 'no_customer' };
      return {
        tool: 'communication.draft',
        args: {
          ...links,
          channel: action.channel,
          ...(action.subject ? { subject: render(action.subject) } : {}),
          text: render(action.text),
        },
      };
    case 'schedule.propose': {
      if (!context.jobId) return { skip: 'no_job' };
      const [hours, minutes] = action.at.split(':').map(Number) as [number, number];
      const start = localTimeToInstant(
        addLocalDays(today, action.inDays),
        hours * 60 + minutes,
        business.timeZone,
      );
      return {
        tool: 'schedule.propose',
        args: {
          jobId: context.jobId,
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(start + action.durationMinutes * 60_000).toISOString(),
          ...(action.notes ? { notes: render(action.notes) } : {}),
        },
      };
    }
    case 'job.add_note':
      if (!context.jobId) return { skip: 'no_job' };
      return { tool: 'job.add_note', args: { jobId: context.jobId, text: render(action.text) } };
    case 'reminder.create':
      return {
        tool: 'reminder.create',
        args: { ...links, dueAt: nineAm(action.dueInDays), text: render(action.text) },
      };
    case 'job.update_status':
      if (!context.jobId) return { skip: 'no_job' };
      return { tool: 'job.update_status', args: { jobId: context.jobId, status: action.status } };
  }
}

// ------------------------------------------------------------------ engine

interface StoredAutomation {
  id: string;
  version: number;
  definition: AutomationDefinition;
}

function entityOf(
  event: AutomationEventName,
  refs: AutomationEventRefs,
): { type: string; id: string } {
  const entity = AUTOMATION_EVENTS[event].entity;
  if (entity === 'business') return { type: 'business', id: 'business' };
  const id = refs[`${entity}Id` as keyof AutomationEventRefs];
  return { type: entity, id: id ?? 'unknown' };
}

/** Consume one automation event: schedule a run for every enabled automation it matches. */
export async function handleAutomationEvent(
  db: Database,
  queue: PostgresJobQueue,
  tenantId: string,
  eventId: string,
  now: Date,
): Promise<number> {
  return transaction(db, async (client) => {
    const row = await client.query<{ payload: unknown }>(
      "SELECT payload FROM event_outbox WHERE tenant_id=$1 AND id=$2 AND topic='automation.event'",
      [tenantId, eventId],
    );
    if (!row.rows[0]) throw new PermanentTaskError('Automation event not found for this tenant.');
    const parsed = automationEventEnvelopeSchema.safeParse(row.rows[0].payload);
    if (!parsed.success) throw new PermanentTaskError('Invalid automation event.');
    const envelope = parsed.data;
    const automations = await client.query<StoredAutomation>(
      `SELECT id,version,definition FROM automations
       WHERE tenant_id=$1 AND enabled AND deleted_at IS NULL AND trigger_event=$2 ORDER BY created_at`,
      [tenantId, envelope.event],
    );
    if (!automations.rows.length) return 0;
    const business = await loadBusinessBasics(client, tenantId);
    const context = await loadEventContext(client, tenantId, envelope, business, now.getTime());
    const entity = entityOf(envelope.event, envelope.refs);
    let scheduled = 0;
    for (const automation of automations.rows) {
      const definition = automation.definition;
      if (envelope.event === 'schedule' && envelope.data.automationId !== automation.id) continue;
      const dedupeKey = `${automation.id}:${entity.type}:${entity.id}:${envelope.occurrence}`.slice(
        0,
        300,
      );
      const insertRun = async (
        status: AutomationRunStatus,
        scheduledFor: Date,
        code: string | null,
      ) =>
        client.query<{ id: string }>(
          `INSERT INTO automation_runs(id,tenant_id,automation_id,automation_version,event_id,event,entity_type,entity_id,
             job_id,customer_id,status,dedupe_key,scheduled_for,depth,outcome_code,finished_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,CASE WHEN $11='scheduled' THEN NULL ELSE now() END)
           ON CONFLICT (tenant_id,dedupe_key) DO NOTHING RETURNING id`,
          [
            randomUUID(),
            tenantId,
            automation.id,
            automation.version,
            eventId,
            envelope.event,
            entity.type,
            entity.id,
            context.jobId,
            context.customerId,
            status,
            dedupeKey,
            scheduledFor.toISOString(),
            envelope.depth + 1,
            code,
          ],
        );
      // Loop guard: an automation never reacts to its own actions, and chains stop at a depth.
      if (envelope.sourceAutomationId === automation.id || envelope.depth >= MAX_AUTOMATION_DEPTH) {
        await insertRun('skipped', now, 'loop_guard');
        continue;
      }
      if (!context.found || !evaluateCondition(definition.trigger.filter, context.facts)) continue;
      const previous = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM automation_runs WHERE tenant_id=$1 AND automation_id=$2 AND entity_id=$3
           AND status IN ('scheduled','running','succeeded')`,
        [tenantId, automation.id, entity.id],
      );
      if (entity.type !== 'business' && previous.rows[0]!.n >= definition.limits.maxRunsPerEntity) {
        await insertRun('skipped', now, 'entity_limit');
        continue;
      }
      const dueAt = automationDueAt(
        Date.parse(envelope.occurredAt),
        definition.delay,
        business.timeZone,
      );
      const run = await insertRun('scheduled', dueAt, null);
      if (!run.rows[0]) continue; // Redelivered event: the run already exists.
      await queue.enqueue(
        {
          tenantId,
          kind: AUTOMATION_RUN_KIND,
          payload: { runId: run.rows[0].id },
          idempotencyKey: `run:${run.rows[0].id}`,
          runAt: dueAt,
          maxAttempts: 5,
        },
        client,
      );
      scheduled += 1;
    }
    return scheduled;
  });
}

/** Execute a due run. Idempotent: a run that is no longer `scheduled` is left alone. */
export async function executeAutomationRun(
  db: Database,
  tenantId: string,
  runId: string,
  now: Date,
): Promise<AutomationRunStatus> {
  const finish = async (
    client: Queryable,
    status: AutomationRunStatus,
    code: string | null,
    proposalIds: string[] = [],
  ) => {
    await client.query(
      `UPDATE automation_runs SET status=$3,outcome_code=$4,proposal_ids=$5,started_at=coalesce(started_at,now()),
         finished_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2`,
      [tenantId, runId, status, code, JSON.stringify(proposalIds)],
    );
    await recordAudit(client, {
      tenantId,
      actorType: 'system',
      actorId: null,
      action: `automation.run_${status}`,
      entityType: 'automation_run',
      entityId: runId,
      requestId: `automation:${runId}`,
      metadata: { outcome: code, proposals: proposalIds.length },
    });
    return status;
  };
  try {
    return await transaction(db, async (client) => {
      const found = await client.query<{
        automationId: string;
        status: AutomationRunStatus;
        depth: number;
        payload: unknown;
      }>(
        `SELECT r.automation_id AS "automationId",r.status,r.depth,e.payload FROM automation_runs r
         JOIN event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id
         WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE OF r`,
        [tenantId, runId],
      );
      const run = found.rows[0];
      if (!run) throw new PermanentTaskError('Automation run not found for this tenant.');
      if (run.status !== 'scheduled') return run.status;
      const automation = await client.query<StoredAutomation & { enabled: boolean }>(
        'SELECT id,version,definition,enabled FROM automations WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL',
        [tenantId, run.automationId],
      );
      const current = automation.rows[0];
      if (!current?.enabled) return finish(client, 'skipped', 'automation_disabled');
      const envelope = automationEventEnvelopeSchema.parse(run.payload);
      const business = await loadBusinessBasics(client, tenantId);
      const context = await loadEventContext(client, tenantId, envelope, business, now.getTime());
      // State may have changed while the run waited: conditions are checked again now.
      if (!context.found) return finish(client, 'skipped', 'record_missing');
      if (!evaluateCondition(current.definition.trigger.filter, context.facts))
        return finish(client, 'skipped', 'condition_cleared');
      const today = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM automation_runs WHERE tenant_id=$1 AND automation_id=$2
           AND status='succeeded' AND finished_at > $3::timestamptz - interval '1 day'`,
        [tenantId, current.id, now.toISOString()],
      );
      if (today.rows[0]!.n >= current.definition.limits.maxRunsPerDay)
        return finish(client, 'skipped', 'daily_limit');

      // Events emitted while this run executes carry its depth and id (loop guard).
      await client.query('SELECT set_config($1,$2,true), set_config($3,$4,true)', [
        AUTOMATION_DEPTH_SETTING,
        String(run.depth),
        AUTOMATION_ID_SETTING,
        current.id,
      ]);
      const proposalIds: string[] = [];
      const skipped: string[] = [];
      for (const [index, action] of current.definition.actions.entries()) {
        const bound = bindAction(action, context, business, now.getTime());
        if ('skip' in bound) {
          skipped.push(bound.skip);
          continue;
        }
        const parsed = parseToolCall(bound.tool, {
          ...bound.args,
          idempotencyKey: `automation-${runId}-${index}`,
        });
        if (!parsed.ok) return finish(client, 'failed', `invalid_action_${index}`, proposalIds);
        const tenantPolicy = await approvalPolicyFor(client, tenantId, parsed.tool.name);
        const created = await createProposal(client, {
          tenantId,
          requestId: `automation:${runId}`,
          tool: parsed.tool,
          payload: parsed.input,
          meta: parsed.meta,
          origin: { source: 'automation', sourceRef: runId, createdByType: 'system' },
          approvalOverride: actionApproval(action, tenantPolicy),
        });
        proposalIds.push(created.proposal.id);
      }
      await client.query("SELECT set_config($1,'',true), set_config($2,'',true)", [
        AUTOMATION_DEPTH_SETTING,
        AUTOMATION_ID_SETTING,
      ]);
      if (!proposalIds.length) return finish(client, 'skipped', skipped[0] ?? 'nothing_to_do');
      return finish(client, 'succeeded', skipped[0] ?? null, proposalIds);
    });
  } catch (error) {
    // A business-rule refusal (record gone, appointment clash) is final; record it, never content.
    if (error instanceof HttpError)
      return transaction(db, (client) => finish(client, 'failed', error.code.slice(0, 64)));
    throw error;
  }
}

/** What a definition would do for one recent event, without writing anything. */
export async function dryRunAutomation(
  client: Queryable,
  tenantId: string,
  definition: AutomationDefinition,
  eventId: string,
  now: Date,
) {
  const row = await client.query<{ payload: unknown }>(
    "SELECT payload FROM event_outbox WHERE tenant_id=$1 AND id=$2 AND topic='automation.event'",
    [tenantId, eventId],
  );
  if (!row.rows[0]) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Event not found.');
  const envelope = automationEventEnvelopeSchema.parse(row.rows[0].payload);
  if (envelope.event !== definition.trigger.event)
    return { matches: false, reason: 'This event is a different trigger.', actions: [] };
  const business = await loadBusinessBasics(client, tenantId);
  const context = await loadEventContext(client, tenantId, envelope, business, now.getTime());
  const conditionsMet =
    context.found && evaluateCondition(definition.trigger.filter, context.facts);
  const dueAt = automationDueAt(
    Date.parse(envelope.occurredAt),
    definition.delay,
    business.timeZone,
  );
  const actions = [];
  for (const action of definition.actions) {
    const bound = bindAction(action, context, business, now.getTime());
    if ('skip' in bound) {
      actions.push({ tool: action.tool, skipped: bound.skip });
      continue;
    }
    const parsed = parseToolCall(bound.tool, bound.args);
    actions.push({
      tool: action.tool,
      input: parsed.ok ? parsed.input : null,
      valid: parsed.ok,
      approval: actionApproval(action, await approvalPolicyFor(client, tenantId, bound.tool)),
    });
  }
  return {
    matches: conditionsMet,
    reason: conditionsMet
      ? null
      : context.found
        ? 'The conditions are not met.'
        : 'A record is missing.',
    dueAt: dueAt.toISOString(),
    actions,
  };
}

// ------------------------------------------------------------------ hourly tick

/** Time-based events: schedules, overdue invoices and upcoming appointments (once per local day). */
export async function runAutomationTick(
  db: Database,
  tenantId: string,
  now: Date,
): Promise<number> {
  return transaction(db, async (client) => {
    const listening = await client.query<{
      id: string;
      event: string;
      definition: AutomationDefinition;
    }>(
      `SELECT id,trigger_event AS event,definition FROM automations
       WHERE tenant_id=$1 AND enabled AND deleted_at IS NULL AND trigger_event IN ('schedule','invoice.overdue','appointment.upcoming')`,
      [tenantId],
    );
    if (!listening.rows.length) return 0;
    const business = await loadBusinessBasics(client, tenantId);
    const today = instantToLocal(now.getTime(), business.timeZone).date;
    let emitted = 0;
    for (const automation of listening.rows.filter((row) => row.event === 'schedule')) {
      const schedule = automation.definition.trigger.schedule;
      const date = schedule ? scheduleOccurrence(schedule, now.getTime(), business.timeZone) : null;
      if (!date) continue;
      await emitAutomationEvent(client, {
        tenantId,
        event: 'schedule',
        refs: {},
        data: { localDate: date, automationId: automation.id },
        occurrence: `schedule:${automation.id}:${date}`,
      });
      emitted += 1;
    }
    if (listening.rows.some((row) => row.event === 'invoice.overdue')) {
      const invoices = await client.query<{ id: string; jobId: string; days: number }>(
        `SELECT id,job_id AS "jobId",($2::date - due_date)::int AS days FROM invoices
         WHERE tenant_id=$1 AND status IN ('posted','part_paid') AND due_date < $2::date LIMIT 500`,
        [tenantId, today],
      );
      for (const invoice of invoices.rows) {
        await emitAutomationEvent(client, {
          tenantId,
          event: 'invoice.overdue',
          refs: { jobId: invoice.jobId, invoiceId: invoice.id },
          data: { daysOverdue: Math.min(invoice.days, 3650) },
          occurrence: `invoice:${invoice.id}:${today}`,
        });
        emitted += 1;
      }
    }
    if (listening.rows.some((row) => row.event === 'appointment.upcoming')) {
      const from = localTimeToInstant(today, 0, business.timeZone);
      const until = localTimeToInstant(addLocalDays(today, 8), 0, business.timeZone);
      const appointments = await client.query<{ id: string; jobId: string; startsAt: Date }>(
        `SELECT id,job_id AS "jobId",starts_at AS "startsAt" FROM appointments
         WHERE tenant_id=$1 AND status IN ('proposed','confirmed') AND starts_at >= $2 AND starts_at < $3 LIMIT 500`,
        [tenantId, new Date(from).toISOString(), new Date(until).toISOString()],
      );
      for (const appointment of appointments.rows) {
        const date = instantToLocal(appointment.startsAt.getTime(), business.timeZone).date;
        const daysUntil = Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
        await emitAutomationEvent(client, {
          tenantId,
          event: 'appointment.upcoming',
          refs: { jobId: appointment.jobId, appointmentId: appointment.id },
          data: { daysUntil },
          occurrence: `appointment:${appointment.id}:${today}`,
        });
        emitted += 1;
      }
    }
    return emitted;
  });
}

export function scheduleAutomationTick(
  queue: PostgresJobQueue,
  client: Queryable,
  tenantId: string,
  at: Date,
) {
  const bucket = Math.floor(at.getTime() / HOUR_MS);
  return queue.enqueue(
    {
      tenantId,
      kind: AUTOMATION_TICK_KIND,
      payload: {},
      idempotencyKey: `tick:${bucket}`,
      runAt: new Date(bucket * HOUR_MS),
    },
    client,
  );
}

export function createAutomationTaskHandlers(deps: {
  db: Database;
  queue: PostgresJobQueue;
  now?: () => Date;
}): Record<string, TaskHandler> {
  const now = () => deps.now?.() ?? new Date();
  return {
    [AUTOMATION_EVENT_KIND]: async (task) => {
      const eventId = typeof task.payload.outboxId === 'string' ? task.payload.outboxId : '';
      if (!eventId) throw new PermanentTaskError('Missing automation event id.');
      await handleAutomationEvent(deps.db, deps.queue, task.tenantId, eventId, now());
    },
    [AUTOMATION_RUN_KIND]: async (task) => {
      const runId = typeof task.payload.runId === 'string' ? task.payload.runId : '';
      if (!runId) throw new PermanentTaskError('Missing automation run id.');
      await executeAutomationRun(deps.db, task.tenantId, runId, now());
    },
    [AUTOMATION_TICK_KIND]: async (task) => {
      await runAutomationTick(deps.db, task.tenantId, now());
      await scheduleAutomationTick(
        deps.queue,
        deps.db.pool,
        task.tenantId,
        new Date(Date.now() + HOUR_MS),
      );
    },
  };
}
