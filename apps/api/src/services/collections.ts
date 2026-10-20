/**
 * Unpaid invoice follow-ups (Workflow D, ADR 0027). An hourly `collections.scan` task decides
 * each posted, unpaid invoice's follow-up stage (packages/core/src/collections.ts), records one
 * reminder per stage (dedupe key `invoice:<id>:<stage>`), and prepares a deterministic email
 * DRAFT in the inbox for owner approval. Only a stage the owner set to auto-send is queued for
 * sending, and only with a connected mailbox. Every send re-checks the invoice first.
 */
import { randomUUID } from 'node:crypto';
import {
  CUSTOMER_STAGES,
  DEFAULT_COLLECTIONS_POLICY,
  decideCollectionStage,
  followUpEmail,
  type CollectionStage,
  type CollectionsPolicy,
  type CustomerStage,
} from '@opentradie/core';
import {
  recordAudit,
  recordJobEvent,
  transaction,
  type Database,
  type Queryable,
} from '@opentradie/database';
import type { MailConnections } from '@opentradie/integrations/mail';
import type { PostgresJobQueue, TaskHandler } from '@opentradie/platform';

export const COLLECTIONS_SCAN_KIND = 'collections.scan';
export const COLLECTIONS_SCAN_INTERVAL_MS = 60 * 60_000;

export interface CollectionsDependencies {
  db: Database;
  queue: PostgresJobQueue;
  mail: MailConnections;
  /** Test/demo clock (COLLECTIONS_TEST_NOW); the real clock otherwise. */
  now?: () => Date;
}

export interface StoredPolicy extends CollectionsPolicy {
  updatedBy: string | null;
}

export async function loadCollectionsPolicy(
  client: Queryable,
  tenantId: string,
): Promise<StoredPolicy> {
  const row = (
    await client.query<{
      enabled: boolean;
      pre_due_courtesy_enabled: boolean;
      pre_due_days: number;
      overdue_1_days: number;
      overdue_2_days: number;
      overdue_final_days: number;
      escalate_days: number;
      auto_send_pre_due: boolean;
      auto_send_overdue_1: boolean;
      auto_send_overdue_2: boolean;
      auto_send_overdue_final: boolean;
      updated_by: string | null;
    }>('SELECT * FROM collections_settings WHERE tenant_id=$1', [tenantId])
  ).rows[0];
  if (!row) return { ...DEFAULT_COLLECTIONS_POLICY, updatedBy: null };
  return {
    enabled: row.enabled,
    preDueCourtesyEnabled: row.pre_due_courtesy_enabled,
    preDueDays: row.pre_due_days,
    overdue1Days: row.overdue_1_days,
    overdue2Days: row.overdue_2_days,
    overdueFinalDays: row.overdue_final_days,
    escalateDays: row.escalate_days,
    autoSend: {
      pre_due_courtesy: row.auto_send_pre_due,
      overdue_1: row.auto_send_overdue_1,
      overdue_2: row.auto_send_overdue_2,
      overdue_final: row.auto_send_overdue_final,
    },
    updatedBy: row.updated_by,
  };
}

export async function saveCollectionsPolicy(
  client: Queryable,
  tenantId: string,
  userId: string,
  policy: CollectionsPolicy,
): Promise<void> {
  await client.query(
    `INSERT INTO collections_settings(tenant_id,enabled,pre_due_courtesy_enabled,pre_due_days,overdue_1_days,overdue_2_days,
       overdue_final_days,escalate_days,auto_send_pre_due,auto_send_overdue_1,auto_send_overdue_2,auto_send_overdue_final,updated_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (tenant_id) DO UPDATE SET enabled=$2,pre_due_courtesy_enabled=$3,pre_due_days=$4,overdue_1_days=$5,
       overdue_2_days=$6,overdue_final_days=$7,escalate_days=$8,auto_send_pre_due=$9,auto_send_overdue_1=$10,
       auto_send_overdue_2=$11,auto_send_overdue_final=$12,updated_by=$13,updated_at=now()`,
    [
      tenantId,
      policy.enabled,
      policy.preDueCourtesyEnabled,
      policy.preDueDays,
      policy.overdue1Days,
      policy.overdue2Days,
      policy.overdueFinalDays,
      policy.escalateDays,
      policy.autoSend.pre_due_courtesy,
      policy.autoSend.overdue_1,
      policy.autoSend.overdue_2,
      policy.autoSend.overdue_final,
      userId,
    ],
  );
}

/** One scan task per hour bucket per tenant (or an owner's "run now", keyed by request). */
export function scheduleCollectionsScan(
  queue: PostgresJobQueue,
  client: Queryable,
  tenantId: string,
  runAt: Date,
  key = `collections:${runAt.toISOString().slice(0, 13)}`,
) {
  return queue.enqueue(
    {
      tenantId,
      kind: COLLECTIONS_SCAN_KIND,
      payload: {},
      idempotencyKey: key,
      runAt,
      maxAttempts: 3,
    },
    client,
  );
}

interface OpenInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  dueDate: string;
  totalCents: string;
  currency: string;
  customerId: string;
  jobId: string;
  hold: boolean;
  customerErased: boolean;
  customerName: string;
  preferredName: string | null;
  customerEmail: string | null;
  businessName: string;
  timeZone: string;
  snapshotDue: string | null;
  snapshotStatus: string | null;
  stages: string[];
}

const OPEN_INVOICES_SQL = `
  SELECT i.id,i.invoice_number AS "invoiceNumber",i.status,to_char(i.due_date,'YYYY-MM-DD') AS "dueDate",
    i.total_cents AS "totalCents",i.currency,i.customer_id AS "customerId",i.job_id AS "jobId",
    i.collections_hold AS hold,(c.erased_at IS NOT NULL) AS "customerErased",c.name AS "customerName",
    c.preferred_name AS "preferredName",c.email AS "customerEmail",b.name AS "businessName",b.time_zone AS "timeZone",
    s.amount_due_cents AS "snapshotDue",s.provider_status AS "snapshotStatus",
    coalesce((SELECT array_agg(r.payload->>'stage') FROM reminders r WHERE r.tenant_id=i.tenant_id
      AND r.subject_type='invoice' AND r.subject_id=i.id),'{}') AS stages
  FROM invoices i
    JOIN customers c ON c.tenant_id=i.tenant_id AND c.id=i.customer_id
    JOIN businesses b ON b.id=i.tenant_id
    LEFT JOIN LATERAL (SELECT amount_due_cents,provider_status FROM payment_snapshots p
      WHERE p.tenant_id=i.tenant_id AND p.invoice_id=i.id ORDER BY fetched_at DESC LIMIT 1) s ON true
  WHERE i.tenant_id=$1 AND ($2::uuid IS NULL OR i.id=$2)`;

function toDecisionInput(row: OpenInvoice) {
  return {
    status: row.status,
    dueDate: row.dueDate,
    totalCents: Number(row.totalCents),
    snapshotAmountDueCents: row.snapshotDue === null ? null : Number(row.snapshotDue),
    snapshotProviderStatus: row.snapshotStatus,
    onHold: row.hold,
    customerErased: row.customerErased,
    preparedStages: row.stages,
  };
}

/** Why an invoice no longer needs a follow-up, or null while it is still owed. */
export function stillOwedReason(row: OpenInvoice): string | null {
  const decision = decideCollectionStage(
    { ...toDecisionInput(row), preparedStages: [] },
    { ...DEFAULT_COLLECTIONS_POLICY, enabled: true },
    new Date(),
    row.timeZone,
  );
  if (decision.stage !== 'none') return null;
  return decision.reason === 'not_due' ? null : decision.reason;
}

export interface ScanSummary {
  checked: number;
  prepared: number;
  escalated: number;
  autoSendQueued: number;
  suppressed: number;
}

/** Discard a still-unsent follow-up draft whose invoice no longer needs chasing. */
async function suppressFollowUp(
  client: Queryable,
  tenantId: string,
  input: {
    reminderId: string;
    communicationId: string | null;
    invoiceId: string;
    invoiceNumber: string;
    jobId: string;
    reason: string;
    requestId: string;
  },
) {
  if (input.communicationId)
    await client.query(
      "UPDATE communications SET status='discarded',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('draft','approved','failed')",
      [tenantId, input.communicationId],
    );
  await client.query(
    "UPDATE reminders SET status='suppressed',status_reason=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",
    [tenantId, input.reminderId, input.reason],
  );
  await recordJobEvent(client, {
    tenantId,
    jobId: input.jobId,
    type: 'invoice_follow_up_suppressed',
    actorType: 'system',
    actorId: null,
    summary: `Payment follow-up for invoice ${input.invoiceNumber} withdrawn`,
    metadata: { invoiceId: input.invoiceId, reminderId: input.reminderId, reason: input.reason },
  });
  await recordAudit(client, {
    tenantId,
    actorType: 'system',
    actorId: null,
    action: 'invoice.follow_up_suppressed',
    entityType: 'invoice',
    entityId: input.invoiceId,
    requestId: input.requestId,
    metadata: { reminderId: input.reminderId, reason: input.reason },
  });
}

/**
 * Called by inbox.send inside its locking transaction, before any provider call (approved and
 * auto-send paths alike). Returns true when the message was a follow-up whose invoice was paid,
 * voided, put on hold or whose customer was erased since drafting: the draft is discarded and
 * the reminder suppressed, so nothing is sent.
 */
export async function suppressStaleFollowUp(
  client: Queryable,
  tenantId: string,
  communicationId: string,
  requestId: string,
): Promise<boolean> {
  const reminder = (
    await client.query<{ id: string; subjectId: string }>(
      `SELECT id,subject_id AS "subjectId" FROM reminders
       WHERE tenant_id=$1 AND communication_id=$2 AND subject_type='invoice' FOR UPDATE`,
      [tenantId, communicationId],
    )
  ).rows[0];
  if (!reminder) return false;
  const invoice = (
    await client.query<OpenInvoice>(OPEN_INVOICES_SQL, [tenantId, reminder.subjectId])
  ).rows[0];
  const reason = invoice ? stillOwedReason(invoice) : 'invoice_missing';
  if (!reason || !invoice) return false;
  await suppressFollowUp(client, tenantId, {
    reminderId: reminder.id,
    communicationId,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    jobId: invoice.jobId,
    reason,
    requestId,
  });
  return true;
}

/**
 * One scan of a tenant's invoices. Safe to repeat: each stage's reminder is unique on its dedupe
 * key, so a repeated or concurrent scan (or a restart mid-scan) never prepares a stage twice.
 */
export async function scanCollections(
  deps: CollectionsDependencies,
  tenantId: string,
  requestId: string,
): Promise<ScanSummary> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const summary: ScanSummary = {
    checked: 0,
    prepared: 0,
    escalated: 0,
    autoSendQueued: 0,
    suppressed: 0,
  };
  const policy = await loadCollectionsPolicy(db.pool, tenantId);

  // Withdraw unsent drafts whose invoice was paid, voided or held since they were prepared.
  const pending = await db.pool.query<{
    reminderId: string;
    communicationId: string;
    invoiceId: string;
  }>(
    `SELECT r.id AS "reminderId",r.communication_id AS "communicationId",r.subject_id AS "invoiceId"
     FROM reminders r JOIN communications m ON m.tenant_id=r.tenant_id AND m.id=r.communication_id
     WHERE r.tenant_id=$1 AND r.subject_type='invoice' AND r.status='prepared' AND m.status IN ('draft','failed')`,
    [tenantId],
  );
  for (const row of pending.rows)
    await transaction(db, async (client) => {
      if (await suppressStaleFollowUp(client, tenantId, row.communicationId, requestId))
        summary.suppressed += 1;
    });

  if (!policy.enabled) return summary;
  const mailbox = await deps.mail.forTenant(tenantId).catch(() => null);
  const invoices = await db.pool.query<OpenInvoice>(
    `${OPEN_INVOICES_SQL} AND i.status IN ('posted','part_paid') ORDER BY i.due_date LIMIT 500`,
    [tenantId, null],
  );
  for (const invoice of invoices.rows) {
    summary.checked += 1;
    const decision = decideCollectionStage(toDecisionInput(invoice), policy, now, invoice.timeZone);
    if (decision.stage === 'none') continue;
    const stage: CollectionStage = decision.stage;
    await transaction(db, async (client) => {
      const reminderId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO reminders(id,tenant_id,subject_type,subject_id,job_id,customer_id,due_at,channel,status,dedupe_key,payload)
         VALUES($1,$2,'invoice',$3,$4,$5,$6,$7,'scheduled',$8,$9)
         ON CONFLICT (tenant_id,dedupe_key) DO NOTHING RETURNING id`,
        [
          reminderId,
          tenantId,
          invoice.id,
          invoice.jobId,
          invoice.customerId,
          now,
          stage === 'escalate_owner' ? 'manual' : 'email',
          `invoice:${invoice.id}:${stage}`,
          JSON.stringify({
            template: 'invoice_follow_up',
            stage,
            daysOverdue: decision.daysOverdue,
          }),
        ],
      );
      if (!inserted.rowCount) return;

      if (stage === 'escalate_owner') {
        await client.query(
          "UPDATE reminders SET status='escalated',status_reason='owner_task',updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [tenantId, reminderId],
        );
        await recordJobEvent(client, {
          tenantId,
          jobId: invoice.jobId,
          type: 'invoice_follow_up_escalated',
          actorType: 'system',
          actorId: null,
          summary: `Invoice ${invoice.invoiceNumber} is ${decision.daysOverdue} days overdue: follow up personally`,
          metadata: { invoiceId: invoice.id, reminderId, daysOverdue: decision.daysOverdue },
        });
        await recordAudit(client, {
          tenantId,
          actorType: 'system',
          actorId: null,
          action: 'invoice.follow_up_escalated',
          entityType: 'invoice',
          entityId: invoice.id,
          requestId,
          metadata: { reminderId, daysOverdue: decision.daysOverdue },
        });
        summary.escalated += 1;
        return;
      }

      const customerStage = stage as CustomerStage;
      const email = followUpEmail({
        stage: customerStage,
        customerName: invoice.preferredName ?? invoice.customerName,
        businessName: invoice.businessName,
        invoiceNumber: invoice.invoiceNumber,
        amountDueCents: decision.amountDueCents,
        currency: invoice.currency,
        dueDate: invoice.dueDate,
        daysOverdue: Math.max(decision.daysOverdue, 0),
      });
      const threadId = randomUUID();
      await client.query(
        `INSERT INTO communication_threads(id,tenant_id,channel,subject,subject_normalised,customer_id,job_id)
         VALUES($1,$2,'email',$3,lower($3),$4,$5)`,
        [threadId, tenantId, email.subject, invoice.customerId, invoice.jobId],
      );
      const recipients = invoice.customerEmail ? [invoice.customerEmail.toLowerCase()] : [];
      const auto =
        policy.autoSend[customerStage] &&
        mailbox !== null &&
        recipients.length > 0 &&
        policy.updatedBy !== null;
      const communicationId = randomUUID();
      await client.query(
        `INSERT INTO communications(id,tenant_id,customer_id,job_id,thread_id,direction,channel,status,origin,subject,text,
           to_addresses,external_reference,approved_by,approved_at,send_attempt)
         VALUES($1,$2,$3,$4,$5,'outbound','email',$6,'system',$7,$8,$9,$10,$11,$12,$13)`,
        [
          communicationId,
          tenantId,
          invoice.customerId,
          invoice.jobId,
          threadId,
          auto ? 'approved' : 'draft',
          email.subject,
          email.text,
          recipients,
          `reminder:${reminderId}`,
          auto ? policy.updatedBy : null,
          auto ? new Date() : null,
          auto ? 1 : 0,
        ],
      );
      await client.query(
        `UPDATE reminders SET status='prepared',status_reason=$3,communication_id=$4,prepared_at=now(),updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, reminderId, auto ? 'auto_send' : 'awaiting_approval', communicationId],
      );
      if (auto) {
        await deps.queue.enqueue(
          {
            tenantId,
            kind: 'inbox.send',
            payload: { communicationId },
            idempotencyKey: `send:${communicationId}:1`,
            maxAttempts: 3,
          },
          client,
        );
        summary.autoSendQueued += 1;
      }
      await recordJobEvent(client, {
        tenantId,
        jobId: invoice.jobId,
        type: 'invoice_follow_up_prepared',
        actorType: 'system',
        actorId: null,
        summary: auto
          ? `Payment follow-up for invoice ${invoice.invoiceNumber} queued to send (auto-send)`
          : `Payment follow-up for invoice ${invoice.invoiceNumber} drafted for approval`,
        metadata: { invoiceId: invoice.id, reminderId, communicationId, stage, auto },
      });
      await recordAudit(client, {
        tenantId,
        actorType: 'system',
        actorId: null,
        action: 'invoice.follow_up_prepared',
        entityType: 'invoice',
        entityId: invoice.id,
        requestId,
        metadata: { reminderId, communicationId, stage, auto, daysOverdue: decision.daysOverdue },
      });
      summary.prepared += 1;
    });
  }
  return summary;
}

/** The `collections.scan` handler: scan, then chain the next hourly scan while enabled. */
export function createCollectionsTaskHandlers(
  deps: CollectionsDependencies,
): Record<string, TaskHandler> {
  return {
    [COLLECTIONS_SCAN_KIND]: async (task) => {
      await scanCollections(deps, task.tenantId, `task:${task.id}`);
      const policy = await loadCollectionsPolicy(deps.db.pool, task.tenantId);
      if (policy.enabled)
        await scheduleCollectionsScan(
          deps.queue,
          deps.db.pool,
          task.tenantId,
          new Date(Date.now() + COLLECTIONS_SCAN_INTERVAL_MS),
        );
    },
  };
}

export interface FollowUpHistoryItem {
  id: string;
  stage: string;
  status: string;
  reason: string | null;
  communicationId: string | null;
  communicationStatus: string | null;
  threadId: string | null;
  createdAt: string;
}

export async function followUpHistory(
  client: Queryable,
  tenantId: string,
  invoiceId: string,
): Promise<FollowUpHistoryItem[]> {
  const rows = await client.query<Omit<FollowUpHistoryItem, 'createdAt'> & { createdAt: Date }>(
    `SELECT r.id,r.payload->>'stage' AS stage,r.status,r.status_reason AS reason,r.communication_id AS "communicationId",
       m.status AS "communicationStatus",m.thread_id AS "threadId",r.created_at AS "createdAt"
     FROM reminders r LEFT JOIN communications m ON m.tenant_id=r.tenant_id AND m.id=r.communication_id
     WHERE r.tenant_id=$1 AND r.subject_type='invoice' AND r.subject_id=$2 ORDER BY r.created_at, r.id`,
    [tenantId, invoiceId],
  );
  return rows.rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export const FOLLOW_UP_STAGES = [...CUSTOMER_STAGES, 'escalate_owner'] as const;
