/**
 * Unpaid invoice follow-ups (Workflow D, ADR 0027). Pure stage decision: given an invoice, the
 * business follow-up policy and `now`, which follow-up (if any) is due. Days are counted in
 * calendar days in the business time zone, so DST changes never shift a stage by a day.
 */
import { formatCents } from './money.js';
import { instantToLocal, parseLocalDate } from './scheduling.js';

export const COLLECTION_STAGES = [
  'pre_due_courtesy',
  'overdue_1',
  'overdue_2',
  'overdue_final',
  'escalate_owner',
] as const;
export type CollectionStage = (typeof COLLECTION_STAGES)[number];
/** Stages that message the customer; escalate_owner only creates an owner task. */
export const CUSTOMER_STAGES = [
  'pre_due_courtesy',
  'overdue_1',
  'overdue_2',
  'overdue_final',
] as const;
export type CustomerStage = (typeof CUSTOMER_STAGES)[number];

export interface CollectionsPolicy {
  enabled: boolean;
  preDueCourtesyEnabled: boolean;
  /** Days before the due date for the optional courtesy note. */
  preDueDays: number;
  overdue1Days: number;
  overdue2Days: number;
  overdueFinalDays: number;
  escalateDays: number;
  /** Per stage: true sends without owner approval (when a mailbox is connected). */
  autoSend: Record<CustomerStage, boolean>;
}

export const DEFAULT_COLLECTIONS_POLICY: CollectionsPolicy = {
  enabled: false,
  preDueCourtesyEnabled: false,
  preDueDays: 3,
  overdue1Days: 7,
  overdue2Days: 14,
  overdueFinalDays: 30,
  escalateDays: 45,
  autoSend: { pre_due_courtesy: false, overdue_1: false, overdue_2: false, overdue_final: false },
};

/** Returns problems with a policy's day offsets (empty when valid). */
export function collectionsPolicyErrors(policy: CollectionsPolicy): string[] {
  const errors: string[] = [];
  const days = [
    policy.overdue1Days,
    policy.overdue2Days,
    policy.overdueFinalDays,
    policy.escalateDays,
  ];
  if (![policy.preDueDays, ...days].every((d) => Number.isInteger(d) && d >= 1 && d <= 365))
    errors.push('Day offsets must be whole numbers from 1 to 365.');
  for (let i = 1; i < days.length; i++)
    if (days[i]! <= days[i - 1]!) errors.push('Each stage must come after the previous one.');
  return errors;
}

export interface CollectionsInvoice {
  /** invoices.status */
  status: string;
  /** YYYY-MM-DD */
  dueDate: string;
  totalCents: number;
  /** Latest payment snapshot's amount due (provider figure), when one exists. */
  snapshotAmountDueCents: number | null;
  /** Latest snapshot's provider status, when one exists. */
  snapshotProviderStatus: string | null;
  onHold: boolean;
  customerErased: boolean;
  /** Stages already prepared (or escalated) for this invoice. */
  preparedStages: readonly string[];
}

export type CollectionsSuppression =
  | 'disabled'
  | 'not_posted'
  | 'paid'
  | 'void'
  | 'nothing_due'
  | 'on_hold'
  | 'customer_erased'
  | 'not_due'
  | 'already_prepared';

export type CollectionsDecision =
  | { stage: CollectionStage; daysOverdue: number; amountDueCents: number }
  | { stage: 'none'; reason: CollectionsSuppression; daysOverdue: number };

/** Whole calendar days from `from` to `to` (both YYYY-MM-DD). */
export function calendarDaysBetween(from: string, to: string): number {
  const a = parseLocalDate(from);
  const b = parseLocalDate(to);
  if (!a || !b) throw new RangeError('Invalid local date.');
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000,
  );
}

/** Days past the due date in the business time zone (negative before it). */
export function daysOverdue(dueDate: string, now: Date, timeZone: string): number {
  return calendarDaysBetween(dueDate, instantToLocal(now.getTime(), timeZone).date);
}

/** The amount still owed: the provider's latest figure when known, else the invoice total. */
export function amountDue(invoice: CollectionsInvoice): number {
  return invoice.snapshotAmountDueCents ?? invoice.totalCents;
}

export function decideCollectionStage(
  invoice: CollectionsInvoice,
  policy: CollectionsPolicy,
  now: Date,
  timeZone = 'Pacific/Auckland',
): CollectionsDecision {
  const overdue = daysOverdue(invoice.dueDate, now, timeZone);
  const none = (reason: CollectionsSuppression): CollectionsDecision => ({
    stage: 'none',
    reason,
    daysOverdue: overdue,
  });
  if (!policy.enabled) return none('disabled');
  if (invoice.status === 'paid' || invoice.snapshotProviderStatus === 'paid') return none('paid');
  if (invoice.status === 'void' || invoice.snapshotProviderStatus === 'voided') return none('void');
  if (invoice.status !== 'posted' && invoice.status !== 'part_paid') return none('not_posted');
  const due = amountDue(invoice);
  if (due <= 0) return none('nothing_due');
  if (invoice.onHold) return none('on_hold');
  if (invoice.customerErased) return none('customer_erased');

  let stage: CollectionStage | null = null;
  if (overdue >= policy.escalateDays) stage = 'escalate_owner';
  else if (overdue >= policy.overdueFinalDays) stage = 'overdue_final';
  else if (overdue >= policy.overdue2Days) stage = 'overdue_2';
  else if (overdue >= policy.overdue1Days) stage = 'overdue_1';
  else if (policy.preDueCourtesyEnabled && overdue < 0 && -overdue <= policy.preDueDays)
    stage = 'pre_due_courtesy';
  if (!stage) return none('not_due');
  if (invoice.preparedStages.includes(stage)) return none('already_prepared');
  return { stage, daysOverdue: overdue, amountDueCents: due };
}

export interface FollowUpTemplateInput {
  stage: CustomerStage;
  customerName: string;
  businessName: string;
  invoiceNumber: string;
  amountDueCents: number;
  currency: string;
  dueDate: string;
  daysOverdue: number;
}

function formatDueDate(date: string): string {
  const parts = parseLocalDate(date);
  if (!parts) return date;
  return new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day)));
}

/**
 * Deterministic customer wording. Every figure comes from the invoice record and the latest
 * provider snapshot (integer cents); nothing is model-generated. The owner may edit it before
 * approving.
 */
export function followUpEmail(input: FollowUpTemplateInput): { subject: string; text: string } {
  const amount = formatCents(input.amountDueCents, input.currency);
  const due = formatDueDate(input.dueDate);
  const days = `${input.daysOverdue} day${input.daysOverdue === 1 ? '' : 's'}`;
  const sign = `\n\nNgā mihi,\n${input.businessName}`;
  const greeting = `Kia ora ${input.customerName},\n\n`;
  switch (input.stage) {
    case 'pre_due_courtesy':
      return {
        subject: `Invoice ${input.invoiceNumber} due ${due}`,
        text: `${greeting}A friendly note that invoice ${input.invoiceNumber} for ${amount} is due on ${due}. If you have already paid, thank you and please ignore this message.${sign}`,
      };
    case 'overdue_1':
      return {
        subject: `Reminder: invoice ${input.invoiceNumber} is overdue`,
        text: `${greeting}Our records show invoice ${input.invoiceNumber} for ${amount} was due on ${due} and is now ${days} overdue. If you have already paid, thank you and please ignore this message. Otherwise we would appreciate payment at your earliest convenience.${sign}`,
      };
    case 'overdue_2':
      return {
        subject: `Second reminder: invoice ${input.invoiceNumber} is overdue`,
        text: `${greeting}Invoice ${input.invoiceNumber} for ${amount} was due on ${due} and is now ${days} overdue. Could you please arrange payment, or reply to let us know if there is a problem with the invoice?${sign}`,
      };
    case 'overdue_final':
      return {
        subject: `Final reminder: invoice ${input.invoiceNumber} is overdue`,
        text: `${greeting}Invoice ${input.invoiceNumber} for ${amount} was due on ${due} and is now ${days} overdue. Please arrange payment within 7 days, or contact us to discuss a payment arrangement.${sign}`,
      };
  }
}
