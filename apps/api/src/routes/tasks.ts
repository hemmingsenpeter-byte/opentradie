import {
  addLocalDays,
  instantToLocal,
  localTimeToInstant,
  taskSettingsErrors,
} from '@opentradie/core';
import { recordAudit, TASK_KINDS, TASK_PRIORITIES, type Database } from '@opentradie/database';
import { z } from 'zod';
import { HttpError, type RouteRegistry } from '../http.js';
import { errorResponse, idParams } from '../schemas.js';
import {
  applyTaskAction,
  createTask,
  getTask,
  listTasks,
  loadTaskSettings,
  saveTaskSettings,
  scanTasks,
  type TaskAction,
} from '../services/tasks.js';

const title = z.string().trim().min(1).max(200);
const notes = z.string().trim().max(2000);
const when = z.iso.datetime({ offset: true });
const linkId = z.string().uuid();

export const taskCreateBody = z
  .object({
    kind: z.enum(TASK_KINDS).default('custom'),
    title,
    notes: notes.optional(),
    dueAt: when.nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    customerId: linkId.optional(),
    jobId: linkId.optional(),
    quoteId: linkId.optional(),
    invoiceId: linkId.optional(),
    threadId: linkId.optional(),
    appointmentId: linkId.optional(),
  })
  .strict();

const taskUpdateBody = z
  .object({
    title: title.optional(),
    notes: notes.nullable().optional(),
    dueAt: when.nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.');

const listQuery = z
  .object({
    status: z.enum(['active', 'open', 'snoozed', 'done', 'dismissed', 'all']).optional(),
    kind: z.enum(TASK_KINDS).optional(),
    due: z.enum(['overdue', 'today', 'upcoming', 'snoozed']).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

const snoozeBody = z.object({ until: when }).strict();

const settingsBody = z
  .object({
    rulesEnabled: z.boolean().optional(),
    followUpQuoteDays: z.number().int().optional(),
    replyAfterHours: z.number().int().optional(),
    invoiceAfterDays: z.number().int().optional(),
  })
  .strict();

export function registerTaskRoutes(api: RouteRegistry, deps: { db: Database; now?: () => Date }) {
  const now = () => deps.now?.() ?? new Date();

  api.route(
    {
      method: 'GET',
      url: '/api/tasks',
      summary: 'Tasks (default: open and snoozed), each with its Today bucket',
      tags: ['tasks'],
      auth: 'user',
      query: listQuery,
      responses: { 200: { description: 'Tasks' } },
    },
    async ({ user, query }) => ({ body: await listTasks(api.pool, user.tenantId, query, now()) }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/today',
      summary:
        "Today: counts, open tasks grouped overdue/today/upcoming/snoozed and today's appointments",
      tags: ['tasks'],
      auth: 'user',
      responses: { 200: { description: 'Today' } },
    },
    async ({ user }) => {
      const at = now();
      const { timeZone, tasks } = await listTasks(
        api.pool,
        user.tenantId,
        { status: 'active' },
        at,
      );
      const date = instantToLocal(at.getTime(), timeZone).date;
      const from = new Date(localTimeToInstant(date, 0, timeZone)).toISOString();
      const to = new Date(localTimeToInstant(addLocalDays(date, 1), 0, timeZone)).toISOString();
      const appointments = await api.pool.query(
        `SELECT a.id,a.job_id AS "jobId",j.title AS "jobTitle",c.name AS "customerName",c.phone AS "customerPhone",
           a.starts_at AS "startsAt",a.ends_at AS "endsAt",a.status,a.location
         FROM appointments a JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
           JOIN customers c ON c.tenant_id=j.tenant_id AND c.id=j.customer_id
         WHERE a.tenant_id=$1 AND a.status <> 'cancelled' AND a.starts_at < $3 AND a.ends_at > $2
         ORDER BY a.starts_at`,
        [user.tenantId, from, to],
      );
      const group = (bucket: string) => tasks.filter((task) => task.bucket === bucket);
      const overdue = group('overdue');
      const today = group('today');
      const upcoming = group('upcoming');
      const snoozed = group('snoozed');
      return {
        body: {
          timeZone,
          date,
          counts: {
            overdue: overdue.length,
            today: today.length,
            upcoming: upcoming.length,
            snoozed: snoozed.length,
            due: overdue.length + today.length,
          },
          overdue,
          today,
          upcoming,
          snoozed,
          appointments: appointments.rows,
        },
      };
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/tasks',
      summary: 'Add a task (owner, audited)',
      tags: ['tasks'],
      auth: 'owner',
      idempotent: true,
      body: taskCreateBody,
      responses: {
        201: { description: 'Created' },
        422: { description: 'LINK_NOT_FOUND', schema: errorResponse },
      },
    },
    async ({ user, body, request, idempotent }) =>
      idempotent(async (client) => {
        const { id } = await createTask(client, user.tenantId, {
          ...body,
          source: 'manual',
          sourceRef: request.id,
          createdBy: user.id,
        });
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'task.created',
          entityType: 'task',
          entityId: id,
          requestId: request.id,
          metadata: { kind: body.kind, source: 'manual', hasDue: Boolean(body.dueAt) },
        });
        return { status: 201, body: { task: await getTask(client, user.tenantId, id, now()) } };
      }),
  );

  api.route(
    {
      method: 'PATCH',
      url: '/api/tasks/:id',
      summary: 'Edit a task’s title, notes, due time or priority (owner, audited)',
      tags: ['tasks'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: taskUpdateBody,
      responses: { 200: { description: 'Updated' }, 404: { description: 'NOT_FOUND' } },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        await getTask(client, user.tenantId, params.id, now(), true);
        const sets: string[] = [];
        const values: unknown[] = [user.tenantId, params.id];
        const columns = { title: 'title', notes: 'notes', dueAt: 'due_at', priority: 'priority' };
        for (const [field, column] of Object.entries(columns)) {
          const value = body[field as keyof typeof body];
          if (value === undefined) continue;
          values.push(value);
          sets.push(`${column}=$${values.length}`);
        }
        await client.query(
          `UPDATE tasks SET ${sets.join(',')},updated_at=now() WHERE tenant_id=$1 AND id=$2`,
          values,
        );
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'task.updated',
          entityType: 'task',
          entityId: params.id,
          requestId: request.id,
          metadata: { fields: Object.keys(body) },
        });
        return { body: { task: await getTask(client, user.tenantId, params.id, now()) } };
      }),
  );

  const action = (name: TaskAction, summary: string) =>
    api.route(
      {
        method: 'POST',
        url: `/api/tasks/:id/${name}`,
        summary,
        tags: ['tasks'],
        auth: 'owner',
        idempotent: true,
        params: idParams,
        ...(name === 'snooze' ? { body: snoozeBody } : {}),
        responses: {
          200: { description: 'Task' },
          404: { description: 'NOT_FOUND' },
          409: { description: 'TASK_CLOSED', schema: errorResponse },
          422: { description: 'SNOOZE_IN_PAST', schema: errorResponse },
        },
      },
      async ({ user, params, body, request, idempotent }) =>
        idempotent(async (client) => {
          const until = name === 'snooze' ? (body as { until: string }).until : undefined;
          const result = await applyTaskAction(
            client,
            user.tenantId,
            params.id,
            name,
            { type: 'user', id: user.id },
            now(),
            until,
          );
          if (result.changed)
            await recordAudit(client, {
              tenantId: user.tenantId,
              actorType: 'user',
              actorId: user.id,
              action: `task.${name === 'complete' ? 'completed' : name === 'snooze' ? 'snoozed' : name === 'dismiss' ? 'dismissed' : 'reopened'}`,
              entityType: 'task',
              entityId: params.id,
              requestId: request.id,
              metadata: { from: result.from, kind: result.task.kind, ...(until ? { until } : {}) },
            });
          return { body: { task: result.task, changed: result.changed } };
        }),
    );
  action('complete', 'Mark a task done (owner, audited)');
  action('snooze', 'Snooze a task until a time (owner, audited)');
  action('dismiss', 'Dismiss a task; a rule never recreates it (owner, audited)');
  action('reopen', 'Reopen a done, dismissed or snoozed task (owner, audited)');

  api.route(
    {
      method: 'POST',
      url: '/api/tasks/scan',
      summary: 'Run the task rules now (they also run hourly)',
      tags: ['tasks'],
      auth: 'owner',
      idempotent: true,
      responses: { 200: { description: 'Scan summary' } },
    },
    async ({ user, request, idempotent }) =>
      idempotent(
        async (client, summary) => {
          await recordAudit(client, {
            tenantId: user.tenantId,
            actorType: 'user',
            actorId: user.id,
            action: 'tasks.scan_requested',
            entityType: 'business',
            entityId: user.tenantId,
            requestId: request.id,
            metadata: { ...summary },
          });
          return { body: summary };
        },
        // The scan runs in its own transaction first, so "Run now" shows its result at once.
        () => scanTasks(deps.db, user.tenantId, request.id, now()),
      ),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/settings/tasks',
      summary: 'Task rule thresholds (rules on by default)',
      tags: ['tasks'],
      auth: 'owner',
      responses: { 200: { description: 'Settings' } },
    },
    async ({ user }) => ({ body: await loadTaskSettings(api.pool, user.tenantId) }),
  );

  api.route(
    {
      method: 'PATCH',
      url: '/api/settings/tasks',
      summary: 'Update the task rule thresholds (owner, audited)',
      tags: ['tasks'],
      auth: 'owner',
      idempotent: true,
      body: settingsBody,
      responses: {
        200: { description: 'Settings' },
        422: { description: 'INVALID_TASK_SETTINGS', schema: errorResponse },
      },
    },
    async ({ user, body, request, idempotent }) =>
      idempotent(async (client) => {
        const next = {
          ...(await loadTaskSettings(client, user.tenantId)),
          ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)),
        };
        const errors = taskSettingsErrors(next);
        if (errors.length)
          throw new HttpError(422, 'INVALID_TASK_SETTINGS', errors.join(' '), { errors });
        await saveTaskSettings(client, user.tenantId, user.id, next);
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'tasks.settings_updated',
          entityType: 'business',
          entityId: user.tenantId,
          requestId: request.id,
          metadata: { fields: Object.keys(body) },
        });
        return { body: next };
      }),
  );
}
