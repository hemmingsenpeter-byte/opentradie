import { z } from 'zod';
import { JOB_STATUSES } from './job-status.js';

/**
 * Domain event catalogue for owner-defined automations (ADR 0033).
 *
 * Events are emitted by the backend in the same transaction as the business change (through the
 * transactional outbox, ADR 0012). Payloads carry identifiers, enums and small integers only:
 * never message bodies, names, prices or provider responses. Facts an automation needs (job
 * title, quote total, customer first name) are read from the records when the engine evaluates
 * a run, so a delayed run always sees current state.
 */

const uuid = z.string().uuid();

/** Identifiers of the records an event is about. All optional; each event documents its own. */
export const automationEventRefsSchema = z
  .object({
    jobId: uuid.optional(),
    customerId: uuid.optional(),
    quoteId: uuid.optional(),
    appointmentId: uuid.optional(),
    invoiceId: uuid.optional(),
    communicationId: uuid.optional(),
    taskId: uuid.optional(),
  })
  .strict();
export type AutomationEventRefs = z.infer<typeof automationEventRefsSchema>;

const jobStatus = z.enum(JOB_STATUSES);

export const AUTOMATION_EVENT_DATA = {
  'quote.sent': z.object({}).strict(),
  'quote.accepted': z.object({}).strict(),
  'quote.declined': z.object({}).strict(),
  'quote.expired': z.object({}).strict(),
  'job.status_changed': z.object({ from: jobStatus.nullable(), to: jobStatus }).strict(),
  'job.completed': z.object({}).strict(),
  'appointment.booked': z.object({ status: z.enum(['proposed', 'confirmed']) }).strict(),
  'appointment.cancelled': z.object({}).strict(),
  /** Emitted by the hourly automation tick, once per appointment per local day before it. */
  'appointment.upcoming': z.object({ daysUntil: z.number().int().min(0).max(7) }).strict(),
  'invoice.posted': z.object({}).strict(),
  /** Emitted by the hourly tick, once per invoice per local day while it is overdue. */
  'invoice.overdue': z.object({ daysOverdue: z.number().int().min(1).max(3650) }).strict(),
  'invoice.paid': z.object({}).strict(),
  'message.received': z
    .object({ channel: z.enum(['email', 'sms', 'whatsapp', 'manual']) })
    .strict(),
  'task.created': z.object({ kind: z.string().max(40) }).strict(),
  /** A scheduled automation's own clock (daily/weekly at a local time). */
  schedule: z.object({ localDate: z.iso.date(), automationId: uuid }).strict(),
} as const;

export type AutomationEventName = keyof typeof AUTOMATION_EVENT_DATA;
export const AUTOMATION_EVENT_NAMES = Object.keys(AUTOMATION_EVENT_DATA) as AutomationEventName[];

export interface AutomationEventInfo {
  title: string;
  /** Which record the event is about; one run per (automation, entity, occurrence). */
  entity: 'job' | 'quote' | 'appointment' | 'invoice' | 'communication' | 'task' | 'business';
  /** Refs the emitter always provides. */
  refs: Array<keyof AutomationEventRefs>;
}

export const AUTOMATION_EVENTS: Record<AutomationEventName, AutomationEventInfo> = {
  'quote.sent': { title: 'a quote is sent', entity: 'quote', refs: ['jobId', 'quoteId'] },
  'quote.accepted': { title: 'a quote is accepted', entity: 'quote', refs: ['jobId', 'quoteId'] },
  'quote.declined': { title: 'a quote is declined', entity: 'quote', refs: ['jobId', 'quoteId'] },
  'quote.expired': { title: 'a quote expires', entity: 'quote', refs: ['jobId', 'quoteId'] },
  'job.status_changed': { title: 'a job changes status', entity: 'job', refs: ['jobId'] },
  'job.completed': { title: 'a job is completed', entity: 'job', refs: ['jobId'] },
  'appointment.booked': {
    title: 'an appointment is booked',
    entity: 'appointment',
    refs: ['jobId', 'appointmentId'],
  },
  'appointment.cancelled': {
    title: 'an appointment is cancelled',
    entity: 'appointment',
    refs: ['jobId', 'appointmentId'],
  },
  'appointment.upcoming': {
    title: 'an appointment is coming up',
    entity: 'appointment',
    refs: ['jobId', 'appointmentId'],
  },
  'invoice.posted': {
    title: 'an invoice is posted',
    entity: 'invoice',
    refs: ['jobId', 'invoiceId'],
  },
  'invoice.overdue': {
    title: 'an invoice is overdue',
    entity: 'invoice',
    refs: ['jobId', 'invoiceId'],
  },
  'invoice.paid': { title: 'an invoice is paid', entity: 'invoice', refs: ['jobId', 'invoiceId'] },
  'message.received': {
    title: 'a customer message arrives',
    entity: 'communication',
    refs: ['communicationId'],
  },
  'task.created': { title: 'a task is created', entity: 'task', refs: ['taskId'] },
  schedule: { title: 'the schedule comes round', entity: 'business', refs: [] },
};

/** The outbox topic (and job-queue kind) every automation event is written under. */
export const AUTOMATION_EVENT_TOPIC = 'automation.event';
/** Nested automation runs beyond this depth are skipped (loop guard). */
export const MAX_AUTOMATION_DEPTH = 3;

export const automationEventEnvelopeSchema = z
  .object({
    event: z.enum(AUTOMATION_EVENT_NAMES as [AutomationEventName, ...AutomationEventName[]]),
    refs: automationEventRefsSchema,
    data: z.record(z.string(), z.unknown()),
    /** Occurrence key: unique per emitted event (job event id, tick bucket). */
    occurrence: z.string().min(1).max(160),
    occurredAt: z.iso.datetime({ offset: true }),
    /** Automation nesting depth of the transaction that emitted this event. */
    depth: z.number().int().min(0).max(100).default(0),
    /** The automation whose run emitted this event, when any. */
    sourceAutomationId: uuid.nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    const parsed = AUTOMATION_EVENT_DATA[value.event].safeParse(value.data);
    if (!parsed.success) context.addIssue({ code: 'custom', message: 'Invalid event data.' });
  });
export type AutomationEventEnvelope = z.infer<typeof automationEventEnvelopeSchema>;

/**
 * The automation event a job timeline entry implies, if any (one entry may imply two: a status
 * change to completed is also `job.completed`). Pure, so tests can pin the mapping.
 */
export function automationEventsForJobEvent(input: {
  type: string;
  fromStatus?: string | null | undefined;
  toStatus?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}): Array<{
  event: AutomationEventName;
  refs: AutomationEventRefs;
  data: Record<string, unknown>;
}> {
  const meta = input.metadata ?? {};
  const id = (key: string): string | undefined => {
    const value = meta[key];
    return typeof value === 'string' && uuid.safeParse(value).success ? value : undefined;
  };
  const quoteId = id('quoteId');
  const appointmentId = id('appointmentId');
  const invoiceId = id('invoiceId');
  switch (input.type) {
    case 'status_changed': {
      const to = jobStatus.safeParse(input.toStatus);
      if (!to.success) return [];
      const from = jobStatus.safeParse(input.fromStatus);
      const changed = {
        event: 'job.status_changed' as const,
        refs: {},
        data: { from: from.success ? from.data : null, to: to.data },
      };
      return to.data === 'completed'
        ? [changed, { event: 'job.completed', refs: {}, data: {} }]
        : [changed];
    }
    case 'quote_sent':
    case 'quote_accepted':
    case 'quote_declined':
    case 'quote_expired':
      return quoteId
        ? [
            {
              event: `quote.${input.type.slice(6)}` as AutomationEventName,
              refs: { quoteId },
              data: {},
            },
          ]
        : [];
    case 'appointment_scheduled': {
      const status = meta.status === 'confirmed' ? 'confirmed' : 'proposed';
      return appointmentId
        ? [{ event: 'appointment.booked', refs: { appointmentId }, data: { status } }]
        : [];
    }
    case 'appointment_cancelled':
      return appointmentId
        ? [{ event: 'appointment.cancelled', refs: { appointmentId }, data: {} }]
        : [];
    case 'invoice_posted':
      // A part payment is also recorded as invoice_posted (with an amount); it is not a new posting.
      return invoiceId && meta.amountPaidCents === undefined
        ? [{ event: 'invoice.posted', refs: { invoiceId }, data: {} }]
        : [];
    case 'invoice_paid':
      return invoiceId ? [{ event: 'invoice.paid', refs: { invoiceId }, data: {} }] : [];
    default:
      return [];
  }
}
