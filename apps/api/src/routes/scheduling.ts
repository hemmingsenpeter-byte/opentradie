import { randomUUID } from 'node:crypto';
import {
  MAX_APPOINTMENT_MINUTES,
  MAX_BUFFER_MINUTES,
  parseLocalDate,
  workingHoursErrors,
} from '@opentradie/core';
import { recordAudit } from '@opentradie/database';
import type { PostgresJobQueue } from '@opentradie/platform';
import { z } from 'zod';
import { scheduleTasksScan } from '../services/tasks.js';
import { HttpError, type RouteRegistry } from '../http.js';
import { errorResponse, id, idParams } from '../schemas.js';
import { getJob } from '../services/records.js';
import {
  appointmentAudit as audit,
  appointmentInterval as interval,
  assertVersion,
  checkConflicts,
  createAppointment,
  findAvailableSlots,
  getAppointment,
  listAppointments,
  listJobAppointments,
  loadSchedulingConfig,
  lockAppointment,
  lockSchedule,
  scheduleAppointmentReminder,
  scheduleJob,
  suppressAppointmentReminders,
  timeEvent,
  warningsFor,
} from '../services/scheduling.js';

// ---------- schemas ----------
const instant = z.iso.datetime({ offset: true });
const localDate = z
  .string()
  .refine((value) => parseLocalDate(value) !== null, 'Use a real date as YYYY-MM-DD.');
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

const workingHoursRule = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
  })
  .strict();

export const schedulingSettingsBody = z
  .object({
    bufferMinutes: z.number().int().min(0).max(MAX_BUFFER_MINUTES).optional(),
    reminderLeadMinutes: z.number().int().min(30).max(10_080).optional(),
    /** Replaces all working hours. An empty list restores the default (Mon-Fri 07:00-17:00). */
    workingHours: z.array(workingHoursRule).max(28).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field.');

export const appointmentCreateBody = z
  .object({
    jobId: id,
    startsAt: instant,
    endsAt: instant,
    title: optionalText(200),
    notes: optionalText(2000),
    status: z.enum(['proposed', 'confirmed']).default('confirmed'),
    source: z.enum(['manual', 'assistant_proposed', 'customer_request']).default('manual'),
    /** The owner explicitly books over another appointment. */
    allowConflict: z.boolean().default(false),
  })
  .strict();

export const appointmentRescheduleBody = z
  .object({
    version: z.number().int().min(1),
    startsAt: instant,
    endsAt: instant,
    notes: optionalText(2000),
    allowConflict: z.boolean().default(false),
  })
  .strict();

const versionBody = z.object({ version: z.number().int().min(1) }).strict();
const cancelBody = z
  .object({ version: z.number().int().min(1), reason: optionalText(500) })
  .strict();

export const appointmentListQuery = z
  .object({
    from: instant,
    to: instant,
    jobId: id.optional(),
    includeCancelled: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();

export const availabilityQuery = z
  .object({
    date: localDate.optional(),
    durationMinutes: z.coerce.number().int().min(15).max(MAX_APPOINTMENT_MINUTES).default(60),
    days: z.coerce.number().int().min(1).max(14).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    stepMinutes: z.coerce.number().int().min(15).max(120).default(30),
  })
  .strict();

const appointmentStatus = z.enum(['proposed', 'confirmed', 'cancelled', 'completed']);
export const appointmentResponse = z.object({
  id,
  jobId: id,
  jobTitle: z.string(),
  jobStatus: z.string(),
  customerId: id,
  customerName: z.string(),
  propertyId: id.nullable(),
  location: z.string().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: appointmentStatus,
  title: z.string(),
  notes: z.string().nullable(),
  source: z.string(),
  conflictAcknowledged: z.boolean(),
  cancelReason: z.string().nullable(),
  externalCalendarProvider: z.string().nullable(),
  version: z.number().int(),
  cancelledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const reminderResponse = z.object({
  id,
  dueAt: z.string(),
  channel: z.string(),
  status: z.enum(['scheduled', 'prepared', 'sent', 'cancelled', 'suppressed']),
  communicationId: id.nullable(),
});
export const appointmentDetailResponse = appointmentResponse.extend({
  reminders: z.array(reminderResponse),
});
export const appointmentMutationResponse = z.object({
  appointment: appointmentDetailResponse,
  /** e.g. OUTSIDE_WORKING_HOURS, CONFLICT_ACKNOWLEDGED, NO_REMINDER_TOO_SOON */
  warnings: z.array(z.string()),
  jobStatusChange: z.object({ from: z.string(), to: z.string() }).nullable(),
});
export const schedulingSettingsResponse = z.object({
  timeZone: z.string(),
  bufferMinutes: z.number().int(),
  reminderLeadMinutes: z.number().int(),
  workingHours: z.array(workingHoursRule),
  usingDefaultHours: z.boolean(),
});
export const availabilityResponse = z.object({
  timeZone: z.string(),
  durationMinutes: z.number().int(),
  bufferMinutes: z.number().int(),
  fromDate: z.string(),
  days: z.number().int(),
  slots: z.array(z.object({ startsAt: z.string(), endsAt: z.string(), localDate: z.string() })),
});

const conflictResponse = {
  description:
    'APPOINTMENT_CONFLICT (includes conflicts[] with ids and times; resend with allowConflict: true to book anyway), VERSION_CONFLICT, APPOINTMENT_CLOSED or JOB_CLOSED',
  schema: errorResponse,
};

const RANGE_LIMIT_MS = 100 * 86_400_000;

/** Appointments, availability, working hours and reminders (Feature 14, ADR 0019). */
export function registerSchedulingRoutes(api: RouteRegistry, deps: { queue: PostgresJobQueue }) {
  const { queue } = deps;

  api.route(
    {
      method: 'GET',
      url: '/api/scheduling/settings',
      summary: 'Working hours, travel buffer and reminder lead time (business time zone)',
      tags: ['scheduling'],
      auth: 'user',
      responses: { 200: { description: 'Settings', schema: schedulingSettingsResponse } },
    },
    async ({ user }) => {
      const config = await loadSchedulingConfig(api.pool, user.tenantId);
      return {
        body: {
          timeZone: config.timeZone,
          bufferMinutes: config.bufferMinutes,
          reminderLeadMinutes: config.reminderLeadMinutes,
          workingHours: config.workingHours,
          usingDefaultHours: config.usingDefaultHours,
        },
      };
    },
  );

  api.route(
    {
      method: 'PATCH',
      url: '/api/scheduling/settings',
      summary: 'Update working hours, travel buffer or reminder lead time',
      tags: ['scheduling'],
      auth: 'owner',
      idempotent: true,
      body: schedulingSettingsBody,
      responses: {
        200: { description: 'Updated settings', schema: schedulingSettingsResponse },
        422: { description: 'INVALID_WORKING_HOURS', schema: errorResponse },
      },
    },
    async ({ user, body, request, idempotent }) =>
      idempotent(async (client) => {
        if (body.workingHours) {
          const errors = workingHoursErrors(body.workingHours);
          if (errors.length)
            throw new HttpError(422, 'INVALID_WORKING_HOURS', errors.join(' '), { errors });
          await client.query('DELETE FROM availability_rules WHERE tenant_id=$1', [user.tenantId]);
          for (const rule of body.workingHours)
            await client.query(
              'INSERT INTO availability_rules(id,tenant_id,weekday,start_minute,end_minute) VALUES($1,$2,$3,$4,$5)',
              [randomUUID(), user.tenantId, rule.weekday, rule.startMinute, rule.endMinute],
            );
        }
        if (body.bufferMinutes !== undefined || body.reminderLeadMinutes !== undefined)
          await client.query(
            `INSERT INTO scheduling_settings(tenant_id,buffer_minutes,reminder_lead_minutes) VALUES($1,coalesce($2,15),coalesce($3,1440))
             ON CONFLICT (tenant_id) DO UPDATE SET buffer_minutes=coalesce($2,scheduling_settings.buffer_minutes),
               reminder_lead_minutes=coalesce($3,scheduling_settings.reminder_lead_minutes),updated_at=now()`,
            [user.tenantId, body.bufferMinutes ?? null, body.reminderLeadMinutes ?? null],
          );
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'scheduling.settings_updated',
          entityType: 'business',
          entityId: user.tenantId,
          requestId: request.id,
          metadata: {
            fields: Object.keys(body),
            ...(body.workingHours ? { ranges: body.workingHours.length } : {}),
          },
        });
        const config = await loadSchedulingConfig(client, user.tenantId);
        return {
          body: {
            timeZone: config.timeZone,
            bufferMinutes: config.bufferMinutes,
            reminderLeadMinutes: config.reminderLeadMinutes,
            workingHours: config.workingHours,
            usingDefaultHours: config.usingDefaultHours,
          },
        };
      }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/scheduling/availability',
      summary:
        'Free slots of a given length within working hours (business time zone, DST-aware), honouring the travel buffer. Defaults to today; days up to 14 for suggestions.',
      tags: ['scheduling'],
      auth: 'user',
      query: availabilityQuery,
      responses: { 200: { description: 'Free slots', schema: availabilityResponse } },
    },
    async ({ user, query }) => ({
      body: await findAvailableSlots(api.pool, user.tenantId, query),
    }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/appointments',
      summary: 'Appointments overlapping a time range (at most 100 days)',
      tags: ['scheduling'],
      auth: 'user',
      query: appointmentListQuery,
      responses: {
        200: {
          description: 'Appointments',
          schema: z.object({ appointments: z.array(appointmentResponse) }),
        },
        400: { description: 'Invalid range', schema: errorResponse },
      },
    },
    async ({ user, query }) => {
      const from = new Date(query.from);
      const to = new Date(query.to);
      if (!(to > from) || to.getTime() - from.getTime() > RANGE_LIMIT_MS)
        throw new HttpError(400, 'INVALID_RANGE', 'Use a range of up to 100 days, from before to.');
      return {
        body: {
          appointments: await listAppointments(api.pool, user.tenantId, {
            from,
            to,
            jobId: query.jobId,
            includeCancelled: query.includeCancelled,
          }),
        },
      };
    },
  );

  api.route(
    {
      method: 'GET',
      url: '/api/jobs/:id/appointments',
      summary: 'All appointments for a job, newest first',
      tags: ['scheduling'],
      auth: 'user',
      params: idParams,
      responses: {
        200: {
          description: 'Appointments',
          schema: z.object({ appointments: z.array(appointmentResponse) }),
        },
        404: { description: 'Job not found', schema: errorResponse },
      },
    },
    async ({ user, params }) => {
      await getJob(api.pool, user.tenantId, params.id);
      return {
        body: { appointments: await listJobAppointments(api.pool, user.tenantId, params.id) },
      };
    },
  );

  api.route(
    {
      method: 'GET',
      url: '/api/appointments/:id',
      summary: 'An appointment with its reminders',
      tags: ['scheduling'],
      auth: 'user',
      params: idParams,
      responses: {
        200: { description: 'Appointment', schema: appointmentDetailResponse },
        404: { description: 'Not found (including other tenants)', schema: errorResponse },
      },
    },
    async ({ user, params }) => ({
      body: await getAppointment(api.pool, user.tenantId, params.id),
    }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/appointments',
      summary:
        'Book an appointment for a job. Clashes return 409 unless allowConflict is true. A confirmed booking moves a new or quoted job to scheduled and schedules a customer reminder draft.',
      tags: ['scheduling'],
      auth: 'owner',
      idempotent: true,
      body: appointmentCreateBody,
      responses: {
        201: { description: 'Booked', schema: appointmentMutationResponse },
        404: { description: 'Job not found (including other tenants)', schema: errorResponse },
        409: conflictResponse,
        422: { description: 'INVALID_TIME_RANGE or APPOINTMENT_IN_PAST', schema: errorResponse },
      },
    },
    async ({ user, body, request, idempotent }) =>
      idempotent(async (client) => {
        const created = await createAppointment(client, queue, {
          actor: user,
          requestId: request.id,
          jobId: body.jobId,
          startsAt: body.startsAt,
          endsAt: body.endsAt,
          title: body.title ?? null,
          notes: body.notes ?? null,
          status: body.status,
          source: body.source,
          allowConflict: body.allowConflict,
        });
        // A booking can clear a "Book job" task: re-run the task rules now (ADR 0032).
        await scheduleTasksScan(
          queue,
          client,
          user.tenantId,
          new Date(),
          `tasks:booking:${request.id}`,
        );
        return {
          status: 201,
          body: {
            appointment: await getAppointment(client, user.tenantId, created.appointmentId),
            warnings: created.warnings,
            jobStatusChange: created.jobStatusChange,
          },
        };
      }),
  );

  api.route(
    {
      method: 'PATCH',
      url: '/api/appointments/:id',
      summary:
        'Reschedule an appointment (optimistic version check). Outstanding reminders are suppressed and a new one is scheduled for a confirmed appointment.',
      tags: ['scheduling'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: appointmentRescheduleBody,
      responses: {
        200: { description: 'Rescheduled', schema: appointmentMutationResponse },
        404: { description: 'Not found', schema: errorResponse },
        409: conflictResponse,
        422: { description: 'INVALID_TIME_RANGE or APPOINTMENT_IN_PAST', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        await lockSchedule(client, user.tenantId);
        const current = await lockAppointment(client, user.tenantId, params.id);
        assertVersion(current, body.version);
        if (current.status !== 'proposed' && current.status !== 'confirmed')
          throw new HttpError(
            409,
            'APPOINTMENT_CLOSED',
            `A ${current.status} appointment cannot be moved.`,
          );
        const slot = interval(body.startsAt, body.endsAt);
        const config = await loadSchedulingConfig(client, user.tenantId);
        const conflicts = await checkConflicts(
          client,
          user,
          config,
          slot,
          body.allowConflict,
          current.id,
        );
        const version = current.version + 1;
        await client.query(
          `UPDATE appointments SET starts_at=$3,ends_at=$4,notes=CASE WHEN $5::boolean THEN $6 ELSE notes END,
             conflict_acknowledged=$7,version=$8,updated_at=now() WHERE tenant_id=$1 AND id=$2`,
          [
            user.tenantId,
            current.id,
            new Date(slot.startMs).toISOString(),
            new Date(slot.endMs).toISOString(),
            body.notes !== undefined,
            body.notes ?? null,
            conflicts.length > 0,
            version,
          ],
        );
        const suppressed = await suppressAppointmentReminders(
          client,
          user.tenantId,
          current.id,
          'rescheduled',
        );
        const confirmed = current.status === 'confirmed';
        const reminderId = confirmed
          ? await scheduleAppointmentReminder(client, queue, {
              tenantId: user.tenantId,
              appointmentId: current.id,
              jobId: current.jobId,
              version,
              startsAt: new Date(slot.startMs),
              leadMinutes: config.reminderLeadMinutes,
            })
          : null;
        const times = {
          fromStartsAt: current.startsAt.toISOString(),
          fromEndsAt: current.endsAt.toISOString(),
          startsAt: new Date(slot.startMs).toISOString(),
          endsAt: new Date(slot.endMs).toISOString(),
        };
        await timeEvent('appointment_rescheduled')(
          client,
          user,
          current.jobId,
          'Appointment moved',
          { appointmentId: current.id, ...times },
        );
        await audit(client, user, request.id, 'appointment.rescheduled', current.id, {
          jobId: current.jobId,
          version,
          ...times,
          conflictIds: conflicts.map((item) => item.id),
          remindersSuppressed: suppressed,
          reminderId,
        });
        return {
          body: {
            appointment: await getAppointment(client, user.tenantId, current.id),
            warnings: warningsFor(config, slot, conflicts, { confirmed, id: reminderId }),
            jobStatusChange: null,
          },
        };
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/appointments/:id/confirm',
      summary:
        'Confirm a proposed appointment: moves a new or quoted job to scheduled and schedules the customer reminder. Confirming twice changes nothing.',
      tags: ['scheduling'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: versionBody,
      responses: {
        200: { description: 'Confirmed', schema: appointmentMutationResponse },
        404: { description: 'Not found', schema: errorResponse },
        409: conflictResponse,
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const current = await lockAppointment(client, user.tenantId, params.id);
        if (current.status === 'confirmed')
          return {
            body: {
              appointment: await getAppointment(client, user.tenantId, current.id),
              warnings: ['ALREADY_CONFIRMED'],
              jobStatusChange: null,
            },
          };
        assertVersion(current, body.version);
        if (current.status !== 'proposed')
          throw new HttpError(
            409,
            'APPOINTMENT_CLOSED',
            `A ${current.status} appointment cannot be confirmed.`,
          );
        if (current.endsAt.getTime() <= Date.now())
          throw new HttpError(422, 'APPOINTMENT_IN_PAST', 'That time has already passed.');
        const config = await loadSchedulingConfig(client, user.tenantId);
        const version = current.version + 1;
        await client.query(
          "UPDATE appointments SET status='confirmed',version=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [user.tenantId, current.id, version],
        );
        await timeEvent('appointment_confirmed')(
          client,
          user,
          current.jobId,
          'Appointment confirmed',
          { appointmentId: current.id, startsAt: current.startsAt.toISOString() },
        );
        const jobStatusChange = await scheduleJob(client, user, current.jobId, current.id);
        const reminderId = await scheduleAppointmentReminder(client, queue, {
          tenantId: user.tenantId,
          appointmentId: current.id,
          jobId: current.jobId,
          version,
          startsAt: current.startsAt,
          leadMinutes: config.reminderLeadMinutes,
        });
        await audit(client, user, request.id, 'appointment.confirmed', current.id, {
          jobId: current.jobId,
          version,
          reminderId,
          ...(jobStatusChange ? { jobStatus: jobStatusChange } : {}),
        });
        return {
          body: {
            appointment: await getAppointment(client, user.tenantId, current.id),
            warnings: reminderId ? [] : ['NO_REMINDER_TOO_SOON'],
            jobStatusChange,
          },
        };
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/appointments/:id/cancel',
      summary:
        'Cancel an appointment and suppress its reminders (a prepared reminder draft is discarded). The job status is not changed.',
      tags: ['scheduling'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: cancelBody,
      responses: {
        200: { description: 'Cancelled', schema: appointmentMutationResponse },
        404: { description: 'Not found', schema: errorResponse },
        409: conflictResponse,
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const current = await lockAppointment(client, user.tenantId, params.id);
        if (current.status === 'cancelled')
          return {
            body: {
              appointment: await getAppointment(client, user.tenantId, current.id),
              warnings: ['ALREADY_CANCELLED'],
              jobStatusChange: null,
            },
          };
        assertVersion(current, body.version);
        if (current.status === 'completed')
          throw new HttpError(
            409,
            'APPOINTMENT_CLOSED',
            'A completed appointment cannot be cancelled.',
          );
        await client.query(
          "UPDATE appointments SET status='cancelled',cancelled_at=now(),cancel_reason=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [user.tenantId, current.id, body.reason ?? null],
        );
        const suppressed = await suppressAppointmentReminders(
          client,
          user.tenantId,
          current.id,
          'appointment_cancelled',
        );
        await timeEvent('appointment_cancelled')(
          client,
          user,
          current.jobId,
          'Appointment cancelled',
          { appointmentId: current.id, startsAt: current.startsAt.toISOString() },
        );
        await audit(client, user, request.id, 'appointment.cancelled', current.id, {
          jobId: current.jobId,
          remindersSuppressed: suppressed,
          hasReason: Boolean(body.reason),
        });
        await scheduleTasksScan(
          queue,
          client,
          user.tenantId,
          new Date(),
          `tasks:cancel:${request.id}`,
        );
        return {
          body: {
            appointment: await getAppointment(client, user.tenantId, current.id),
            warnings: [],
            jobStatusChange: null,
          },
        };
      }),
  );
}
