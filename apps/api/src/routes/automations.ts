import type { AgentRuntime } from '@opentradie/agent';
import {
  AUTOMATION_EVENT_NAMES,
  AUTOMATION_EVENTS,
  AUTOMATION_FACTS,
  AUTOMATION_PLACEHOLDERS,
  AUTOMATION_TEMPLATES,
  validateAutomation,
} from '@opentradie/core';
import type { Database } from '@opentradie/database';
import { z } from 'zod';
import { HttpError, type RouteRegistry } from '../http.js';
import { errorResponse, idParams } from '../schemas.js';
import {
  automationDto,
  createAutomation,
  dryRunAutomation,
  getAutomation,
  listAutomations,
  listRuns,
  parseDefinition,
  recentEvents,
  updateAutomation,
} from '../services/automations.js';
import { invokeTool } from '../tools/gateway.js';

const definition = z.record(z.string(), z.unknown());
const createBody = z
  .object({
    definition: definition.optional(),
    /** Start from a template instead of a definition. */
    templateKey: z.string().max(60).optional(),
    enabled: z.boolean().default(false),
  })
  .strict()
  .refine((value) => Boolean(value.definition) !== Boolean(value.templateKey), {
    message: 'Give a definition or a templateKey.',
  });
const updateBody = z.object({ version: z.number().int().min(1), definition }).strict();
const versionBody = z.object({ version: z.number().int().min(1) }).strict();
const testBody = z
  .object({ eventId: z.string().uuid(), definition: definition.optional() })
  .strict();
const draftBody = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
const eventsQuery = z.object({ event: z.enum(AUTOMATION_EVENT_NAMES).optional() }).strict();

/**
 * Built-in automations that already exist as tested, dedicated features. They are listed (not
 * converted) so their behaviour stays exactly as tested; ADR 0033 explains why.
 */
export const BUILT_IN_AUTOMATIONS = [
  {
    key: 'payment_follow_ups',
    name: 'Payment follow-ups',
    summary:
      'Overdue invoice reminders by stage (prepared for approval or sent under your policy), then escalation to a call.',
    configure: { label: 'Settings › Payment follow-ups', href: '#/settings' },
  },
  ...[
    ['book_job', 'Book accepted quotes', 'A quote is accepted and nothing is booked: add a task.'],
    [
      'follow_up_quote',
      'Follow up sent quotes',
      'A quote has been sent for a few days: add a task.',
    ],
    ['reply_message', 'Reply to messages', 'A customer message is unanswered: add a task.'],
    ['invoice_job', 'Invoice completed jobs', 'A completed job has no invoice: add a task.'],
    ['chase_payment', 'Chase payment', 'An invoice is escalated or long overdue: add a call task.'],
  ].map(([key, name, summary]) => ({
    key: `task_rule_${key}`,
    name: name!,
    summary: summary!,
    configure: { label: 'Today (task rules; thresholds in /api/settings/tasks)', href: '#/' },
  })),
] as const;

export function registerAutomationRoutes(
  api: RouteRegistry,
  deps: { db: Database; runtime: AgentRuntime; now?: () => Date },
) {
  const now = () => deps.now?.() ?? new Date();

  api.route(
    {
      method: 'GET',
      url: '/api/automations',
      summary: 'Automations with summaries and last run, plus built-in rules',
      tags: ['automations'],
      auth: 'user',
      responses: { 200: { description: 'Automations' } },
    },
    async ({ user }) => ({
      body: {
        automations: await listAutomations(api.pool, user.tenantId),
        builtIn: BUILT_IN_AUTOMATIONS,
      },
    }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/automations/templates',
      summary: 'Automation templates and the editor catalogue (events, facts, placeholders)',
      tags: ['automations'],
      auth: 'user',
      responses: { 200: { description: 'Templates' } },
    },
    async () => ({
      body: {
        templates: AUTOMATION_TEMPLATES.map((template) => {
          const checked = validateAutomation(template.definition);
          return { ...template, summary: checked.ok ? checked.summary : null };
        }),
        events: AUTOMATION_EVENT_NAMES.map((name) => ({ name, ...AUTOMATION_EVENTS[name] })),
        facts: Object.entries(AUTOMATION_FACTS).map(([name, fact]) => ({ name, ...fact })),
        placeholders: Object.entries(AUTOMATION_PLACEHOLDERS).map(([name, label]) => ({
          name,
          label,
        })),
      },
    }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/automations/events',
      summary: 'Recent automation events (identifiers only), for a dry run',
      tags: ['automations'],
      auth: 'user',
      query: eventsQuery,
      responses: { 200: { description: 'Events' } },
    },
    async ({ user, query }) => ({
      body: { events: await recentEvents(api.pool, user.tenantId, query.event) },
    }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/automations/validate',
      summary: 'Validate a definition: errors, or a plain-English summary (writes nothing)',
      tags: ['automations'],
      auth: 'owner',
      idempotent: true,
      body: z.object({ definition }).strict(),
      responses: { 200: { description: 'Validation result' } },
    },
    async ({ body, idempotent }) =>
      idempotent(async () => {
        const checked = validateAutomation(body.definition);
        return {
          body: checked.ok
            ? { ok: true, summary: checked.summary, definition: checked.definition }
            : { ok: false, errors: checked.errors },
        };
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/automations',
      summary: 'Create an automation from a definition or a template (owner, audited)',
      tags: ['automations'],
      auth: 'owner',
      idempotent: true,
      body: createBody,
      responses: {
        201: { description: 'Created' },
        400: { description: 'VALIDATION_ERROR', schema: errorResponse },
      },
    },
    async ({ user, body, request, idempotent }) =>
      idempotent(async (client) => {
        const template = body.templateKey
          ? AUTOMATION_TEMPLATES.find((item) => item.key === body.templateKey)
          : undefined;
        if (body.templateKey && !template)
          throw new HttpError(404, 'TEMPLATE_NOT_FOUND', 'Template not found.');
        const parsed = parseDefinition(template?.definition ?? body.definition);
        const { id } = await createAutomation(client, {
          tenantId: user.tenantId,
          requestId: request.id,
          actorId: user.id,
          definition: parsed,
          source: 'manual',
          enabled: body.enabled,
          templateKey: template?.key ?? null,
        });
        return {
          status: 201,
          body: { automation: automationDto(await getAutomation(client, user.tenantId, id)) },
        };
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/automations/draft',
      summary:
        'Ask the assistant to draft an automation from a sentence; creates a proposal for approval',
      tags: ['automations'],
      auth: 'owner',
      idempotent: true,
      body: draftBody,
      responses: {
        201: { description: 'Proposal created, or nothing understood' },
        501: { description: 'AGENT_PLANNING_UNAVAILABLE', schema: errorResponse },
      },
    },
    async ({ user, body, request, idempotent }) =>
      idempotent(
        async (client, call) => {
          if (!call) return { status: 201, body: { proposal: null, understood: false } };
          const outcome = await invokeTool(
            deps.db,
            {
              tenantId: user.tenantId,
              requestId: request.id,
              sessionId: null,
              name: call.tool,
              args: {
                ...(call.arguments && typeof call.arguments === 'object' ? call.arguments : {}),
                idempotencyKey: `automation-draft-${request.id}`.slice(0, 128),
              },
              origin: {
                source: 'agent',
                sourceRef: `assistant:${request.id}`.slice(0, 200),
                createdByType: 'agent',
              },
            },
            client,
          );
          if (!outcome.ok)
            return {
              status: 201,
              body: { proposal: null, understood: true, refused: outcome },
            };
          return { status: 201, body: { proposal: outcome.data, understood: true } };
        },
        async () => {
          if (!deps.runtime.planAutomation)
            throw new HttpError(
              501,
              'AGENT_PLANNING_UNAVAILABLE',
              'This agent runtime proposes automations through the tool gateway, not this screen.',
            );
          return deps.runtime.planAutomation({ requestId: request.id, text: body.text });
        },
      ),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/automations/:id',
      summary: 'One automation',
      tags: ['automations'],
      auth: 'user',
      params: idParams,
      responses: { 200: { description: 'Automation' }, 404: { description: 'Not found' } },
    },
    async ({ user, params }) => ({
      body: { automation: automationDto(await getAutomation(api.pool, user.tenantId, params.id)) },
    }),
  );

  api.route(
    {
      method: 'PATCH',
      url: '/api/automations/:id',
      summary: 'Replace an automation definition (owner, audited, versioned)',
      tags: ['automations'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: updateBody,
      responses: {
        200: { description: 'Updated' },
        400: { description: 'VALIDATION_ERROR', schema: errorResponse },
        409: { description: 'VERSION_CONFLICT', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        await updateAutomation(client, {
          tenantId: user.tenantId,
          requestId: request.id,
          actorId: user.id,
          id: params.id,
          version: body.version,
          definition: parseDefinition(body.definition),
        });
        return {
          body: {
            automation: automationDto(await getAutomation(client, user.tenantId, params.id)),
          },
        };
      }),
  );

  api.route(
    {
      method: 'DELETE',
      url: '/api/automations/:id',
      summary: 'Delete an automation (owner, audited; run history is kept)',
      tags: ['automations'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: versionBody,
      responses: { 200: { description: 'Deleted' }, 409: { description: 'VERSION_CONFLICT' } },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        await updateAutomation(client, {
          tenantId: user.tenantId,
          requestId: request.id,
          actorId: user.id,
          id: params.id,
          version: body.version,
          deleted: true,
        });
        return { body: { deleted: true } };
      }),
  );

  for (const action of ['enable', 'disable'] as const)
    api.route(
      {
        method: 'POST',
        url: `/api/automations/:id/${action}`,
        summary: `${action === 'enable' ? 'Enable' : 'Disable'} an automation (owner, audited)`,
        tags: ['automations'],
        auth: 'owner',
        idempotent: true,
        params: idParams,
        body: versionBody,
        responses: { 200: { description: 'Updated' }, 409: { description: 'VERSION_CONFLICT' } },
      },
      async ({ user, params, body, request, idempotent }) =>
        idempotent(async (client) => {
          await updateAutomation(client, {
            tenantId: user.tenantId,
            requestId: request.id,
            actorId: user.id,
            id: params.id,
            version: body.version,
            enabled: action === 'enable',
          });
          return {
            body: {
              automation: automationDto(await getAutomation(client, user.tenantId, params.id)),
            },
          };
        }),
    );

  api.route(
    {
      method: 'POST',
      url: '/api/automations/:id/test',
      summary: 'Dry run against a recent event: what would happen (creates nothing)',
      tags: ['automations'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: testBody,
      responses: { 200: { description: 'Dry run' }, 404: { description: 'Not found' } },
    },
    async ({ user, params, body, idempotent }) =>
      idempotent(async (client) => {
        const current = await getAutomation(client, user.tenantId, params.id);
        const draft = body.definition ? parseDefinition(body.definition) : current.definition;
        return {
          body: await dryRunAutomation(client, user.tenantId, draft, body.eventId, now()),
        };
      }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/automations/:id/runs',
      summary: 'Run history (status, reason code, proposals created)',
      tags: ['automations'],
      auth: 'user',
      params: idParams,
      responses: { 200: { description: 'Runs' }, 404: { description: 'Not found' } },
    },
    async ({ user, params }) => ({
      body: { runs: await listRuns(api.pool, user.tenantId, params.id) },
    }),
  );
}
