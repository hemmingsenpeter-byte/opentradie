import { randomUUID } from 'node:crypto';
import {
  appointmentReminderKey,
  checkJobTransition,
  DEFAULT_WORKING_HOURS,
  reminderDueAt,
  type BusyInterval,
  type JobStatus,
  type WorkingHoursRule,
} from '@opentradie/core';
import { recordJobEvent, type Queryable, type Transaction } from '@opentradie/database';
import { enqueueReminder, type PostgresJobQueue } from '@opentradie/platform';
import { HttpError, iso, type UserContext } from '../http.js';

export interface SchedulingConfig {
  timeZone: string;
  locale: string;
  bufferMinutes: number;
  reminderLeadMinutes: number;
  workingHours: WorkingHoursRule[];
  usingDefaultHours: boolean;
}

export async function loadSchedulingConfig(
  client: Queryable,
  tenantId: string,
): Promise<SchedulingConfig> {
  const business = await client.query<{
    timeZone: string;
    locale: string;
    bufferMinutes: number | null;
    reminderLeadMinutes: number | null;
  }>(
    `SELECT b.time_zone AS "timeZone",b.locale,s.buffer_minutes AS "bufferMinutes",s.reminder_lead_minutes AS "reminderLeadMinutes"
     FROM businesses b LEFT JOIN scheduling_settings s ON s.tenant_id=b.id WHERE b.id=$1`,
    [tenantId],
  );
  const row = business.rows[0];
  if (!row)
    throw new HttpError(503, 'BUSINESS_UNAVAILABLE', 'Business setup has not been completed.');
  const rules = await client.query<WorkingHoursRule>(
    'SELECT weekday,start_minute AS "startMinute",end_minute AS "endMinute" FROM availability_rules WHERE tenant_id=$1 ORDER BY weekday,start_minute',
    [tenantId],
  );
  return {
    timeZone: row.timeZone,
    locale: row.locale,
    bufferMinutes: row.bufferMinutes ?? 15,
    reminderLeadMinutes: row.reminderLeadMinutes ?? 1440,
    workingHours: rules.rows.length
      ? rules.rows
      : DEFAULT_WORKING_HOURS.map((rule) => ({ ...rule })),
    usingDefaultHours: rules.rows.length === 0,
  };
}

/** Serialises appointment writes per business so two bookings cannot both pass the clash check. */
export async function lockSchedule(client: Transaction, tenantId: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `appointments:${tenantId}`,
  ]);
}

export interface BusyAppointment extends BusyInterval {
  jobId: string;
  title: string;
  status: string;
}

/** Proposed and confirmed appointments overlapping [fromMs, toMs). */
export async function blockingAppointments(
  client: Queryable,
  tenantId: string,
  fromMs: number,
  toMs: number,
): Promise<BusyAppointment[]> {
  const result = await client.query<{
    id: string;
    jobId: string;
    title: string;
    status: string;
    startsAt: Date;
    endsAt: Date;
  }>(
    `SELECT id,job_id AS "jobId",title,status,starts_at AS "startsAt",ends_at AS "endsAt" FROM appointments
     WHERE tenant_id=$1 AND status IN ('proposed','confirmed') AND starts_at < $3 AND ends_at > $2
     ORDER BY starts_at`,
    [tenantId, new Date(fromMs).toISOString(), new Date(toMs).toISOString()],
  );
  return result.rows.map((row) => ({
    id: row.id,
    jobId: row.jobId,
    title: row.title,
    status: row.status,
    startMs: row.startsAt.getTime(),
    endMs: row.endsAt.getTime(),
  }));
}

export const conflictDto = (item: BusyAppointment) => ({
  id: item.id,
  jobId: item.jobId,
  title: item.title,
  status: item.status,
  startsAt: new Date(item.startMs).toISOString(),
  endsAt: new Date(item.endMs).toISOString(),
});

const appointmentColumns = `a.id,a.job_id AS "jobId",j.title AS "jobTitle",j.status AS "jobStatus",j.customer_id AS "customerId",
  c.name AS "customerName",a.property_id AS "propertyId",a.location,a.starts_at AS "startsAt",a.ends_at AS "endsAt",a.status,
  a.title,a.notes,a.source,a.conflict_acknowledged AS "conflictAcknowledged",a.cancel_reason AS "cancelReason",
  a.external_calendar_provider AS "externalCalendarProvider",a.version,a.cancelled_at AS "cancelledAt",
  a.created_at AS "createdAt",a.updated_at AS "updatedAt"`;
const appointmentFrom = `FROM appointments a
  JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
  JOIN customers c ON c.tenant_id=j.tenant_id AND c.id=j.customer_id`;

function appointmentDto(row: Record<string, unknown>) {
  return {
    ...(row as Record<string, unknown>),
    startsAt: iso(row.startsAt as Date)!,
    endsAt: iso(row.endsAt as Date)!,
    cancelledAt: iso(row.cancelledAt as Date | null),
    createdAt: iso(row.createdAt as Date)!,
    updatedAt: iso(row.updatedAt as Date)!,
  } as AppointmentDto;
}

export interface AppointmentDto {
  id: string;
  jobId: string;
  jobTitle: string;
  jobStatus: JobStatus;
  customerId: string;
  customerName: string;
  propertyId: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  status: 'proposed' | 'confirmed' | 'cancelled' | 'completed';
  title: string;
  notes: string | null;
  source: string;
  conflictAcknowledged: boolean;
  cancelReason: string | null;
  externalCalendarProvider: string | null;
  version: number;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listAppointments(
  client: Queryable,
  tenantId: string,
  filter: { from: Date; to: Date; jobId?: string | undefined; includeCancelled: boolean },
): Promise<AppointmentDto[]> {
  const result = await client.query(
    `SELECT ${appointmentColumns} ${appointmentFrom}
     WHERE a.tenant_id=$1 AND a.starts_at < $3 AND a.ends_at > $2
       AND ($4::uuid IS NULL OR a.job_id=$4)
       AND ($5 OR a.status <> 'cancelled')
     ORDER BY a.starts_at, a.id LIMIT 500`,
    [tenantId, filter.from, filter.to, filter.jobId ?? null, filter.includeCancelled],
  );
  return result.rows.map(appointmentDto);
}

export async function listJobAppointments(
  client: Queryable,
  tenantId: string,
  jobId: string,
): Promise<AppointmentDto[]> {
  const result = await client.query(
    `SELECT ${appointmentColumns} ${appointmentFrom} WHERE a.tenant_id=$1 AND a.job_id=$2 ORDER BY a.starts_at DESC, a.id`,
    [tenantId, jobId],
  );
  return result.rows.map(appointmentDto);
}

export async function getAppointment(client: Queryable, tenantId: string, id: string) {
  const result = await client.query(
    `SELECT ${appointmentColumns} ${appointmentFrom} WHERE a.tenant_id=$1 AND a.id=$2`,
    [tenantId, id],
  );
  if (!result.rows[0]) throw new HttpError(404, 'APPOINTMENT_NOT_FOUND', 'Appointment not found.');
  const reminders = await client.query<{
    id: string;
    dueAt: Date;
    channel: string;
    status: string;
    communicationId: string | null;
  }>(
    `SELECT id,due_at AS "dueAt",channel,status,communication_id AS "communicationId" FROM reminders
     WHERE tenant_id=$1 AND subject_type='appointment' AND subject_id=$2 ORDER BY created_at, id`,
    [tenantId, id],
  );
  return {
    ...appointmentDto(result.rows[0]),
    reminders: reminders.rows.map((row) => ({ ...row, dueAt: iso(row.dueAt)! })),
  };
}

/** The locked appointment row for a write. */
export async function lockAppointment(client: Transaction, tenantId: string, id: string) {
  const result = await client.query<{
    id: string;
    jobId: string;
    status: AppointmentDto['status'];
    version: number;
    startsAt: Date;
    endsAt: Date;
  }>(
    'SELECT id,job_id AS "jobId",status,version,starts_at AS "startsAt",ends_at AS "endsAt" FROM appointments WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
    [tenantId, id],
  );
  if (!result.rows[0]) throw new HttpError(404, 'APPOINTMENT_NOT_FOUND', 'Appointment not found.');
  return result.rows[0];
}

export function assertVersion(current: { version: number }, expected: number) {
  if (current.version !== expected)
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'This appointment was changed since you loaded it. Reload and try again.',
      { currentVersion: current.version },
    );
}

/**
 * Move a 'new' or 'quoted' job to 'scheduled' when an appointment is booked, using the core
 * transition rules. Jobs already scheduled, in progress or closed are left alone.
 */
export async function scheduleJob(
  client: Transaction,
  user: UserContext,
  jobId: string,
  appointmentId: string,
): Promise<{ from: JobStatus; to: JobStatus } | null> {
  const locked = await client.query<{ status: JobStatus }>(
    'SELECT status FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
    [user.tenantId, jobId],
  );
  const from = locked.rows[0]?.status;
  if (from !== 'new' && from !== 'quoted') return null;
  const check = checkJobTransition(from, 'scheduled');
  if (!check.allowed) return null;
  await client.query(
    "UPDATE jobs SET status='scheduled',updated_at=now() WHERE tenant_id=$1 AND id=$2",
    [user.tenantId, jobId],
  );
  await recordJobEvent(client, {
    tenantId: user.tenantId,
    jobId,
    type: 'status_changed',
    actorType: 'user',
    actorId: user.id,
    fromStatus: from,
    toStatus: 'scheduled',
    summary: 'Job scheduled',
    metadata: { appointmentId, reopen: false },
  });
  return { from, to: 'scheduled' };
}

/**
 * Schedule the customer reminder for a confirmed appointment (one per schedule version) and
 * enqueue its durable task in the same transaction. Returns null when the appointment is too
 * close for a reminder.
 */
export async function scheduleAppointmentReminder(
  client: Transaction,
  queue: PostgresJobQueue,
  input: {
    tenantId: string;
    appointmentId: string;
    jobId: string;
    version: number;
    startsAt: Date;
    leadMinutes: number;
  },
): Promise<string | null> {
  const now = await client.query<{ now: Date }>('SELECT now() AS now');
  const due = reminderDueAt(input.startsAt.getTime(), now.rows[0]!.now.getTime(), {
    leadMinutes: input.leadMinutes,
  });
  if (due === null) return null;
  const customer = await client.query<{
    customerId: string;
    email: string | null;
    phone: string | null;
  }>(
    'SELECT c.id AS "customerId",c.email,c.phone FROM jobs j JOIN customers c ON c.tenant_id=j.tenant_id AND c.id=j.customer_id WHERE j.tenant_id=$1 AND j.id=$2',
    [input.tenantId, input.jobId],
  );
  const target = customer.rows[0]!;
  const channel = target.email ? 'email' : target.phone ? 'sms' : 'manual';
  const dedupeKey = appointmentReminderKey(input.appointmentId, input.version);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO reminders(id,tenant_id,subject_type,subject_id,job_id,customer_id,due_at,channel,dedupe_key,payload)
     VALUES($1,$2,'appointment',$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id,dedupe_key) DO NOTHING RETURNING id`,
    [
      randomUUID(),
      input.tenantId,
      input.appointmentId,
      input.jobId,
      target.customerId,
      new Date(due).toISOString(),
      channel,
      dedupeKey,
      JSON.stringify({ template: 'appointment_reminder', appointmentVersion: input.version }),
    ],
  );
  const id =
    inserted.rows[0]?.id ??
    (
      await client.query<{ id: string }>(
        'SELECT id FROM reminders WHERE tenant_id=$1 AND dedupe_key=$2',
        [input.tenantId, dedupeKey],
      )
    ).rows[0]!.id;
  await enqueueReminder(queue, client, {
    tenantId: input.tenantId,
    reminderId: id,
    dueAt: new Date(due),
  });
  return id;
}

/**
 * Suppress outstanding reminders for an appointment (cancelled or moved). A draft already
 * prepared for the old time is marked discarded so it cannot be approved by mistake.
 */
export async function suppressAppointmentReminders(
  client: Transaction,
  tenantId: string,
  appointmentId: string,
  reason: string,
): Promise<number> {
  const suppressed = await client.query<{ communicationId: string | null }>(
    `UPDATE reminders SET status='suppressed',status_reason=$3,updated_at=now()
     WHERE tenant_id=$1 AND subject_type='appointment' AND subject_id=$2 AND status IN ('scheduled','prepared')
     RETURNING communication_id AS "communicationId"`,
    [tenantId, appointmentId, reason],
  );
  const drafts = suppressed.rows
    .map((row) => row.communicationId)
    .filter((value): value is string => value !== null);
  if (drafts.length)
    await client.query(
      "UPDATE communications SET status='discarded' WHERE tenant_id=$1 AND id = ANY($2::uuid[]) AND status='draft'",
      [tenantId, drafts],
    );
  return suppressed.rowCount ?? 0;
}
