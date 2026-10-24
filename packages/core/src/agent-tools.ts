import { createHash } from 'node:crypto';
import { z } from 'zod';
import { JOB_STATUSES } from './job-status.js';
import { MAX_AMOUNT_CENTS } from './money.js';
import { MAX_QUANTITY_MILLI } from './pricing.js';
import { rateCodeSchema } from './quote.js';
import { validateAutomation } from './automations.js';
import { MAX_APPOINTMENT_MINUTES, parseLocalDate } from './scheduling.js';

/**
 * Business tool registry for the AI operator (ADR 0021).
 *
 * Agents propose; the backend validates; owners approve. Every tool here is either a tenant-scoped
 * read or a *proposal*: calling a propose tool never changes a business record, it creates an
 * action proposal that an owner approves before the backend runs the deterministic domain command.
 * No tool sends, approves, deletes, exports, runs shell commands or touches the database directly,
 * and no tool accepts a price, amount, tax or markup from the agent.
 */

export type ToolRisk = 'read' | 'propose';
export type ApprovalMode = 'owner' | 'auto';

const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => text(max).optional();

/** Thousandths of an hour for one time entry: 0.001 h to 24 h. */
export const MAX_TIME_ENTRY_MILLI = 24_000;

/** Fields every propose tool accepts besides its own input. They are not part of the payload. */
export const proposalMetaSchema = z
  .object({
    /**
     * Agent-chosen replay key (for example derived from the source message id). Replaying the
     * same instruction with the same key returns the existing proposal instead of a duplicate.
     */
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,128}$/)
      .optional(),
    /** Questions the owner should answer before approving. Shown as text, never executed. */
    clarifications: z.array(text(300)).max(5).optional(),
  })
  .strict();
export type ProposalMeta = z.infer<typeof proposalMetaSchema>;

const MATERIAL_UNITS = [
  'each',
  'hour',
  'visit',
  'metre',
  'square_metre',
  'litre',
  'kilogram',
] as const;

/** Kinds an agent or voice note may give a task; rule kinds come only from the task scan. */
export const OWNER_TASK_KINDS = [
  'call',
  'custom',
  'book_job',
  'follow_up_quote',
  'invoice_job',
] as const;

export const toolInputSchemas = {
  // ---------- read ----------
  'customer.find': z
    .object({
      query: text(200),
      limit: z.number().int().min(1).max(20).default(10),
    })
    .strict(),
  'customer.get': z.object({ customerId: uuid }).strict(),
  'job.find': z
    .object({
      query: optionalText(200),
      customerId: uuid.optional(),
      status: z.enum(JOB_STATUSES).optional(),
      limit: z.number().int().min(1).max(20).default(10),
    })
    .strict(),
  'job.get': z.object({ jobId: uuid }).strict(),
  'quote.get': z.object({ quoteId: uuid }).strict(),
  'rates.list': z.object({}).strict(),
  'payment.status': z
    .object({ jobId: uuid.optional(), invoiceId: uuid.optional() })
    .strict()
    .refine((value) => value.jobId || value.invoiceId, 'Give a jobId or an invoiceId.'),
  'schedule.availability': z
    .object({
      /** First local date (YYYY-MM-DD, business time zone). Defaults to today. */
      date: z
        .string()
        .refine((value) => parseLocalDate(value) !== null, 'Use a real date as YYYY-MM-DD.')
        .optional(),
      durationMinutes: z.number().int().min(15).max(MAX_APPOINTMENT_MINUTES).default(60),
      days: z.number().int().min(1).max(14).default(7),
      limit: z.number().int().min(1).max(20).default(10),
    })
    .strict(),

  // ---------- propose ----------
  'customer.create': z
    .object({
      name: text(200),
      preferredName: optionalText(200),
      email: z.string().trim().email().max(254).optional(),
      phone: z.string().trim().min(3).max(50).optional(),
      address: optionalText(500),
    })
    .strict(),
  'job.create': z
    .object({
      customerId: uuid,
      title: text(300),
      description: optionalText(5000),
      propertyId: uuid.optional(),
    })
    .strict(),
  'job.update_status': z
    .object({
      jobId: uuid,
      status: z.enum(JOB_STATUSES),
      reopen: z.boolean().optional(),
    })
    .strict(),
  'job.add_note': z.object({ jobId: uuid, text: text(4000) }).strict(),
  'job.record_time': z
    .object({
      jobId: uuid,
      /** An approved, active rate whose unit is "hour". The price comes from the rate record. */
      rateCode: rateCodeSchema,
      /** Thousandths of an hour: 1.5 h is 1500. */
      quantityMilli: z.number().int().min(1).max(MAX_TIME_ENTRY_MILLI),
      description: optionalText(500),
      workDate: z.iso.date().optional(),
    })
    .strict(),
  'job.add_material': z
    .object({
      jobId: uuid,
      description: text(200),
      unit: z.enum(MATERIAL_UNITS).default('each'),
      quantityMilli: z.number().int().min(1).max(MAX_QUANTITY_MILLI),
      /**
       * Supplier cost per unit as reported (for example read off a receipt). It is a *reported
       * cost*, never a sell price: the sell price is computed by core pricing from this cost and
       * an owner-approved markup, and the owner confirms the cost when approving.
       */
      reportedUnitCostCents: z.number().int().min(0).max(MAX_AMOUNT_CENTS).optional(),
      supplier: optionalText(200),
    })
    .strict(),
  'quote.prepare': z
    .object({
      jobId: uuid,
      lines: z
        .array(
          z
            .object({
              rateCode: rateCodeSchema,
              quantityMilli: z.number().int().min(1).max(MAX_QUANTITY_MILLI),
              description: optionalText(200),
            })
            .strict(),
        )
        .min(1)
        .max(20),
      assumptions: z.array(text(300)).max(10).optional(),
      missingInformation: z.array(text(300)).max(10).optional(),
    })
    .strict(),
  'invoice.prepare': z.object({ jobId: uuid, quoteId: uuid.optional() }).strict(),
  'communication.draft': z
    .object({
      customerId: uuid.optional(),
      jobId: uuid.optional(),
      channel: z.enum(['email', 'sms', 'whatsapp', 'manual']),
      subject: optionalText(200),
      text: text(5000),
    })
    .strict()
    .refine((value) => value.customerId || value.jobId, 'Give a customerId or a jobId.'),
  'reminder.create': z
    .object({
      jobId: uuid.optional(),
      customerId: uuid.optional(),
      dueAt: z.iso.datetime({ offset: true }),
      text: text(500),
    })
    .strict(),
  'task.list': z
    .object({
      status: z.enum(['active', 'open', 'snoozed', 'done', 'dismissed']).default('active'),
      due: z.enum(['overdue', 'today', 'upcoming', 'snoozed']).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  'task.create': z
    .object({
      kind: z.enum(OWNER_TASK_KINDS).default('custom'),
      title: text(200),
      notes: optionalText(2000),
      dueAt: z.iso.datetime({ offset: true }).optional(),
      priority: z.enum(['low', 'normal', 'high']).optional(),
      jobId: uuid.optional(),
      customerId: uuid.optional(),
    })
    .strict(),
  'task.complete': z.object({ taskId: uuid }).strict(),
  'task.snooze': z.object({ taskId: uuid, until: z.iso.datetime({ offset: true }) }).strict(),
  'schedule.propose': z
    .object({
      jobId: uuid,
      startsAt: z.iso.datetime({ offset: true }),
      endsAt: z.iso.datetime({ offset: true }),
      notes: optionalText(2000),
    })
    .strict()
    .refine(
      (value) => Date.parse(value.endsAt) > Date.parse(value.startsAt),
      'The appointment must end after it starts.',
    ),
  'automation.propose': z
    .object({
      /** A full automation definition (ADR 0033); validated by the automation validator. */
      definition: z.record(z.string(), z.unknown()),
    })
    .strict()
    .superRefine((value, context) => {
      const checked = validateAutomation(value.definition);
      if (!checked.ok)
        for (const error of checked.errors)
          context.addIssue({
            code: 'custom',
            path: ['definition', ...error.path.split('.').filter(Boolean)],
            message: error.message,
          });
    }),
} as const;

export type ToolName = keyof typeof toolInputSchemas;
export type ToolInput<N extends ToolName> = z.output<(typeof toolInputSchemas)[N]>;

export interface ToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  risk: ToolRisk;
  /** Role a person needs to see this tool's results (read) or to approve its proposals. */
  requiredRole: 'viewer' | 'owner';
  /** Money or customer-facing effects always need a human approval. */
  financial: boolean;
  customerFacing: boolean;
  /** Only job notes and owner to-dos (task.create, task.complete) may be switched to auto-execution, and only by the owner. */
  autoApprovalAllowed: boolean;
  /** False while the domain module the executor needs does not exist yet. */
  executable: boolean;
  /** Why an approved proposal cannot run yet. */
  notExecutableReason?: string;
  /** The one input field that may carry a (reported) cost. No other money field is accepted. */
  allowedCostField?: string;
  /** Proposal sources allowed to call this tool; omitted means any. */
  allowedSources?: readonly string[];
}

const read = (name: ToolName, title: string, description: string): ToolDefinition => ({
  name,
  title,
  description,
  risk: 'read',
  requiredRole: 'viewer',
  financial: false,
  customerFacing: false,
  autoApprovalAllowed: false,
  executable: true,
});

const propose = (
  name: ToolName,
  title: string,
  description: string,
  options: Partial<
    Pick<
      ToolDefinition,
      | 'financial'
      | 'customerFacing'
      | 'autoApprovalAllowed'
      | 'executable'
      | 'notExecutableReason'
      | 'allowedCostField'
      | 'allowedSources'
    >
  > = {},
): ToolDefinition => ({
  name,
  title,
  description: `${description} Creates a proposal only; nothing changes until the business owner approves it.`,
  risk: 'propose',
  requiredRole: 'owner',
  financial: false,
  customerFacing: false,
  autoApprovalAllowed: false,
  executable: true,
  ...options,
});

export const TOOL_DEFINITIONS: Record<ToolName, ToolDefinition> = {
  'customer.find': read(
    'customer.find',
    'Find customers',
    'Search customers by name, email or address text. Returns ids and display names only.',
  ),
  'customer.get': read(
    'customer.get',
    'Get customer',
    'One customer with their job sites and recent jobs.',
  ),
  'job.find': read('job.find', 'Find jobs', 'Search jobs by text, customer or status.'),
  'job.get': read(
    'job.get',
    'Get job',
    'A job card: customer, site, status, recent notes (untrusted text) and a timeline summary.',
  ),
  'quote.get': read(
    'quote.get',
    'Get quote',
    'A quote with lines priced by the backend from approved rates.',
  ),
  'rates.list': read(
    'rates.list',
    'List approved rates',
    'Approved rate codes, labels and units. Use these codes in proposals; prices are applied by the backend.',
  ),
  'payment.status': read(
    'payment.status',
    'Payment status',
    'Invoice and payment status for a job or invoice: invoice number, status (draft, approved, posted, part_paid, paid, ...), totals and the amounts paid and due as last read from the accounting system.',
  ),
  'schedule.availability': read(
    'schedule.availability',
    'Free appointment slots',
    'Free slots of a given length within the business working hours (business time zone), honouring the travel buffer. Times only: no other appointment details.',
  ),
  'customer.create': propose('customer.create', 'Propose customer', 'Propose a new customer.', {
    customerFacing: false,
  }),
  'job.create': propose('job.create', 'Propose job', 'Propose a new job for an existing customer.'),
  'job.update_status': propose(
    'job.update_status',
    'Propose job status',
    'Propose a job status change. The backend applies the job lifecycle rules.',
  ),
  'job.add_note': propose(
    'job.add_note',
    'Propose job note',
    'Propose a note on a job (for example from a voice note). Stored as text only.',
    { autoApprovalAllowed: true },
  ),
  'job.record_time': propose(
    'job.record_time',
    'Propose time entry',
    'Propose labour time on a job as an approved hourly rate code and a quantity in thousandths of an hour. Never a price.',
    { financial: true },
  ),
  'job.add_material': propose(
    'job.add_material',
    'Propose material',
    'Propose a material used on a job. A supplier cost may be reported; the sell price is computed by the backend from an owner-approved markup.',
    { financial: true, allowedCostField: 'reportedUnitCostCents' },
  ),
  'quote.prepare': propose(
    'quote.prepare',
    'Propose draft quote',
    'Propose a draft quote as approved rate codes and quantities. The backend prices it; the quote still needs its own approval before it can be sent.',
    { financial: true },
  ),
  'invoice.prepare': propose(
    'invoice.prepare',
    'Propose invoice draft',
    'Propose a draft invoice for a completed job. The backend builds every line and amount from the accepted quote, recorded time (approved rates) and priced materials; the invoice still needs its own owner approval before it is posted.',
    { financial: true, customerFacing: true },
  ),
  'communication.draft': propose(
    'communication.draft',
    'Propose message draft',
    'Propose a draft message to a customer. It is saved as a draft and is never sent by the agent.',
    { customerFacing: true },
  ),
  'reminder.create': propose(
    'reminder.create',
    'Propose reminder',
    'Propose a reminder for the owner. When it falls due it becomes a manual draft for the owner to act on; nothing is sent.',
  ),
  'task.list': read(
    'task.list',
    'List tasks',
    "The owner's to-do list: open tasks with kind, title, due time, priority and linked ids. Notes are untrusted text.",
  ),
  'task.create': propose(
    'task.create',
    'Propose task',
    'Propose an owner to-do (call someone, book a job, follow up). Never a message to a customer.',
    { autoApprovalAllowed: true },
  ),
  'task.complete': propose(
    'task.complete',
    'Propose completing a task',
    'Propose marking an open task done.',
    { autoApprovalAllowed: true },
  ),
  'task.snooze': propose(
    'task.snooze',
    'Propose snoozing a task',
    'Propose snoozing an open task until a later time.',
  ),
  'schedule.propose': propose(
    'schedule.propose',
    'Propose appointment',
    'Propose an appointment time for a job (use schedule.availability first). On approval it is booked as a proposed appointment the owner confirms in the calendar; clashes are refused.',
  ),
  'automation.propose': propose(
    'automation.propose',
    'Propose automation',
    'Propose an owner automation (trigger, conditions, delay, actions) as a definition. The backend validates it and shows a plain-English summary; on approval it is saved disabled unless the owner enables it. Every action it takes later is itself a proposal under the normal approval rules; it can never send or turn on auto-approval.',
    { allowedSources: ['agent', 'user'] },
  ),
};

export const TOOL_NAMES = Object.keys(TOOL_DEFINITIONS) as ToolName[];

export function isToolName(value: unknown): value is ToolName {
  return typeof value === 'string' && Object.hasOwn(TOOL_DEFINITIONS, value);
}

/** Effective approval for a tool under a tenant's stored policy. Defaults to owner approval. */
export function resolveApproval(tool: ToolName, stored?: ApprovalMode | null): ApprovalMode {
  const definition = TOOL_DEFINITIONS[tool];
  if (definition.risk !== 'propose') return 'owner';
  return stored === 'auto' && definition.autoApprovalAllowed ? 'auto' : 'owner';
}

/** Whether an owner may store this approval policy for this tool. */
export function canSetApproval(tool: ToolName, approval: ApprovalMode): boolean {
  const definition = TOOL_DEFINITIONS[tool];
  if (definition.risk !== 'propose') return false;
  return approval === 'owner' || definition.autoApprovalAllowed;
}

/**
 * Key names that would let an agent assert money. Matched case-insensitively anywhere in the
 * input, at any depth. The single exception is a tool's declared reported-cost field.
 */
const MONEY_KEY = /price|amount|total|cost|sell|tax|gst|discount|markup|margin|cents|fee|charge/i;

/** Paths of keys that look like prices or amounts and are not allowed for this tool. */
export function findPriceFields(value: unknown, allowedCostField?: string, path = ''): string[] {
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      findPriceFields(item, allowedCostField, `${path}[${index}]`),
    );
  if (value === null || typeof value !== 'object') return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (MONEY_KEY.test(key) && !(path === '' && key === allowedCostField)) found.push(here);
    found.push(...findPriceFields(child, allowedCostField, here));
  }
  return found;
}

export type ToolParseResult =
  | {
      ok: true;
      tool: ToolDefinition;
      input: Record<string, unknown>;
      meta: ProposalMeta;
    }
  | {
      ok: false;
      code: 'UNKNOWN_TOOL' | 'PRICE_FIELD_REFUSED' | 'INVALID_INPUT';
      message: string;
      issues: Array<{ path: string; message: string }>;
    };

/**
 * Validate untrusted tool arguments. Unknown tools are refused; price-like fields are refused
 * with a specific error before schema validation; unknown keys are rejected by strict schemas.
 */
export function parseToolCall(name: unknown, args: unknown): ToolParseResult {
  if (!isToolName(name))
    return { ok: false, code: 'UNKNOWN_TOOL', message: 'Unknown tool.', issues: [] };
  const tool = TOOL_DEFINITIONS[name];
  const raw: Record<string, unknown> =
    args && typeof args === 'object' && !Array.isArray(args)
      ? { ...(args as Record<string, unknown>) }
      : args === undefined || args === null
        ? {}
        : { __invalid: args };
  const priceFields = findPriceFields(raw, tool.allowedCostField);
  if (priceFields.length)
    return {
      ok: false,
      code: 'PRICE_FIELD_REFUSED',
      message:
        'Prices, amounts, tax and markups are set only by the business from approved rates. Remove these fields and give rate codes and quantities instead.',
      issues: priceFields.map((path) => ({ path, message: 'Price-like field refused.' })),
    };
  let meta: ProposalMeta = {};
  if (tool.risk === 'propose') {
    const parsedMeta = proposalMetaSchema.safeParse({
      ...(raw.idempotencyKey !== undefined ? { idempotencyKey: raw.idempotencyKey } : {}),
      ...(raw.clarifications !== undefined ? { clarifications: raw.clarifications } : {}),
    });
    if (!parsedMeta.success) return invalid(parsedMeta.error);
    meta = parsedMeta.data;
    delete raw.idempotencyKey;
    delete raw.clarifications;
  }
  const parsed = toolInputSchemas[name].safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  return { ok: true, tool, input: parsed.data as Record<string, unknown>, meta };
}

function invalid(error: z.ZodError): ToolParseResult {
  return {
    ok: false,
    code: 'INVALID_INPUT',
    message: 'The tool input failed validation.',
    issues: error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

/** JSON Schema for a tool's input, including the proposal meta fields for propose tools. */
export function toolJsonSchema(name: ToolName): Record<string, unknown> {
  const schema = toolInputSchemas[name];
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  if (TOOL_DEFINITIONS[name].risk === 'propose') {
    const meta = z.toJSONSchema(proposalMetaSchema, { io: 'input' }) as {
      properties: Record<string, unknown>;
    };
    json.properties = { ...(json.properties as Record<string, unknown>), ...meta.properties };
  }
  return json;
}

/** Keys whose string values are identifiers or enums and safe to keep in the call log. */
const LOGGABLE_STRING_KEYS = new Set([
  'status',
  'channel',
  'unit',
  'rateCode',
  'workDate',
  'dueAt',
  'startsAt',
  'endsAt',
  'date',
  'idempotencyKey',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Log-safe view of tool input: identifiers, enums, numbers and booleans are kept; every other
 * string (names, note text, message bodies, search text) is replaced by its length.
 */
export function redactToolInput(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactToolInput(item, key));
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string')
    return UUID.test(value) || (LOGGABLE_STRING_KEYS.has(key) && value.length <= 128)
      ? value
      : { redacted: 'text', length: value.length };
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [child, item] of Object.entries(value).slice(0, 50))
      out[child] = redactToolInput(item, child);
    return out;
  }
  return { redacted: typeof value };
}

/** Stable SHA-256 of a JSON value (object keys sorted), for idempotency and call logs. */
export function canonicalHash(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, canonical((input as Record<string, unknown>)[key])]),
      );
    return input;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value ?? null)))
    .digest('hex');
}
