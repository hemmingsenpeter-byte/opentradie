/**
 * Tasks and the Today screen (Feature 16, ADR 0032). The owner's single to-do list: manual
 * tasks, tasks from approved agent or voice proposals, and tasks the hourly `tasks.scan` derives
 * from deterministic rules (packages/core/src/task-rules.ts). The scan upserts rule tasks by
 * dedupe key, never reopens one the owner completed or dismissed, and resolves rule tasks whose
 * condition has cleared (completed_by_type = 'system').
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TASK_RULE_SETTINGS,
  evaluateTaskRules,
  taskBucket,
  type TaskBucket,
  type TaskFacts,
  type TaskRuleSettings,
} from '@opentradie/core';
import {
  recordAudit,
  transaction,
  type Database,
  type Queryable,
  type TaskKind,
  type TaskPriority,
  type TaskSource,
} from '@opentradie/database';
import type { PostgresJobQueue, TaskHandler } from '@opentradie/platform';
import { HttpError } from '../http.js';
import { loadCollectionsPolicy } from './collections.js';

export const TASKS_SCAN_KIND = 'tasks.scan';
export const TASKS_SCAN_INTERVAL_MS = 60 * 60_000;

export interface TaskRecord {
  id: string;
  kind: TaskKind;
  title: string;
  notes: string | null;
  dueAt: string | null;
  priority: TaskPriority;
  status: 'open' | 'snoozed' | 'done' | 'dismissed';
  snoozedUntil: string | null;
  completedAt: string | null;
  completedByType: 'user' | 'system' | null;
  resolutionReason: string | null;
  source: TaskSource;
  ruleKey: string | null;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  jobId: string | null;
  jobTitle: string | null;
  quoteId: string | null;
  quoteNumber: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  threadId: string | null;
  appointmentId: string | null;
  createdAt: string;
  updatedAt: string;
  bucket: TaskBucket;
}

const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : (value as string | null);

const SELECT_TASK = `SELECT t.id,t.kind,t.title,t.notes,t.due_at AS "dueAt",t.priority,t.status,
    t.snoozed_until AS "snoozedUntil",t.completed_at AS "completedAt",t.completed_by_type AS "completedByType",
    t.resolution_reason AS "resolutionReason",t.source,t.rule_key AS "ruleKey",t.customer_id AS "customerId",
    c.name AS "customerName",c.phone AS "customerPhone",t.job_id AS "jobId",j.title AS "jobTitle",
    t.quote_id AS "quoteId",q.quote_number AS "quoteNumber",t.invoice_id AS "invoiceId",
    i.invoice_number AS "invoiceNumber",t.thread_id AS "threadId",t.appointment_id AS "appointmentId",
    t.created_at AS "createdAt",t.updated_at AS "updatedAt"
  FROM tasks t
    LEFT JOIN customers c ON c.tenant_id=t.tenant_id AND c.id=t.customer_id
    LEFT JOIN jobs j ON j.tenant_id=t.tenant_id AND j.id=t.job_id
    LEFT JOIN quotes q ON q.tenant_id=t.tenant_id AND q.id=t.quote_id
    LEFT JOIN invoices i ON i.tenant_id=t.tenant_id AND i.id=t.invoice_id`;

function toRecord(row: Record<string, unknown>, now: Date, timeZone: string): TaskRecord {
  const record = {
    ...row,
    dueAt: iso(row.dueAt),
    snoozedUntil: iso(row.snoozedUntil),
    completedAt: iso(row.completedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  } as Omit<TaskRecord, 'bucket'>;
  return { ...record, bucket: taskBucket(record, now, timeZone) };
}

async function timeZoneOf(client: Queryable, tenantId: string): Promise<string> {
  const row = await client.query<{ tz: string }>(
    'SELECT time_zone AS tz FROM businesses WHERE id=$1',
    [tenantId],
  );
  return row.rows[0]?.tz ?? 'Pacific/Auckland';
}

export interface TaskListFilter {
  status?: 'active' | 'open' | 'snoozed' | 'done' | 'dismissed' | 'all';
  kind?: TaskKind;
  due?: TaskBucket;
  limit?: number;
}

export async function listTasks(
  client: Queryable,
  tenantId: string,
  filter: TaskListFilter,
  now: Date,
): Promise<{ timeZone: string; tasks: TaskRecord[] }> {
  const timeZone = await timeZoneOf(client, tenantId);
  const status = filter.status ?? 'active';
  const statuses =
    status === 'all'
      ? ['open', 'snoozed', 'done', 'dismissed']
      : status === 'active'
        ? ['open', 'snoozed']
        : [status];
  const rows = await client.query(
    `${SELECT_TASK} WHERE t.tenant_id=$1 AND t.status = ANY($2::text[]) AND ($3::text IS NULL OR t.kind=$3)
     ORDER BY COALESCE(t.snoozed_until,t.due_at) ASC NULLS LAST,
       CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.created_at
     LIMIT $4`,
    [tenantId, statuses, filter.kind ?? null, Math.min(filter.limit ?? 200, 500)],
  );
  let tasks = rows.rows.map((row) => toRecord(row, now, timeZone));
  if (filter.due) tasks = tasks.filter((task) => task.bucket === filter.due);
  return { timeZone, tasks };
}

export async function getTask(
  client: Queryable,
  tenantId: string,
  id: string,
  now: Date,
  lock = false,
): Promise<TaskRecord> {
  if (lock)
    await client.query('SELECT 1 FROM tasks WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
      tenantId,
      id,
    ]);
  const row = await client.query(`${SELECT_TASK} WHERE t.tenant_id=$1 AND t.id=$2`, [tenantId, id]);
  if (!row.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Task not found.');
  return toRecord(row.rows[0], now, await timeZoneOf(client, tenantId));
}

export interface NewTask {
  kind: TaskKind;
  title: string;
  notes?: string | null;
  dueAt?: string | null;
  priority?: TaskPriority;
  source: Exclude<TaskSource, 'rule'>;
  sourceRef?: string | null;
  customerId?: string | null;
  jobId?: string | null;
  quoteId?: string | null;
  invoiceId?: string | null;
  threadId?: string | null;
  appointmentId?: string | null;
  createdBy?: string | null;
  /** One task per key (e.g. `proposal:<id>`), so a replayed approval never duplicates. */
  dedupeKey?: string | null;
}

/** Resolves linked ids against this tenant; a foreign or unknown id is a 422, never a leak. */
async function checkLinks(client: Queryable, tenantId: string, task: NewTask) {
  const checks: [string, string | null | undefined][] = [
    ['customers', task.customerId],
    ['jobs', task.jobId],
    ['quotes', task.quoteId],
    ['invoices', task.invoiceId],
    ['communication_threads', task.threadId],
    ['appointments', task.appointmentId],
  ];
  for (const [table, id] of checks) {
    if (!id) continue;
    const found = await client.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1 AND id=$2`, [
      tenantId,
      id,
    ]);
    if (!found.rowCount)
      throw new HttpError(422, 'LINK_NOT_FOUND', `Linked ${table.replace(/_/g, ' ')} not found.`);
  }
  if (task.jobId && !task.customerId) {
    const job = await client.query<{ customerId: string }>(
      'SELECT customer_id AS "customerId" FROM jobs WHERE tenant_id=$1 AND id=$2',
      [tenantId, task.jobId],
    );
    task.customerId = job.rows[0]?.customerId ?? null;
  }
}

export async function createTask(
  client: Queryable,
  tenantId: string,
  input: NewTask,
): Promise<{ id: string; created: boolean }> {
  const task = { ...input };
  await checkLinks(client, tenantId, task);
  const id = randomUUID();
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO tasks(id,tenant_id,kind,title,notes,due_at,priority,source,source_ref,customer_id,job_id,
       quote_id,invoice_id,thread_id,appointment_id,created_by,dedupe_key)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (tenant_id,dedupe_key) DO NOTHING RETURNING id`,
    [
      id,
      tenantId,
      task.kind,
      task.title,
      task.notes ?? null,
      task.dueAt ?? null,
      task.priority ?? 'normal',
      task.source,
      task.sourceRef ?? null,
      task.customerId ?? null,
      task.jobId ?? null,
      task.quoteId ?? null,
      task.invoiceId ?? null,
      task.threadId ?? null,
      task.appointmentId ?? null,
      task.createdBy ?? null,
      task.dedupeKey ?? null,
    ],
  );
  if (inserted.rows[0]) return { id, created: true };
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM tasks WHERE tenant_id=$1 AND dedupe_key=$2',
    [tenantId, task.dedupeKey],
  );
  return { id: existing.rows[0]!.id, created: false };
}

export type TaskAction = 'complete' | 'snooze' | 'dismiss' | 'reopen';

/** Applies an owner action. Repeating an action on a task already in that state is a no-op. */
export async function applyTaskAction(
  client: Queryable,
  tenantId: string,
  id: string,
  action: TaskAction,
  actor: { type: 'user'; id: string } | { type: 'system' },
  now: Date,
  until?: string,
): Promise<{ task: TaskRecord; changed: boolean; from: string }> {
  const current = await getTask(client, tenantId, id, now, true);
  const from = current.status;
  const userId = actor.type === 'user' ? actor.id : null;
  let sql: string | null = null;
  let params: unknown[] = [tenantId, id];
  switch (action) {
    case 'complete':
      if (from !== 'done')
        sql = `UPDATE tasks SET status='done',snoozed_until=NULL,completed_at=now(),completed_by=$3,
                 completed_by_type=$4,resolution_reason=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2`;
      params = [...params, userId, actor.type];
      break;
    case 'dismiss':
      if (from !== 'dismissed')
        sql = `UPDATE tasks SET status='dismissed',snoozed_until=NULL,completed_at=now(),completed_by=$3,
                 completed_by_type=$4,resolution_reason=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2`;
      params = [...params, userId, actor.type];
      break;
    case 'snooze': {
      if (!until || Date.parse(until) <= now.getTime())
        throw new HttpError(422, 'SNOOZE_IN_PAST', 'Snooze until a time in the future.');
      if (from === 'done' || from === 'dismissed')
        throw new HttpError(409, 'TASK_CLOSED', 'Reopen the task before snoozing it.');
      if (current.snoozedUntil !== new Date(until).toISOString() || from !== 'snoozed')
        sql = `UPDATE tasks SET status='snoozed',snoozed_until=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2`;
      params = [...params, new Date(until).toISOString()];
      break;
    }
    case 'reopen':
      if (from !== 'open')
        sql = `UPDATE tasks SET status='open',snoozed_until=NULL,completed_at=NULL,completed_by=NULL,
                 completed_by_type=NULL,resolution_reason=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2`;
      break;
  }
  if (sql) await client.query(sql, params);
  return {
    task: sql ? await getTask(client, tenantId, id, now) : current,
    changed: Boolean(sql),
    from,
  };
}

// ---------------------------------------------------------------- settings

export async function loadTaskSettings(
  client: Queryable,
  tenantId: string,
): Promise<TaskRuleSettings> {
  const row = (
    await client.query<{
      rules_enabled: boolean;
      follow_up_quote_days: number;
      reply_after_hours: number;
      invoice_after_days: number;
    }>('SELECT * FROM task_settings WHERE tenant_id=$1', [tenantId])
  ).rows[0];
  if (!row) return { ...DEFAULT_TASK_RULE_SETTINGS };
  return {
    rulesEnabled: row.rules_enabled,
    followUpQuoteDays: row.follow_up_quote_days,
    replyAfterHours: row.reply_after_hours,
    invoiceAfterDays: row.invoice_after_days,
  };
}

export async function saveTaskSettings(
  client: Queryable,
  tenantId: string,
  userId: string,
  settings: TaskRuleSettings,
) {
  await client.query(
    `INSERT INTO task_settings(tenant_id,rules_enabled,follow_up_quote_days,reply_after_hours,invoice_after_days,updated_by)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id) DO UPDATE SET rules_enabled=$2,follow_up_quote_days=$3,reply_after_hours=$4,
       invoice_after_days=$5,updated_by=$6,updated_at=now()`,
    [
      tenantId,
      settings.rulesEnabled,
      settings.followUpQuoteDays,
      settings.replyAfterHours,
      settings.invoiceAfterDays,
      userId,
    ],
  );
}

// ---------------------------------------------------------------- scan

/** Reads the facts every rule needs. Identifiers, timestamps and short labels only. */
export async function gatherTaskFacts(client: Queryable, tenantId: string): Promise<TaskFacts> {
  const accepted = await client.query(
    `SELECT q.id AS "quoteId",q.job_id AS "jobId",q.customer_id AS "customerId",j.title AS "jobTitle",
       q.quote_number AS "quoteNumber",q.accepted_at AS "acceptedAt",
       COALESCE((SELECT array_agg(a.ends_at) FROM appointments a WHERE a.tenant_id=q.tenant_id
         AND a.job_id=q.job_id AND a.status <> 'cancelled'), '{}') AS "appointmentEndsAt"
     FROM quotes q JOIN jobs j ON j.tenant_id=q.tenant_id AND j.id=q.job_id
     WHERE q.tenant_id=$1 AND q.status='accepted' AND j.status NOT IN ('completed','cancelled')`,
    [tenantId],
  );
  const sent = await client.query(
    `SELECT q.id AS "quoteId",q.job_id AS "jobId",q.customer_id AS "customerId",c.name AS "customerName",
       q.quote_number AS "quoteNumber",q.sent_at AS "sentAt"
     FROM quotes q JOIN customers c ON c.tenant_id=q.tenant_id AND c.id=q.customer_id
     JOIN jobs j ON j.tenant_id=q.tenant_id AND j.id=q.job_id
     WHERE q.tenant_id=$1 AND q.status='sent' AND j.status <> 'cancelled' AND c.erased_at IS NULL`,
    [tenantId],
  );
  const threads = await client.query(
    `SELECT t.id AS "threadId",t.customer_id AS "customerId",t.job_id AS "jobId",
       COALESCE(c.name, NULLIF(m.from_name,''), m.from_address, 'a customer') AS "senderLabel",
       m.id AS "lastInboundId",m.created_at AS "lastInboundAt",
       EXISTS (SELECT 1 FROM communications o WHERE o.tenant_id=t.tenant_id AND o.thread_id=t.id
         AND o.direction='outbound' AND o.status IN ('approved','sending','sent') AND o.created_at >= m.created_at) AS "repliedAfter"
     FROM communication_threads t
       JOIN LATERAL (SELECT id,created_at,from_name,from_address FROM communications i
         WHERE i.tenant_id=t.tenant_id AND i.thread_id=t.id AND i.direction='inbound'
         ORDER BY created_at DESC LIMIT 1) m ON true
       LEFT JOIN customers c ON c.tenant_id=t.tenant_id AND c.id=t.customer_id
     WHERE t.tenant_id=$1 AND t.status='open'`,
    [tenantId],
  );
  const completed = await client.query(
    `SELECT j.id AS "jobId",j.customer_id AS "customerId",j.title AS "jobTitle",j.completed_at AS "completedAt",
       EXISTS (SELECT 1 FROM invoices i WHERE i.tenant_id=j.tenant_id AND i.job_id=j.id AND i.status <> 'void') AS invoiced
     FROM jobs j WHERE j.tenant_id=$1 AND j.status='completed' AND j.completed_at IS NOT NULL`,
    [tenantId],
  );
  const owed = await client.query(
    `SELECT i.id AS "invoiceId",i.job_id AS "jobId",i.customer_id AS "customerId",c.name AS "customerName",
       i.invoice_number AS "invoiceNumber",to_char(i.due_date,'YYYY-MM-DD') AS "dueDate",i.collections_hold AS "onHold",
       EXISTS (SELECT 1 FROM reminders r WHERE r.tenant_id=i.tenant_id AND r.subject_type='invoice'
         AND r.subject_id=i.id AND r.status='escalated') AS escalated
     FROM invoices i JOIN customers c ON c.tenant_id=i.tenant_id AND c.id=i.customer_id
     WHERE i.tenant_id=$1 AND i.status IN ('posted','part_paid') AND c.erased_at IS NULL`,
    [tenantId],
  );
  const isoAll = <T extends Record<string, unknown>>(rows: T[], keys: string[]) =>
    rows.map((row) => {
      const out: Record<string, unknown> = { ...row };
      for (const key of keys)
        out[key] = Array.isArray(row[key]) ? (row[key] as unknown[]).map(iso) : iso(row[key]);
      return out;
    });
  return {
    acceptedQuotes: isoAll(accepted.rows, [
      'acceptedAt',
      'appointmentEndsAt',
    ]) as TaskFacts['acceptedQuotes'],
    sentQuotes: isoAll(sent.rows, ['sentAt']) as TaskFacts['sentQuotes'],
    threads: isoAll(threads.rows, ['lastInboundAt']) as TaskFacts['threads'],
    completedJobs: isoAll(completed.rows, ['completedAt']) as TaskFacts['completedJobs'],
    owedInvoices: owed.rows as TaskFacts['owedInvoices'],
  };
}

export interface TaskScanSummary {
  created: number;
  updated: number;
  resolved: number;
  woken: number;
}

export interface TasksDependencies {
  db: Database;
  queue: PostgresJobQueue;
  now?: () => Date;
}

/** One scan: rule tasks upserted by dedupe key, cleared conditions resolved, lapsed snoozes woken. */
export async function scanTasks(
  db: Database,
  tenantId: string,
  requestRef: string,
  now: Date,
): Promise<TaskScanSummary> {
  return transaction(db, async (client) => {
    // One scan per tenant at a time.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tasks.scan:${tenantId}`]);
    const timeZone = await timeZoneOf(client, tenantId);
    const settings = await loadTaskSettings(client, tenantId);
    const collections = await loadCollectionsPolicy(client, tenantId);
    const facts = await gatherTaskFacts(client, tenantId);
    const wanted = evaluateTaskRules(
      facts,
      settings,
      { overdueFinalDays: collections.overdueFinalDays },
      now,
      timeZone,
    );
    const summary: TaskScanSummary = { created: 0, updated: 0, resolved: 0, woken: 0 };
    for (const task of wanted) {
      // Insert, or refresh an open one. A task the owner completed or dismissed stays closed; one
      // the scan itself resolved reopens when its condition comes back (e.g. booking cancelled).
      const result = await client.query<{ inserted: boolean }>(
        `INSERT INTO tasks(id,tenant_id,kind,title,due_at,priority,source,rule_key,dedupe_key,customer_id,job_id,quote_id,invoice_id,thread_id)
         VALUES($1,$2,$3,$4,$5,$6,'rule',$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (tenant_id,dedupe_key) DO UPDATE SET
           title=EXCLUDED.title,priority=EXCLUDED.priority,
           due_at=CASE WHEN tasks.status='done' THEN EXCLUDED.due_at ELSE tasks.due_at END,
           status=CASE WHEN tasks.status='done' THEN 'open' ELSE tasks.status END,
           completed_at=CASE WHEN tasks.status='done' THEN NULL ELSE tasks.completed_at END,
           completed_by_type=CASE WHEN tasks.status='done' THEN NULL ELSE tasks.completed_by_type END,
           resolution_reason=CASE WHEN tasks.status='done' THEN NULL ELSE tasks.resolution_reason END,
           updated_at=now()
         WHERE (tasks.status IN ('open','snoozed') AND (tasks.title,tasks.priority)
                  IS DISTINCT FROM (EXCLUDED.title,EXCLUDED.priority))
            OR (tasks.status='done' AND tasks.completed_by_type='system')
         RETURNING (xmax = 0) AS inserted`,
        [
          randomUUID(),
          tenantId,
          task.kind,
          task.title,
          task.dueAt,
          task.priority,
          task.ruleKey,
          task.dedupeKey,
          task.links.customerId,
          task.links.jobId,
          task.links.quoteId,
          task.links.invoiceId,
          task.links.threadId,
        ],
      );
      const row = result.rows[0];
      if (row?.inserted) summary.created += 1;
      else if (row) summary.updated += 1;
    }
    const resolved = await client.query(
      `UPDATE tasks SET status='done',snoozed_until=NULL,completed_at=$3,completed_by=NULL,completed_by_type='system',
         resolution_reason='condition_cleared',updated_at=now()
       WHERE tenant_id=$1 AND source='rule' AND status IN ('open','snoozed') AND NOT (dedupe_key = ANY($2::text[]))`,
      [tenantId, wanted.map((task) => task.dedupeKey), now.toISOString()],
    );
    summary.resolved = resolved.rowCount ?? 0;
    const woken = await client.query(
      `UPDATE tasks SET status='open',snoozed_until=NULL,due_at=snoozed_until,updated_at=now()
       WHERE tenant_id=$1 AND status='snoozed' AND snoozed_until <= $2`,
      [tenantId, now.toISOString()],
    );
    summary.woken = woken.rowCount ?? 0;
    if (summary.created || summary.resolved || summary.woken || summary.updated)
      await recordAudit(client, {
        tenantId,
        actorType: 'system',
        actorId: null,
        action: 'tasks.scanned',
        entityType: 'business',
        entityId: tenantId,
        requestId: requestRef,
        metadata: { ...summary },
      });
    return summary;
  });
}

/** One scan task per hour bucket per tenant (an owner's "run now" runs inline instead). */
export function scheduleTasksScan(
  queue: PostgresJobQueue,
  client: Queryable,
  tenantId: string,
  runAt: Date,
  key = `tasks:${runAt.toISOString().slice(0, 13)}`,
) {
  return queue.enqueue(
    { tenantId, kind: TASKS_SCAN_KIND, payload: {}, idempotencyKey: key, runAt, maxAttempts: 3 },
    client,
  );
}

/** The `tasks.scan` handler: scan, then chain the next hourly scan. */
export function createTasksTaskHandlers(deps: TasksDependencies): Record<string, TaskHandler> {
  return {
    [TASKS_SCAN_KIND]: async (task) => {
      await scanTasks(deps.db, task.tenantId, `task:${task.id}`, deps.now?.() ?? new Date());
      await scheduleTasksScan(
        deps.queue,
        deps.db.pool,
        task.tenantId,
        new Date(Date.now() + TASKS_SCAN_INTERVAL_MS),
      );
    },
  };
}
