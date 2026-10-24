import { z } from 'zod';
import {
  findPriceFields,
  TOOL_DEFINITIONS,
  type ApprovalMode,
  type ToolName,
} from './agent-tools.js';
import {
  AUTOMATION_EVENT_NAMES,
  AUTOMATION_EVENTS,
  type AutomationEventName,
} from './automation-events.js';
import { normaliseTagName } from './crm.js';
import { JOB_STATUSES } from './job-status.js';
import { addLocalDays, instantToLocal, localTimeToInstant } from './scheduling.js';

/**
 * Owner-defined automations (ADR 0033): workflows stored as data and run by a deterministic
 * engine. The AI operator may help design one; it never runs one. Nothing here is code: the
 * condition language is field comparisons with AND/OR/NOT over a whitelisted set of facts,
 * templates use `{{placeholder}}` from a whitelist, and actions are proposals drawn from the
 * agent tool registry. Money, GST, permissions, state rules and approval gates are not
 * configurable: action inputs refuse price-like fields and every action becomes a proposal
 * that the existing tool policy gates.
 */

export const AUTOMATION_SCHEMA_VERSION = 1;

// ------------------------------------------------------------------ facts and conditions

type FactType = 'text' | 'number' | 'enum' | 'tags';
interface FactInfo {
  type: FactType;
  label: string;
  values?: readonly string[];
}

/** Facts conditions may test. Money facts are integer cents and are read-only inputs. */
export const AUTOMATION_FACTS = {
  'event.from': { type: 'enum', label: 'previous job status', values: JOB_STATUSES },
  'event.to': { type: 'enum', label: 'new job status', values: JOB_STATUSES },
  'event.daysOverdue': { type: 'number', label: 'days overdue' },
  'event.daysUntil': { type: 'number', label: 'days until the appointment' },
  'event.channel': {
    type: 'enum',
    label: 'message channel',
    values: ['email', 'sms', 'whatsapp', 'manual'],
  },
  'job.title': { type: 'text', label: 'job title' },
  'job.status': { type: 'enum', label: 'job status', values: JOB_STATUSES },
  'job.hasSite': { type: 'enum', label: 'job has a site', values: ['yes', 'no'] },
  'customer.name': { type: 'text', label: 'customer name' },
  'customer.hasEmail': { type: 'enum', label: 'customer has an email', values: ['yes', 'no'] },
  // The customer's tag names (ADR 0034); `contains` tests membership of one whole tag.
  'customer.tags': { type: 'tags', label: 'customer tags' },
  'quote.totalCents': { type: 'number', label: 'quote total (cents, incl. GST)' },
  'quote.status': {
    type: 'enum',
    label: 'quote status',
    values: ['draft', 'approved', 'sent', 'accepted', 'declined', 'expired', 'superseded'],
  },
  'invoice.status': {
    type: 'enum',
    label: 'invoice status',
    values: ['draft', 'approved', 'posting', 'posted', 'sync_failed', 'void', 'paid', 'part_paid'],
  },
  'invoice.daysOverdue': { type: 'number', label: 'invoice days overdue' },
  'appointment.status': {
    type: 'enum',
    label: 'appointment status',
    values: ['proposed', 'confirmed', 'cancelled', 'completed'],
  },
  'task.kind': { type: 'text', label: 'task kind' },
} as const satisfies Record<string, FactInfo>;
export type AutomationFact = keyof typeof AUTOMATION_FACTS;
export const AUTOMATION_FACT_NAMES = Object.keys(AUTOMATION_FACTS) as AutomationFact[];
export type AutomationFacts = Partial<
  Record<AutomationFact, string | number | readonly string[] | null>
>;

export const CONDITION_OPS = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'exists',
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
const TEXT_OPS: readonly ConditionOp[] = ['eq', 'neq', 'contains', 'not_contains', 'exists'];
const NUMBER_OPS: readonly ConditionOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists'];
const ENUM_OPS: readonly ConditionOp[] = ['eq', 'neq', 'exists'];
const TAG_OPS: readonly ConditionOp[] = ['contains', 'not_contains', 'exists'];
/** Comparisons each fact type accepts (also served to the editor). */
export const OPS_BY_FACT_TYPE: Record<FactType, readonly ConditionOp[]> = {
  text: TEXT_OPS,
  number: NUMBER_OPS,
  enum: ENUM_OPS,
  tags: TAG_OPS,
};

export interface Comparison {
  field: AutomationFact;
  op: ConditionOp;
  value?: string | number | undefined;
}
export type Condition =
  Comparison | { all: Condition[] } | { any: Condition[] } | { not: Condition };

const comparisonSchema = z
  .object({
    field: z.enum(AUTOMATION_FACT_NAMES as [AutomationFact, ...AutomationFact[]]),
    op: z.enum(CONDITION_OPS),
    value: z.union([z.string().max(200), z.number().int().min(-1e12).max(1e12)]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const fact: FactInfo = AUTOMATION_FACTS[value.field];
    const ops = OPS_BY_FACT_TYPE[fact.type];
    if (!ops.includes(value.op))
      context.addIssue({
        code: 'custom',
        message: `"${value.op}" does not apply to ${fact.label}.`,
      });
    if (value.op === 'exists') {
      if (value.value !== undefined)
        context.addIssue({ code: 'custom', message: '"exists" takes no value.' });
      return;
    }
    if (value.value === undefined)
      return void context.addIssue({ code: 'custom', message: 'A value is required.' });
    if (fact.type === 'number' && typeof value.value !== 'number')
      context.addIssue({ code: 'custom', message: `${fact.label} compares with a whole number.` });
    if (fact.type !== 'number' && typeof value.value !== 'string')
      context.addIssue({ code: 'custom', message: `${fact.label} compares with text.` });
    if (fact.type === 'enum' && !fact.values!.includes(String(value.value)))
      context.addIssue({ code: 'custom', message: `Unknown value for ${fact.label}.` });
  });

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    comparisonSchema,
    z.object({ all: z.array(conditionSchema).min(1).max(10) }).strict(),
    z.object({ any: z.array(conditionSchema).min(1).max(10) }).strict(),
    z.object({ not: conditionSchema }).strict(),
  ]),
) as z.ZodType<Condition>;

function conditionStats(condition: Condition, depth = 1): { depth: number; leaves: number } {
  if ('field' in condition) return { depth, leaves: 1 };
  const children =
    'not' in condition ? [condition.not] : 'all' in condition ? condition.all : condition.any;
  return children.reduce(
    (acc, child) => {
      const stats = conditionStats(child, depth + 1);
      return { depth: Math.max(acc.depth, stats.depth), leaves: acc.leaves + stats.leaves };
    },
    { depth, leaves: 0 },
  );
}

/** Pure, total evaluation. Missing facts compare as absent (false, except `neq`/`not_contains`). */
export function evaluateCondition(
  condition: Condition | undefined,
  facts: AutomationFacts,
): boolean {
  if (!condition) return true;
  if ('all' in condition) return condition.all.every((child) => evaluateCondition(child, facts));
  if ('any' in condition) return condition.any.some((child) => evaluateCondition(child, facts));
  if ('not' in condition) return !evaluateCondition(condition.not, facts);
  const actual = facts[condition.field];
  if (Array.isArray(actual) || AUTOMATION_FACTS[condition.field].type === 'tags') {
    const tags = (Array.isArray(actual) ? actual : []).map(normaliseTagName);
    const wanted = normaliseTagName(String(condition.value ?? ''));
    if (condition.op === 'exists') return tags.length > 0;
    if (condition.op === 'contains') return tags.includes(wanted);
    if (condition.op === 'not_contains') return !tags.includes(wanted);
    return false;
  }
  const present = actual !== undefined && actual !== null && actual !== '';
  if (condition.op === 'exists') return present;
  const expected = condition.value;
  if (typeof actual === 'number' && typeof expected === 'number') {
    switch (condition.op) {
      case 'eq':
        return actual === expected;
      case 'neq':
        return actual !== expected;
      case 'gt':
        return actual > expected;
      case 'gte':
        return actual >= expected;
      case 'lt':
        return actual < expected;
      case 'lte':
        return actual <= expected;
      default:
        return false;
    }
  }
  const a = present ? String(actual).toLocaleLowerCase('en-NZ') : '';
  const b = String(expected ?? '').toLocaleLowerCase('en-NZ');
  switch (condition.op) {
    case 'eq':
      return present && a === b;
    case 'neq':
      return a !== b;
    case 'contains':
      return present && a.includes(b);
    case 'not_contains':
      return !a.includes(b);
    default:
      return false;
  }
}

// ------------------------------------------------------------------ placeholders

/** The only placeholders templates may use. Values are plain text facts, never money. */
export const AUTOMATION_PLACEHOLDERS = {
  'customer.firstName': 'Customer first name',
  'customer.name': 'Customer name',
  'job.title': 'Job title',
  'quote.number': 'Quote number',
  'invoice.number': 'Invoice number',
  'appointment.date': 'Appointment date',
  'appointment.time': 'Appointment time',
  'business.name': 'Business name',
} as const;
export type AutomationPlaceholder = keyof typeof AUTOMATION_PLACEHOLDERS;
export type PlaceholderValues = Partial<Record<AutomationPlaceholder, string | null>>;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** Placeholders a template uses that are not on the whitelist, plus stray braces. */
export function templateErrors(template: string): string[] {
  const errors: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER))
    if (!Object.hasOwn(AUTOMATION_PLACEHOLDERS, match[1]!))
      errors.push(`Unknown placeholder {{${match[1]}}}.`);
  if (/\{\{|\}\}/.test(template.replace(PLACEHOLDER, '')))
    errors.push('Placeholders look like {{customer.firstName}}.');
  return errors;
}

/**
 * Render a validated template. Values are record data (possibly written by customers): control
 * characters, line breaks and braces are removed and length is capped, so a value can never add
 * a placeholder, a header line or markup structure. Missing values render as an empty string,
 * except the first name, which falls back to "there".
 */
export function renderTemplate(template: string, values: PlaceholderValues): string {
  return template.replace(PLACEHOLDER, (_whole, key: string) => {
    const raw = Object.hasOwn(AUTOMATION_PLACEHOLDERS, key)
      ? values[key as AutomationPlaceholder]
      : null;
    const clean = String(raw ?? '')
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
      .replace(/[{}<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    return clean || (key === 'customer.firstName' ? 'there' : '');
  });
}

// ------------------------------------------------------------------ delay

const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time like 09:00.');

export const delaySchema = z
  .object({
    days: z.number().int().min(0).max(60).optional(),
    hours: z.number().int().min(0).max(23).optional(),
    minutes: z.number().int().min(0).max(59).optional(),
    /** Business-local time of day to run at, after adding `days` (e.g. next day at 09:00). */
    at: localTime.optional(),
  })
  .strict();
export type AutomationDelay = z.infer<typeof delaySchema>;

const minuteOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** When a run is due: `from` plus the delay, in the business time zone. */
export function automationDueAt(
  fromMs: number,
  delay: AutomationDelay | undefined,
  timeZone: string,
): Date {
  if (!delay) return new Date(fromMs);
  if (delay.at) {
    const local = instantToLocal(fromMs, timeZone);
    let date = addLocalDays(local.date, delay.days ?? 0);
    let due = localTimeToInstant(date, minuteOf(delay.at), timeZone);
    if (due <= fromMs) {
      date = addLocalDays(date, 1);
      due = localTimeToInstant(date, minuteOf(delay.at), timeZone);
    }
    return new Date(due + ((delay.hours ?? 0) * 60 + (delay.minutes ?? 0)) * 60_000);
  }
  const minutes = ((delay.days ?? 0) * 24 + (delay.hours ?? 0)) * 60 + (delay.minutes ?? 0);
  return new Date(fromMs + minutes * 60_000);
}

// ------------------------------------------------------------------ schedule trigger

export const scheduleSchema = z
  .object({
    frequency: z.enum(['daily', 'weekly']),
    /** 0 = Sunday ... 6 = Saturday; weekly only. */
    weekday: z.number().int().min(0).max(6).optional(),
    at: localTime,
  })
  .strict()
  .refine((value) => (value.frequency === 'weekly') === (value.weekday !== undefined), {
    message: 'A weekly schedule needs a weekday; a daily one does not.',
  });
export type AutomationSchedule = z.infer<typeof scheduleSchema>;

/** The local date a schedule fires on at `nowMs`, or null when it is not (yet) due today. */
export function scheduleOccurrence(
  schedule: AutomationSchedule,
  nowMs: number,
  timeZone: string,
): string | null {
  const local = instantToLocal(nowMs, timeZone);
  if (schedule.frequency === 'weekly' && local.weekday !== schedule.weekday) return null;
  return local.minuteOfDay >= minuteOf(schedule.at) ? local.date : null;
}

// ------------------------------------------------------------------ actions

/** Tools an automation may use, and what each binds automatically from the event. */
export const AUTOMATION_ACTION_TOOLS = [
  'task.create',
  'communication.draft',
  'schedule.propose',
  'job.add_note',
  'reminder.create',
  'job.update_status',
] as const satisfies readonly ToolName[];
export type AutomationActionTool = (typeof AUTOMATION_ACTION_TOOLS)[number];

const templateText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .superRefine((value, context) => {
      for (const message of templateErrors(value)) context.addIssue({ code: 'custom', message });
    });
const approval = z.enum(['owner', 'auto']).optional();

export const automationActionSchema = z.discriminatedUnion('tool', [
  z
    .object({
      tool: z.literal('task.create'),
      title: templateText(200),
      notes: templateText(2000).optional(),
      kind: z.enum(['call', 'custom', 'book_job', 'follow_up_quote', 'invoice_job']).optional(),
      priority: z.enum(['low', 'normal', 'high']).optional(),
      /** Due this many days after the run, at 09:00 business time. Omit for no due date. */
      dueInDays: z.number().int().min(0).max(60).optional(),
      approval,
    })
    .strict(),
  z
    .object({
      tool: z.literal('communication.draft'),
      channel: z.enum(['email', 'sms', 'whatsapp', 'manual']),
      subject: templateText(200).optional(),
      text: templateText(5000),
      approval,
    })
    .strict(),
  z
    .object({
      tool: z.literal('schedule.propose'),
      inDays: z.number().int().min(1).max(60),
      at: localTime,
      durationMinutes: z.number().int().min(15).max(960),
      notes: templateText(2000).optional(),
      approval,
    })
    .strict(),
  z.object({ tool: z.literal('job.add_note'), text: templateText(4000), approval }).strict(),
  z
    .object({
      tool: z.literal('reminder.create'),
      text: templateText(500),
      dueInDays: z.number().int().min(0).max(60),
      approval,
    })
    .strict(),
  z
    .object({
      tool: z.literal('job.update_status'),
      status: z.enum(JOB_STATUSES),
      approval,
    })
    .strict(),
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;

/** Events an action may emit once it executes (for the static loop check). */
const ACTION_EMITS: Record<
  AutomationActionTool,
  (action: AutomationAction) => AutomationEventName[]
> = {
  'task.create': () => ['task.created'],
  'communication.draft': () => [],
  'schedule.propose': () => ['appointment.booked'],
  'job.add_note': () => [],
  'reminder.create': () => [],
  'job.update_status': (action) =>
    action.tool === 'job.update_status' && action.status === 'completed'
      ? ['job.status_changed', 'job.completed']
      : ['job.status_changed'],
};

/** Tools whose actions need a job (bound from the event's job). */
const NEEDS_JOB: ReadonlySet<AutomationActionTool> = new Set([
  'schedule.propose',
  'job.add_note',
  'job.update_status',
]);

// ------------------------------------------------------------------ definition

export const automationDefinitionSchema = z
  .object({
    schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION).default(AUTOMATION_SCHEMA_VERSION),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    trigger: z
      .object({
        event: z.enum(AUTOMATION_EVENT_NAMES as [AutomationEventName, ...AutomationEventName[]]),
        schedule: scheduleSchema.optional(),
        filter: conditionSchema.optional(),
      })
      .strict(),
    delay: delaySchema.optional(),
    actions: z.array(automationActionSchema).min(1).max(5),
    limits: z
      .object({
        /** Runs per record over the automation's lifetime (default 1). */
        maxRunsPerEntity: z.number().int().min(1).max(100).default(1),
        /** Runs per business per day (default 50). */
        maxRunsPerDay: z.number().int().min(1).max(500).default(50),
      })
      .strict()
      .default({ maxRunsPerEntity: 1, maxRunsPerDay: 50 }),
  })
  .strict();
export type AutomationDefinition = z.output<typeof automationDefinitionSchema>;
export type AutomationDefinitionInput = z.input<typeof automationDefinitionSchema>;

export type AutomationValidation =
  | { ok: true; definition: AutomationDefinition; summary: string }
  | { ok: false; errors: Array<{ path: string; message: string }> };

/**
 * Validate an untrusted definition (owner form, template or agent proposal). Rejects unknown
 * fields, tools and placeholders, any price-like key, deep conditions and self-triggering loops.
 */
export function validateAutomation(input: unknown): AutomationValidation {
  const priceFields = findPriceFields(input);
  if (priceFields.length)
    return {
      ok: false,
      errors: priceFields.map((path) => ({
        path,
        message: 'Automations cannot set prices, amounts, tax or markups.',
      })),
    };
  const parsed = automationDefinitionSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  const definition = parsed.data;
  const errors: Array<{ path: string; message: string }> = [];
  const event = definition.trigger.event;
  if ((event === 'schedule') !== Boolean(definition.trigger.schedule))
    errors.push({
      path: 'trigger.schedule',
      message:
        event === 'schedule'
          ? 'A scheduled automation needs a schedule.'
          : 'Only scheduled automations take a schedule.',
    });
  if (definition.trigger.filter) {
    const stats = conditionStats(definition.trigger.filter);
    if (stats.depth > 4)
      errors.push({ path: 'trigger.filter', message: 'Conditions nest too deeply.' });
    if (stats.leaves > 20) errors.push({ path: 'trigger.filter', message: 'Too many conditions.' });
  }
  const entity = AUTOMATION_EVENTS[event].entity;
  definition.actions.forEach((action, index) => {
    const path = `actions.${index}`;
    if (entity === 'business' && action.tool !== 'task.create')
      errors.push({ path, message: 'A scheduled automation can only create tasks.' });
    if ((entity === 'task' || entity === 'communication') && NEEDS_JOB.has(action.tool))
      errors.push({ path, message: `${TOOL_DEFINITIONS[action.tool].title} needs a job event.` });
    if (action.approval === 'auto' && !TOOL_DEFINITIONS[action.tool].autoApprovalAllowed)
      errors.push({
        path: `${path}.approval`,
        message: `${TOOL_DEFINITIONS[action.tool].title} always needs owner approval.`,
      });
    if (ACTION_EMITS[action.tool](action).includes(event))
      errors.push({
        path,
        message:
          'This action would trigger the automation again (loop). Choose another trigger or action.',
      });
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, definition, summary: summariseAutomation(definition) };
}

/** Effective approval for one action: the action's own setting where the tool allows it, else the tenant policy. */
export function actionApproval(action: AutomationAction, tenantPolicy: ApprovalMode): ApprovalMode {
  const allowed = TOOL_DEFINITIONS[action.tool].autoApprovalAllowed;
  if (!allowed) return 'owner';
  return (action.approval ?? tenantPolicy) === 'auto' ? 'auto' : 'owner';
}

// ------------------------------------------------------------------ plain-English summary

const OP_WORDS: Record<ConditionOp, string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  exists: 'is set',
};
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function describeCondition(condition: Condition): string {
  if ('all' in condition) return condition.all.map(describeCondition).join(' and ');
  if ('any' in condition) return `(${condition.any.map(describeCondition).join(' or ')})`;
  if ('not' in condition) return `not (${describeCondition(condition.not)})`;
  const fact: FactInfo = AUTOMATION_FACTS[condition.field];
  if (fact.type === 'tags')
    return condition.op === 'exists'
      ? 'the customer has any tag'
      : `the customer is${condition.op === 'not_contains' ? ' not' : ''} tagged "${normaliseTagName(String(condition.value))}"`;
  const value =
    condition.op === 'exists'
      ? ''
      : condition.field === 'quote.totalCents' && typeof condition.value === 'number'
        ? ` ${money(condition.value)}`
        : typeof condition.value === 'string'
          ? ` "${condition.value}"`
          : ` ${condition.value}`;
  return `the ${fact.label.replace(/ \(cents, incl\. GST\)/, '')} ${OP_WORDS[condition.op]}${value}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function describeDelay(delay: AutomationDelay | undefined): string {
  if (!delay || (!delay.days && !delay.hours && !delay.minutes && !delay.at))
    return 'straight away';
  const parts = [
    delay.days ? plural(delay.days, 'day') : '',
    delay.hours ? plural(delay.hours, 'hour') : '',
    delay.minutes ? plural(delay.minutes, 'minute') : '',
  ].filter(Boolean);
  const after = parts.length ? `${parts.join(' ')} later` : '';
  if (!delay.at) return after;
  const at = `at ${delay.at}`;
  return after ? `${after} ${at}` : `at the next ${delay.at}`;
}

function describeAction(action: AutomationAction): string {
  const gate =
    actionApproval(action, 'owner') === 'auto' ? ' (runs automatically)' : ' for your approval';
  switch (action.tool) {
    case 'task.create':
      return `add a task "${action.title}"${gate}`;
    case 'communication.draft':
      return `draft ${action.channel === 'manual' ? 'a' : `an ${action.channel === 'email' ? 'email' : action.channel.toUpperCase()}`} message to the customer for your approval (never sent automatically)`;
    case 'schedule.propose':
      return `propose an appointment ${plural(action.inDays, 'day')} later at ${action.at} for your approval`;
    case 'job.add_note':
      return `add a job note${gate}`;
    case 'reminder.create':
      return `set a reminder for you in ${plural(action.dueInDays, 'day')} for your approval`;
    case 'job.update_status':
      return `propose moving the job to "${action.status.replace('_', ' ')}" for your approval`;
  }
}

/** Deterministic plain-English description of a definition (never model text). */
export function summariseAutomation(definition: AutomationDefinition): string {
  const trigger = definition.trigger;
  let when = `When ${AUTOMATION_EVENTS[trigger.event].title}`;
  if (trigger.event === 'schedule' && trigger.schedule)
    when =
      trigger.schedule.frequency === 'daily'
        ? `Every day at ${trigger.schedule.at}`
        : `Every ${WEEKDAYS[trigger.schedule.weekday ?? 1]} at ${trigger.schedule.at}`;
  const filter = trigger.filter ? ` and ${describeCondition(trigger.filter)}` : '';
  const actions = definition.actions.map(describeAction);
  const list =
    actions.length === 1 ? actions[0] : `${actions.slice(0, -1).join(', ')} and ${actions.at(-1)}`;
  const once =
    definition.limits.maxRunsPerEntity === 1 && trigger.event !== 'schedule'
      ? ' At most once per record.'
      : '';
  return `${when}${filter}, ${describeDelay(definition.delay)}: ${list}.${once}`;
}

// ------------------------------------------------------------------ templates

export interface AutomationTemplate {
  key: string;
  title: string;
  description: string;
  definition: AutomationDefinitionInput;
}

export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  {
    key: 'review_request',
    title: 'Thank-you and review request',
    description: 'The day after a job is completed, draft a thank-you asking for a review.',
    definition: {
      name: 'Thank-you and review request',
      trigger: {
        event: 'job.completed',
        filter: { field: 'job.title', op: 'not_contains', value: 'warranty' },
      },
      delay: { days: 1, at: '09:00' },
      actions: [
        {
          tool: 'communication.draft',
          channel: 'email',
          subject: 'Thanks from {{business.name}}',
          text: 'Hi {{customer.firstName}}, thanks for choosing {{business.name}} for "{{job.title}}". If you were happy with the work, a short Google review would mean a lot to us.',
        },
      ],
    },
  },
  {
    key: 'quote_follow_up',
    title: 'Follow up larger quotes',
    description: 'Five days after a quote over $2,000 is sent, remind me to follow it up.',
    definition: {
      name: 'Follow up larger quotes',
      trigger: {
        event: 'quote.sent',
        filter: { field: 'quote.totalCents', op: 'gte', value: 200_000 },
      },
      delay: { days: 5, at: '09:00' },
      actions: [
        {
          tool: 'task.create',
          kind: 'follow_up_quote',
          title: 'Follow up quote {{quote.number}} with {{customer.name}}',
          priority: 'normal',
          dueInDays: 0,
        },
      ],
    },
  },
  {
    key: 'appointment_confirmation',
    title: 'Day-before appointment confirmation',
    description: 'The day before an appointment, draft a confirmation message.',
    definition: {
      name: 'Day-before appointment confirmation',
      trigger: {
        event: 'appointment.upcoming',
        filter: {
          all: [
            { field: 'event.daysUntil', op: 'eq', value: 1 },
            { field: 'appointment.status', op: 'neq', value: 'cancelled' },
          ],
        },
      },
      actions: [
        {
          tool: 'communication.draft',
          channel: 'sms',
          text: 'Hi {{customer.firstName}}, just confirming {{business.name}} will see you on {{appointment.date}} at {{appointment.time}} for "{{job.title}}". Reply if you need to change it.',
        },
      ],
    },
  },
];
