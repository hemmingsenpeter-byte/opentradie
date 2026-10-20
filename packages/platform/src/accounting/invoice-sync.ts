import { randomUUID } from 'node:crypto';
import { formatQuantityMilli, formatSignedCents } from '@opentradie/core';
import {
  recordAudit,
  recordJobEvent,
  transaction,
  type Database,
  type Queryable,
} from '@opentradie/database';
import {
  AccountingSyncService,
  AuthExpiredError,
  deriveIdempotencyKey,
  isIntegrationError,
  RateLimitedError,
  ReauthorisationRequiredError,
  ValidationError,
  type AccountingContext,
  type DraftInvoiceLine,
  type IntegrationError,
  type InvoiceSnapshot,
  type PushInvoiceInput,
} from '@opentradie/integrations';
import { PermanentTaskError, RetryLaterTaskError, type PostgresJobQueue } from '../job-queue.js';
import type { AccountingRuntime } from './runtime.js';

export const POST_INVOICE_TOPIC = 'accounting.post_invoice';
export const RECONCILE_TASK_KIND = 'accounting.reconcile';
/** How often posted, unpaid invoices are re-read from the ledger. */
export const RECONCILE_INTERVAL_MS = 60 * 60_000;

export type SyncErrorKind =
  | 'reauthorisation_required'
  | 'not_connected'
  | 'organisation_required'
  | 'validation'
  | 'conflict'
  | 'permanent'
  | 'transient_exhausted'
  | 'unsupported';

/** Owner-facing explanations. Fixed text: never a provider body. */
const SYNC_ERROR_MESSAGES: Record<SyncErrorKind, string> = {
  reauthorisation_required:
    'The accounting connection has expired or was revoked. Reconnect it in Settings, then retry.',
  not_connected: 'No accounting connection. Connect it in Settings, then retry.',
  organisation_required:
    'Choose which accounting organisation to use in Settings, then retry the sync.',
  validation: 'The accounting system rejected this invoice. Check the listed issues, then retry.',
  conflict: 'The accounting system reported a conflict that needs your decision.',
  permanent: 'The accounting system refused this invoice. Retrying will not help without a change.',
  transient_exhausted:
    'The accounting system could not be reached after several attempts. Retry later.',
  unsupported: 'This invoice cannot be posted to the accounting system automatically.',
};

/**
 * The idempotency key for posting an invoice revision: derived only from tenant, invoice id and
 * invoice version, so every retry (after a crash, timeout or rate limit) reuses it exactly.
 */
export function postingIdempotencyKey(tenantId: string, invoiceId: string, version: number) {
  return deriveIdempotencyKey({
    tenantId,
    operation: 'draft_invoice',
    entityId: invoiceId,
    revision: version,
  });
}

interface InvoiceRow {
  id: string;
  status: string;
  version: number;
  invoiceNumber: string;
  jobId: string;
  customerId: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  issueDate: string;
  dueDate: string;
  currency: string;
  gstRegistered: boolean;
  pricesEntered: 'exclusive' | 'inclusive';
  approvedAt: Date | null;
  externalInvoiceId: string | null;
  totalCents: number;
  accountCode: string;
}

interface LineRow {
  kind: string;
  description: string;
  unit: string;
  quantityMilli: number;
  unitPriceCents: number;
  taxCode: 'standard' | 'zero_rated' | 'exempt';
  discountBp: number;
  lineTotalCents: number;
}

async function loadInvoice(client: Queryable, tenantId: string, invoiceId: string) {
  const result = await client.query<InvoiceRow>(
    `SELECT i.id,i.status,i.version,i.invoice_number AS "invoiceNumber",i.job_id AS "jobId",i.customer_id AS "customerId",
       c.name AS "customerName",c.email AS "customerEmail",c.phone AS "customerPhone",
       to_char(i.issue_date,'YYYY-MM-DD') AS "issueDate",to_char(i.due_date,'YYYY-MM-DD') AS "dueDate",i.currency,
       i.gst_registered AS "gstRegistered",i.prices_entered AS "pricesEntered",i.approved_at AS "approvedAt",
       i.external_invoice_id AS "externalInvoiceId",i.total_cents AS "totalCents",b.accounting_sales_account_code AS "accountCode"
     FROM invoices i JOIN customers c ON c.tenant_id=i.tenant_id AND c.id=i.customer_id
       JOIN businesses b ON b.id=i.tenant_id
     WHERE i.tenant_id=$1 AND i.id=$2`,
    [tenantId, invoiceId],
  );
  return result.rows[0] ?? null;
}

/**
 * Map our priced lines to the provider contract. Amounts are our engine's figures: a line with
 * a percentage discount is sent as one unit at its discounted amount, so the ledger line equals
 * ours exactly. Negative (discount) lines are not supported by the contract yet.
 */
export function toDraftInvoiceLines(
  lines: readonly LineRow[],
  accountCode: string,
): DraftInvoiceLine[] {
  if (lines.some((line) => line.kind === 'discount'))
    throw new ValidationError(
      'Invoices with discount lines cannot be posted yet.',
      'discount_lines_unsupported',
      'opentradie',
      ['Replace the discount line with a percentage discount on the lines it applies to.'],
    );
  return lines.map((line) =>
    line.discountBp > 0
      ? {
          description: `${line.description} (${formatQuantityMilli(line.quantityMilli)} ${line.unit} at ${formatSignedCents(line.unitPriceCents)} less ${line.discountBp / 100}% discount)`,
          quantityMilli: 1000,
          unitAmountCents: line.lineTotalCents,
          accountCode,
          taxCode: line.taxCode,
        }
      : {
          description: line.description,
          quantityMilli: line.quantityMilli,
          unitAmountCents: line.unitPriceCents,
          accountCode,
          taxCode: line.taxCode,
        },
  );
}

async function loadLines(client: Queryable, tenantId: string, invoiceId: string) {
  const result = await client.query<LineRow>(
    `SELECT kind,description,unit,quantity_milli AS "quantityMilli",unit_price_cents AS "unitPriceCents",tax_code AS "taxCode",
       discount_bp AS "discountBp",line_total_cents AS "lineTotalCents"
     FROM invoice_lines WHERE tenant_id=$1 AND invoice_id=$2 ORDER BY position`,
    [tenantId, invoiceId],
  );
  return result.rows;
}

/** Provider context for the tenant, or the sync error that prevents one. */
async function accountingContext(
  accounting: AccountingRuntime,
  tenantId: string,
): Promise<AccountingContext | SyncErrorKind> {
  const connection = await accounting.connections.get(tenantId, accounting.provider);
  if (!connection) return 'not_connected';
  if (connection.status === 'error') return 'reauthorisation_required';
  if (connection.status !== 'connected') return 'not_connected';
  if (!connection.externalAccountId) return 'organisation_required';
  return { tenantId, organisationId: connection.externalAccountId };
}

function hourBucket(date: Date): string {
  return date.toISOString().slice(0, 13);
}

/** Enqueue the next periodic reconciliation; one task per hour bucket per tenant. */
export function scheduleReconcile(
  queue: PostgresJobQueue,
  client: Queryable,
  tenantId: string,
  runAt: Date,
) {
  return queue.enqueue(
    {
      tenantId,
      kind: RECONCILE_TASK_KIND,
      payload: {},
      idempotencyKey: `reconcile:${hourBucket(runAt)}`,
      runAt,
      maxAttempts: 3,
    },
    client,
  );
}

interface PostTask {
  id: string;
  tenantId: string;
  attempts: number;
  maxAttempts: number;
}

async function recordAttempt(
  client: Queryable,
  input: {
    tenantId: string;
    invoiceId: string;
    provider: string;
    key: string;
    taskId: string;
  },
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO accounting_sync_attempts(id,tenant_id,invoice_id,provider,operation,idempotency_key,attempt,status,task_id)
     VALUES($1,$2,$3,$4,'post_invoice',$5,
       1 + (SELECT count(*) FROM accounting_sync_attempts WHERE tenant_id=$2 AND invoice_id=$3 AND operation='post_invoice'),
       'started',$6)`,
    [id, input.tenantId, input.invoiceId, input.provider, input.key, input.taskId],
  );
  return id;
}

async function finishAttempt(
  client: Queryable,
  attemptId: string,
  status: 'succeeded' | 'linked_existing' | 'retry_scheduled' | 'failed',
  detail: { errorKind?: string; errorCode?: string; externalInvoiceId?: string } = {},
) {
  await client.query(
    `UPDATE accounting_sync_attempts SET status=$2,error_kind=$3,error_code=$4,external_invoice_id=$5,finished_at=now() WHERE id=$1`,
    [
      attemptId,
      status,
      detail.errorKind ?? null,
      detail.errorCode?.slice(0, 64) ?? null,
      detail.externalInvoiceId ?? null,
    ],
  );
}

async function markSyncFailed(
  db: Database,
  input: {
    tenantId: string;
    invoice: InvoiceRow;
    attemptId: string | null;
    kind: SyncErrorKind;
    error: IntegrationError | null;
    taskId: string;
  },
) {
  const issues =
    input.error && 'issues' in input.error ? [...(input.error.issues as readonly string[])] : [];
  await transaction(db, async (client) => {
    const updated = await client.query(
      `UPDATE invoices SET status='sync_failed',sync_error_kind=$3,sync_error_message=$4,sync_error_issues=$5,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND status IN ('approved','posting')`,
      [
        input.tenantId,
        input.invoice.id,
        input.kind,
        SYNC_ERROR_MESSAGES[input.kind],
        JSON.stringify(issues.slice(0, 20).map((issue) => issue.slice(0, 300))),
      ],
    );
    if (input.attemptId)
      await finishAttempt(client, input.attemptId, 'failed', {
        errorKind: input.error?.kind ?? input.kind,
        ...(input.error ? { errorCode: input.error.code } : {}),
      });
    if (!updated.rowCount) return;
    await recordJobEvent(client, {
      tenantId: input.tenantId,
      jobId: input.invoice.jobId,
      type: 'invoice_sync_failed',
      actorType: 'system',
      actorId: null,
      summary: `Invoice ${input.invoice.invoiceNumber} could not be posted to accounting`,
      metadata: { invoiceId: input.invoice.id, errorKind: input.kind },
    });
    await recordAudit(client, {
      tenantId: input.tenantId,
      actorType: 'system',
      actorId: null,
      action: 'invoice.sync_failed',
      entityType: 'invoice',
      entityId: input.invoice.id,
      requestId: `task:${input.taskId}`,
      metadata: {
        errorKind: input.kind,
        errorCode: input.error?.code ?? null,
        issues: issues.length,
      },
    });
  });
}

/**
 * Find a ledger invoice this OPENTRADIE invoice already created, in order: the stored external
 * reference, then the provider's Reference field (our invoice number). This covers a crash after
 * the provider created the invoice but before our commit, even if the provider has forgotten the
 * idempotency key by the time we retry.
 */
async function findExisting(
  accounting: AccountingRuntime,
  context: AccountingContext,
  invoice: InvoiceRow,
): Promise<{ snapshot: InvoiceSnapshot; via: 'reference' | 'provider_reference' } | null> {
  const known = await accounting.references.get(
    context.tenantId,
    accounting.provider,
    'invoice',
    invoice.id,
  );
  if (known)
    return { snapshot: await accounting.adapter.getInvoice(context, known), via: 'reference' };
  const since = new Date((invoice.approvedAt ?? new Date()).getTime() - 24 * 60 * 60_000);
  const candidates = await accounting.adapter.listInvoiceChangesSince(context, since);
  const match = candidates.find(
    (candidate) =>
      candidate.reference === invoice.invoiceNumber &&
      candidate.status !== 'deleted' &&
      candidate.status !== 'voided',
  );
  if (!match) return null;
  await accounting.references.put(
    context.tenantId,
    accounting.provider,
    'invoice',
    invoice.id,
    match.externalInvoiceId,
  );
  return { snapshot: match, via: 'provider_reference' };
}

/**
 * The `accounting.post_invoice` handler: push an owner-approved invoice to the ledger as a
 * draft, at most once. Safe to run any number of times for the same invoice.
 */
export async function postInvoice(
  db: Database,
  accounting: AccountingRuntime,
  queue: PostgresJobQueue,
  task: PostTask,
  invoiceId: string,
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) throw new PermanentTaskError('Invalid invoice id.');
  // One poster per invoice at a time, across processes. Session lock on a dedicated client.
  const lockClient = await db.pool.connect();
  try {
    const locked = await lockClient.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok',
      [`post_invoice:${task.tenantId}:${invoiceId}`],
    );
    if (!locked.rows[0]!.ok)
      throw new RetryLaterTaskError('Invoice is being posted by another worker.', 30_000);
    try {
      await postInvoiceLocked(db, accounting, queue, task, invoiceId);
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
        `post_invoice:${task.tenantId}:${invoiceId}`,
      ]);
    }
  } finally {
    lockClient.release();
  }
}

async function postInvoiceLocked(
  db: Database,
  accounting: AccountingRuntime,
  queue: PostgresJobQueue,
  task: PostTask,
  invoiceId: string,
): Promise<void> {
  const tenantId = task.tenantId;
  const invoice = await loadInvoice(db.pool, tenantId, invoiceId);
  if (!invoice) throw new PermanentTaskError('Invoice not found for this tenant.');
  // Already posted (or withdrawn/never approved): nothing to do. This is what makes redelivery safe.
  if (invoice.status !== 'approved' && invoice.status !== 'posting') return;
  const key = postingIdempotencyKey(tenantId, invoice.id, invoice.version);

  const attemptId = await transaction(db, async (client) => {
    await client.query(
      "UPDATE invoices SET status='posting',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('approved','posting')",
      [tenantId, invoice.id],
    );
    return recordAttempt(client, {
      tenantId,
      invoiceId: invoice.id,
      provider: accounting.provider,
      key,
      taskId: task.id,
    });
  });
  const fail = (kind: SyncErrorKind, error: IntegrationError | null) =>
    markSyncFailed(db, { tenantId, invoice, attemptId, kind, error, taskId: task.id });

  const context = await accountingContext(accounting, tenantId);
  if (typeof context === 'string') return fail(context, null);

  let lines: DraftInvoiceLine[];
  try {
    lines = toDraftInvoiceLines(
      await loadLines(db.pool, tenantId, invoice.id),
      invoice.accountCode,
    );
  } catch (error) {
    if (error instanceof ValidationError) return fail('unsupported', error);
    throw error;
  }
  const push: PushInvoiceInput = {
    customer: {
      customerId: invoice.customerId,
      name: invoice.customerName,
      email: invoice.customerEmail,
      phone: invoice.customerPhone,
    },
    invoiceId: invoice.id,
    revision: invoice.version,
    invoice: {
      invoiceNumber: invoice.invoiceNumber,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      lineAmountMode: invoice.gstRegistered ? invoice.pricesEntered : 'no_tax',
      lines,
    },
  };
  const sync = new AccountingSyncService(accounting.adapter, accounting.references);
  const attemptPush = async () => {
    const existing = await findExisting(accounting, context, invoice);
    if (existing) return { snapshot: existing.snapshot, linked: true };
    return { snapshot: await sync.pushDraftInvoice(context, push), linked: false };
  };

  let outcome: { snapshot: InvoiceSnapshot; linked: boolean };
  try {
    try {
      outcome = await attemptPush();
    } catch (error) {
      // A rejected access token: refresh once and retry with the same idempotency keys.
      if (!(error instanceof AuthExpiredError)) throw error;
      await accounting.adapter.refreshTokens(tenantId);
      outcome = await attemptPush();
    }
  } catch (error) {
    if (!isIntegrationError(error)) throw error;
    if (error instanceof ReauthorisationRequiredError || error instanceof AuthExpiredError) {
      await accounting.tokens.markReauthorisationRequired(tenantId, accounting.provider);
      return fail('reauthorisation_required', error);
    }
    const exhausted = task.attempts >= task.maxAttempts;
    if (error instanceof RateLimitedError || error.kind === 'transient') {
      if (exhausted) return fail('transient_exhausted', error);
      await finishAttempt(db.pool, attemptId, 'retry_scheduled', {
        errorKind: error.kind,
        errorCode: error.code,
      });
      if (error instanceof RateLimitedError)
        throw new RetryLaterTaskError(
          'Accounting provider rate limit; retrying after its delay.',
          error.retryAfterSeconds * 1000,
        );
      throw error;
    }
    return fail(
      error.kind === 'validation'
        ? 'validation'
        : error.kind === 'conflict'
          ? 'conflict'
          : 'permanent',
      error,
    );
  }

  const { snapshot, linked } = outcome;
  await transaction(db, async (client) => {
    const updated = await client.query(
      `UPDATE invoices SET status='posted',accounting_provider=$3,external_invoice_id=$4,provider_invoice_number=$5,provider_status=$6,
         provider_total_cents=$7,posted_at=now(),sync_error_kind=NULL,sync_error_message=NULL,sync_error_issues='[]',updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND status IN ('approved','posting')`,
      [
        tenantId,
        invoice.id,
        accounting.provider,
        snapshot.externalInvoiceId,
        snapshot.providerInvoiceNumber,
        snapshot.status,
        snapshot.totalCents,
      ],
    );
    await finishAttempt(client, attemptId, linked ? 'linked_existing' : 'succeeded', {
      externalInvoiceId: snapshot.externalInvoiceId,
    });
    if (!updated.rowCount) return;
    await recordJobEvent(client, {
      tenantId,
      jobId: invoice.jobId,
      type: 'invoice_posted',
      actorType: 'system',
      actorId: null,
      summary: `Invoice ${invoice.invoiceNumber} posted to ${accounting.kind === 'mock' ? 'the mock accounting adapter' : accounting.label} as a draft`,
      metadata: { invoiceId: invoice.id, linkedExisting: linked },
    });
    await recordAudit(client, {
      tenantId,
      actorType: 'system',
      actorId: null,
      action: 'invoice.posted',
      entityType: 'invoice',
      entityId: invoice.id,
      requestId: `task:${task.id}`,
      metadata: {
        provider: accounting.provider,
        externalInvoiceId: snapshot.externalInvoiceId,
        linkedExisting: linked,
        totalMatches: snapshot.totalCents === invoice.totalCents,
      },
    });
    await scheduleReconcile(queue, client, tenantId, new Date(Date.now() + RECONCILE_INTERVAL_MS));
  });
}

export interface ReconcileSummary {
  checked: number;
  updated: number;
  paid: number;
  failed: number;
  /** Set when the connection could not be used at all. */
  blocked: SyncErrorKind | null;
}

function localStatusFor(snapshot: InvoiceSnapshot): 'posted' | 'part_paid' | 'paid' {
  if (snapshot.status === 'paid' || (snapshot.amountPaidCents > 0 && snapshot.amountDueCents <= 0))
    return 'paid';
  if (snapshot.amountPaidCents > 0) return 'part_paid';
  return 'posted';
}

/**
 * Read status and payments for posted invoices back from the ledger into payment_snapshots and
 * the invoice status (posted → part_paid → paid). Provider figures are stored, never recomputed.
 */
export async function reconcileInvoices(
  db: Database,
  accounting: AccountingRuntime,
  tenantId: string,
  options: { requestId: string; invoiceId?: string; limit?: number },
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { checked: 0, updated: 0, paid: 0, failed: 0, blocked: null };
  const context = await accountingContext(accounting, tenantId);
  if (typeof context === 'string') return { ...summary, blocked: context };
  const open = await db.pool.query<{
    id: string;
    jobId: string;
    invoiceNumber: string;
    status: string;
    externalInvoiceId: string;
  }>(
    `SELECT id,job_id AS "jobId",invoice_number AS "invoiceNumber",status,external_invoice_id AS "externalInvoiceId"
     FROM invoices WHERE tenant_id=$1 AND accounting_provider=$2 AND status IN ('posted','part_paid')
       AND ($3::uuid IS NULL OR id=$3) ORDER BY last_reconciled_at NULLS FIRST, posted_at LIMIT $4`,
    [tenantId, accounting.provider, options.invoiceId ?? null, options.limit ?? 200],
  );
  for (const invoice of open.rows) {
    summary.checked += 1;
    let snapshot: InvoiceSnapshot;
    try {
      snapshot = await accounting.adapter.getInvoice(context, invoice.externalInvoiceId);
    } catch (error) {
      if (error instanceof ReauthorisationRequiredError) {
        await accounting.tokens.markReauthorisationRequired(tenantId, accounting.provider);
        return { ...summary, failed: summary.failed + 1, blocked: 'reauthorisation_required' };
      }
      if (!isIntegrationError(error)) throw error;
      summary.failed += 1;
      continue;
    }
    const next = localStatusFor(snapshot);
    await transaction(db, async (client) => {
      await client.query(
        `INSERT INTO payment_snapshots(id,tenant_id,invoice_id,provider,external_invoice_id,provider_status,total_cents,amount_paid_cents,amount_due_cents)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          randomUUID(),
          tenantId,
          invoice.id,
          accounting.provider,
          snapshot.externalInvoiceId,
          snapshot.status,
          snapshot.totalCents,
          snapshot.amountPaidCents,
          snapshot.amountDueCents,
        ],
      );
      const changed = await client.query(
        `UPDATE invoices SET status=$3,provider_status=$4,provider_total_cents=$5,amount_paid_cents=$6,amount_due_cents=$7,
           provider_invoice_number=coalesce($8,provider_invoice_number),last_reconciled_at=now(),updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status IN ('posted','part_paid')`,
        [
          tenantId,
          invoice.id,
          next,
          snapshot.status,
          snapshot.totalCents,
          snapshot.amountPaidCents,
          snapshot.amountDueCents,
          snapshot.providerInvoiceNumber,
        ],
      );
      if (!changed.rowCount || next === invoice.status) return;
      summary.updated += 1;
      if (next === 'paid') summary.paid += 1;
      await recordJobEvent(client, {
        tenantId,
        jobId: invoice.jobId,
        type: next === 'paid' ? 'invoice_paid' : 'invoice_posted',
        actorType: 'system',
        actorId: null,
        summary:
          next === 'paid'
            ? `Invoice ${invoice.invoiceNumber} paid (per accounting system)`
            : `Invoice ${invoice.invoiceNumber} part paid (per accounting system)`,
        metadata: { invoiceId: invoice.id, amountPaidCents: snapshot.amountPaidCents },
      });
      await recordAudit(client, {
        tenantId,
        actorType: 'system',
        actorId: null,
        action: 'invoice.payment_status_changed',
        entityType: 'invoice',
        entityId: invoice.id,
        requestId: options.requestId,
        metadata: { from: invoice.status, to: next, providerStatus: snapshot.status },
      });
    });
  }
  return summary;
}

/** Worker handlers for invoice posting and reconciliation. */
export function createAccountingHandlers(options: {
  queue: PostgresJobQueue;
  accounting: AccountingRuntime;
}) {
  const { queue, accounting } = options;
  return {
    [POST_INVOICE_TOPIC]: async (
      task: PostTask & { payload: Record<string, unknown> },
      { db }: { db: Database },
    ) => postInvoice(db, accounting, queue, task, String(task.payload.invoiceId ?? '')),
    [RECONCILE_TASK_KIND]: async (
      task: PostTask & { payload: Record<string, unknown> },
      { db }: { db: Database },
    ) => {
      const summary = await reconcileInvoices(db, accounting, task.tenantId, {
        requestId: `task:${task.id}`,
      });
      // Keep reconciling while anything is still open (a chain of hourly tasks, not cron).
      const open = await db.pool.query(
        "SELECT 1 FROM invoices WHERE tenant_id=$1 AND status IN ('posted','part_paid') LIMIT 1",
        [task.tenantId],
      );
      if (open.rowCount && !summary.blocked)
        await scheduleReconcile(
          queue,
          db.pool,
          task.tenantId,
          new Date(Date.now() + RECONCILE_INTERVAL_MS),
        );
    },
  };
}
