/**
 * Deterministic task rules (Feature 16, ADR 0032). Given facts read from the database, the
 * business time zone and an injected `now`, each rule yields the owner to-dos that should exist
 * right now. The scan upserts them by dedupe key and resolves open rule tasks whose key is no
 * longer produced (the condition cleared). Pure: no I/O, no clock.
 */
import { addLocalDays, instantToLocal, localTimeToInstant } from './scheduling.js';

export const TASK_RULE_KEYS = [
  'book_job',
  'follow_up_quote',
  'reply_message',
  'invoice_job',
  'chase_payment',
] as const;
export type TaskRuleKey = (typeof TASK_RULE_KEYS)[number];
export type TaskPriorityValue = 'low' | 'normal' | 'high';

export interface TaskRuleSettings {
  rulesEnabled: boolean;
  followUpQuoteDays: number;
  replyAfterHours: number;
  invoiceAfterDays: number;
}

export const DEFAULT_TASK_RULE_SETTINGS: TaskRuleSettings = {
  rulesEnabled: true,
  followUpQuoteDays: 3,
  replyAfterHours: 24,
  invoiceAfterDays: 1,
};

export function taskSettingsErrors(settings: TaskRuleSettings): string[] {
  const errors: string[] = [];
  const range = (value: number, min: number, max: number, label: string) => {
    if (!Number.isInteger(value) || value < min || value > max)
      errors.push(`${label} must be a whole number from ${min} to ${max}.`);
  };
  range(settings.followUpQuoteDays, 1, 60, 'Quote follow-up days');
  range(settings.replyAfterHours, 1, 336, 'Reply-after hours');
  range(settings.invoiceAfterDays, 0, 60, 'Invoice-after days');
  return errors;
}

export interface TaskFacts {
  /** Accepted quotes whose job is not completed or cancelled. */
  acceptedQuotes: {
    quoteId: string;
    jobId: string;
    customerId: string;
    jobTitle: string;
    quoteNumber: string | null;
    acceptedAt: string;
    /** End times of the job's non-cancelled appointments. */
    appointmentEndsAt: string[];
  }[];
  /** Quotes in `sent` status (no customer decision yet). */
  sentQuotes: {
    quoteId: string;
    jobId: string;
    customerId: string;
    customerName: string;
    quoteNumber: string | null;
    sentAt: string;
  }[];
  /** Open threads, with their latest inbound message and whether a reply went out after it. */
  threads: {
    threadId: string;
    customerId: string | null;
    jobId: string | null;
    senderLabel: string;
    lastInboundId: string;
    lastInboundAt: string;
    repliedAfter: boolean;
  }[];
  /** Completed jobs. */
  completedJobs: {
    jobId: string;
    customerId: string;
    jobTitle: string;
    completedAt: string;
    invoiced: boolean;
  }[];
  /** Posted or part-paid invoices still owed. */
  owedInvoices: {
    invoiceId: string;
    jobId: string;
    customerId: string;
    customerName: string;
    invoiceNumber: string;
    dueDate: string;
    onHold: boolean;
    escalated: boolean;
  }[];
}

export interface RuleTask {
  ruleKey: TaskRuleKey;
  dedupeKey: string;
  kind: TaskRuleKey;
  title: string;
  dueAt: string;
  priority: TaskPriorityValue;
  links: {
    customerId: string | null;
    jobId: string | null;
    quoteId: string | null;
    invoiceId: string | null;
    threadId: string | null;
  };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const clip = (value: string, max = 120) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;
const noLinks = {
  customerId: null,
  jobId: null,
  quoteId: null,
  invoiceId: null,
  threadId: null,
};

/** Whole local calendar days from `fromDate` (YYYY-MM-DD) to the local date of `nowMs`. */
function localDaysSince(fromDate: string, nowMs: number, timeZone: string): number {
  const today = instantToLocal(nowMs, timeZone).date;
  return Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / DAY_MS,
  );
}

/** Collections settings the chase rule reads (packages/core/src/collections.ts). */
export interface ChaseSettings {
  overdueFinalDays: number;
}

export function evaluateTaskRules(
  facts: TaskFacts,
  settings: TaskRuleSettings,
  chase: ChaseSettings,
  now: Date,
  timeZone: string,
): RuleTask[] {
  if (!settings.rulesEnabled) return [];
  const nowMs = now.getTime();
  const out: RuleTask[] = [];

  for (const quote of facts.acceptedQuotes) {
    const booked = quote.appointmentEndsAt.some((end) => Date.parse(end) > nowMs);
    if (booked) continue;
    out.push({
      ruleKey: 'book_job',
      dedupeKey: `book_job:quote:${quote.quoteId}`,
      kind: 'book_job',
      title: clip(`Book in: ${quote.jobTitle}`),
      dueAt: quote.acceptedAt,
      priority: 'high',
      links: {
        ...noLinks,
        customerId: quote.customerId,
        jobId: quote.jobId,
        quoteId: quote.quoteId,
      },
    });
  }

  for (const quote of facts.sentQuotes) {
    const due = Date.parse(quote.sentAt) + settings.followUpQuoteDays * DAY_MS;
    if (nowMs < due) continue;
    out.push({
      ruleKey: 'follow_up_quote',
      dedupeKey: `follow_up_quote:quote:${quote.quoteId}`,
      kind: 'follow_up_quote',
      title: clip(
        `Follow up quote ${quote.quoteNumber ?? ''} with ${quote.customerName}`.replace(
          /\s+/g,
          ' ',
        ),
      ),
      dueAt: new Date(due).toISOString(),
      priority: 'normal',
      links: {
        ...noLinks,
        customerId: quote.customerId,
        jobId: quote.jobId,
        quoteId: quote.quoteId,
      },
    });
  }

  for (const thread of facts.threads) {
    if (thread.repliedAfter) continue;
    const due = Date.parse(thread.lastInboundAt) + settings.replyAfterHours * HOUR_MS;
    if (nowMs < due) continue;
    out.push({
      ruleKey: 'reply_message',
      // Keyed by the message, so a new unanswered message after a reply is a new task.
      dedupeKey: `reply_message:message:${thread.lastInboundId}`,
      kind: 'reply_message',
      title: clip(`Reply to ${thread.senderLabel}`),
      dueAt: new Date(due).toISOString(),
      priority: 'high',
      links: {
        ...noLinks,
        customerId: thread.customerId,
        jobId: thread.jobId,
        threadId: thread.threadId,
      },
    });
  }

  for (const job of facts.completedJobs) {
    if (job.invoiced) continue;
    const due = Date.parse(job.completedAt) + settings.invoiceAfterDays * DAY_MS;
    if (nowMs < due) continue;
    out.push({
      ruleKey: 'invoice_job',
      dedupeKey: `invoice_job:job:${job.jobId}`,
      kind: 'invoice_job',
      title: clip(`Invoice: ${job.jobTitle}`),
      dueAt: new Date(due).toISOString(),
      priority: 'normal',
      links: { ...noLinks, customerId: job.customerId, jobId: job.jobId },
    });
  }

  for (const invoice of facts.owedInvoices) {
    if (invoice.onHold) continue;
    const overdueDays = localDaysSince(invoice.dueDate, nowMs, timeZone);
    if (!invoice.escalated && overdueDays <= chase.overdueFinalDays) continue;
    // Due at 9:00 am business time on the first day past the final reminder.
    const firstDay = addLocalDays(invoice.dueDate, chase.overdueFinalDays + 1);
    const dueMs = Math.min(localTimeToInstant(firstDay, 9 * 60, timeZone), nowMs);
    out.push({
      ruleKey: 'chase_payment',
      dedupeKey: `chase_payment:invoice:${invoice.invoiceId}`,
      kind: 'chase_payment',
      title: clip(`Call ${invoice.customerName} about invoice ${invoice.invoiceNumber}`),
      dueAt: new Date(dueMs).toISOString(),
      priority: 'high',
      links: {
        ...noLinks,
        customerId: invoice.customerId,
        jobId: invoice.jobId,
        invoiceId: invoice.invoiceId,
      },
    });
  }
  return out;
}

export type TaskBucket = 'overdue' | 'today' | 'upcoming' | 'snoozed' | 'closed';

/**
 * Where a task sits on the Today screen, by the business-local calendar day. Tasks without a due
 * time are today's. A snooze that has run out counts as open from the snooze time.
 */
export function taskBucket(
  task: { status: string; dueAt: string | null; snoozedUntil: string | null },
  now: Date,
  timeZone: string,
): TaskBucket {
  if (task.status === 'done' || task.status === 'dismissed') return 'closed';
  const nowMs = now.getTime();
  let due = task.dueAt;
  if (task.status === 'snoozed') {
    if (task.snoozedUntil && Date.parse(task.snoozedUntil) > nowMs) return 'snoozed';
    due = task.snoozedUntil;
  }
  if (!due) return 'today';
  const today = instantToLocal(nowMs, timeZone).date;
  const startOfToday = localTimeToInstant(today, 0, timeZone);
  const startOfTomorrow = localTimeToInstant(addLocalDays(today, 1), 0, timeZone);
  const dueMs = Date.parse(due);
  if (dueMs < startOfToday) return 'overdue';
  if (dueMs < startOfTomorrow) return 'today';
  return 'upcoming';
}
