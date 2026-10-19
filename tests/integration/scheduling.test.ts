import { randomUUID } from 'node:crypto';
import { addLocalDays, instantToLocal, localTimeToInstant, localWeekday } from '@opentradie/core';
import {
  createReminderHandlers,
  createTaskHandlers,
  PostgresJobQueue,
  REMINDER_TASK_KIND,
  type Task,
} from '@opentradie/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appointmentDetailResponse,
  appointmentMutationResponse,
  availabilityResponse,
} from '../../apps/api/src/routes/scheduling.js';
import { createTestContext, customerId, TENANT_B, type TestContext } from '../helpers/app.js';

const NZ = 'Pacific/Auckland';

/**
 * A weekday `weeks` weeks ahead, so tests never depend on today's date or time. Different
 * week counts always give different dates.
 */
function futureWeekday(weeks = 1): string {
  let date = addLocalDays(instantToLocal(Date.now(), NZ).date, weeks * 7);
  while ([0, 6].includes(localWeekday(date))) date = addLocalDays(date, 1);
  return date;
}
/** ISO instant for a local NZ time on a date, e.g. at('2026-11-03', 9.5). */
const at = (date: string, hours: number) =>
  new Date(localTimeToInstant(date, Math.round(hours * 60), NZ)).toISOString();

describe('scheduling: appointments, availability and reminders', () => {
  let ctx: TestContext;
  let owner: string;
  let viewer: string;
  let margaret: string;
  let day: string;
  let kauri: string;

  const newJob = async (title: string, status?: string) => {
    const created = await ctx.send('POST', '/api/jobs', owner, {
      customerId: margaret,
      title,
      propertyId: kauri,
    });
    expect(created.status).toBe(201);
    if (status) {
      const moved = await ctx.send('PATCH', `/api/jobs/${created.body.id}`, owner, { status });
      expect(moved.status).toBe(200);
    }
    return created.body.id as string;
  };
  const book = (body: Record<string, unknown>, key?: string) =>
    ctx.send('POST', '/api/appointments', owner, body, key ? { key } : {});
  const count = async (sql: string, params: unknown[] = []) =>
    (await ctx.db.pool.query<{ n: number }>(sql, params)).rows[0]!.n;

  beforeAll(async () => {
    ctx = await createTestContext({ seedTenantB: true });
    owner = await ctx.login('owner');
    viewer = await ctx.login('viewer');
    margaret = await customerId(ctx.db, 'Mrs Johnson');
    day = futureWeekday();
    kauri = (await ctx.get(`/api/properties?customerId=${margaret}`, owner)).body.properties[0].id;
  });
  afterAll(async () => ctx?.close());

  it('books a confirmed appointment: job moves to scheduled, timeline, reminder and task are written', async () => {
    const job = await newJob('Install two power points');
    const response = await book(
      { jobId: job, startsAt: at(day, 10), endsAt: at(day, 11) },
      'book-first-appointment',
    );
    expect(response.status).toBe(201);
    const result = appointmentMutationResponse.parse(response.body);
    expect(result.jobStatusChange).toEqual({ from: 'new', to: 'scheduled' });
    expect(result.warnings).toEqual([]);
    expect(result.appointment).toMatchObject({
      jobId: job,
      status: 'confirmed',
      title: 'Install two power points',
      location: '14 Kauri Street, Grey Lynn, Auckland 1021',
      version: 1,
      jobStatus: 'scheduled',
    });
    expect(result.appointment.reminders).toHaveLength(1);
    const reminder = result.appointment.reminders[0]!;
    expect(reminder).toMatchObject({ status: 'scheduled', channel: 'email' });
    expect(Date.parse(reminder.dueAt)).toBe(Date.parse(at(day, 10)) - 86_400_000);

    const task = await ctx.db.pool.query(
      'SELECT run_at, idempotency_key FROM scheduled_tasks WHERE kind=$1 AND payload->>$2=$3',
      [REMINDER_TASK_KIND, 'reminderId', reminder.id],
    );
    expect(task.rows).toHaveLength(1);
    expect(task.rows[0].run_at.toISOString()).toBe(reminder.dueAt);

    const detail = (await ctx.get(`/api/jobs/${job}`, owner)).body;
    expect(detail.job.status).toBe('scheduled');
    const types = detail.timeline.map((event: { type: string }) => event.type);
    expect(types).toEqual(expect.arrayContaining(['appointment_scheduled', 'status_changed']));
    const audit = (await ctx.get(`/api/audit-events?entityId=${result.appointment.id}`, owner))
      .body;
    expect(audit.auditEvents.map((event: { action: string }) => event.action)).toEqual([
      'appointment.created',
    ]);

    // A retry with the same key replays the response without a second booking or reminder.
    const replay = await book(
      { jobId: job, startsAt: at(day, 10), endsAt: at(day, 11) },
      'book-first-appointment',
    );
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.appointment.id).toBe(result.appointment.id);
    expect(await count('SELECT count(*)::int AS n FROM appointments WHERE job_id=$1', [job])).toBe(
      1,
    );
    expect(
      await count('SELECT count(*)::int AS n FROM reminders WHERE subject_id=$1', [
        result.appointment.id,
      ]),
    ).toBe(1);
  });

  it('refuses clashes (including the travel buffer) with the conflicting ids, unless the owner accepts them', async () => {
    const job = await newJob('Fault finding');
    // Existing booking 10:00-11:00; the default buffer is 15 minutes.
    const clash = await book({ jobId: job, startsAt: at(day, 11.1), endsAt: at(day, 12) });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('APPOINTMENT_CONFLICT');
    expect(clash.body.bufferMinutes).toBe(15);
    expect(clash.body.conflicts).toHaveLength(1);
    expect(clash.body.conflicts[0]).toMatchObject({ title: 'Install two power points' });
    expect(await count('SELECT count(*)::int AS n FROM appointments WHERE job_id=$1', [job])).toBe(
      0,
    );

    const clear = await book({ jobId: job, startsAt: at(day, 11.25), endsAt: at(day, 12) });
    expect(clear.status).toBe(201);

    const forced = await book({
      jobId: job,
      startsAt: at(day, 10.5),
      endsAt: at(day, 11),
      allowConflict: true,
    });
    expect(forced.status).toBe(201);
    expect(forced.body.warnings).toContain('CONFLICT_ACKNOWLEDGED');
    expect(forced.body.appointment.conflictAcknowledged).toBe(true);
    // Cancel the forced one so later tests see a clean day.
    await ctx.send('POST', `/api/appointments/${forced.body.appointment.id}/cancel`, owner, {
      version: 1,
    });
  });

  it('serialises concurrent bookings of the same slot: exactly one wins', async () => {
    const job = await newJob('Concurrent booking');
    const slot = { jobId: job, startsAt: at(day, 14), endsAt: at(day, 15) };
    const results = await Promise.all([book(slot), book(slot), book(slot)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it('reschedules with an optimistic version check and replaces the reminder', async () => {
    const job = await newJob('Heated towel rail');
    const created = await book({ jobId: job, startsAt: at(day, 7), endsAt: at(day, 8) });
    const appointment = created.body.appointment;
    const firstReminder = appointment.reminders[0].id;

    const stale = await ctx.send('PATCH', `/api/appointments/${appointment.id}`, owner, {
      version: 99,
      startsAt: at(day, 8),
      endsAt: at(day, 9),
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: 'VERSION_CONFLICT', currentVersion: 1 });

    const intoClash = await ctx.send('PATCH', `/api/appointments/${appointment.id}`, owner, {
      version: 1,
      startsAt: at(day, 9.5),
      endsAt: at(day, 10.5),
    });
    expect(intoClash.status).toBe(409);
    expect(intoClash.body.error).toBe('APPOINTMENT_CONFLICT');

    const nextDay = futureWeekday(2);
    const moved = await ctx.send('PATCH', `/api/appointments/${appointment.id}`, owner, {
      version: 1,
      startsAt: at(nextDay, 8),
      endsAt: at(nextDay, 9),
    });
    expect(moved.status).toBe(200);
    const result = appointmentMutationResponse.parse(moved.body);
    expect(result.appointment.version).toBe(2);
    expect(result.appointment.startsAt).toBe(at(nextDay, 8));
    const reminders = result.appointment.reminders;
    expect(reminders.map((r) => [r.id === firstReminder, r.status])).toEqual([
      [true, 'suppressed'],
      [false, 'scheduled'],
    ]);
    expect(Date.parse(reminders[1]!.dueAt)).toBe(Date.parse(at(nextDay, 8)) - 86_400_000);

    // Moving within its own old slot does not conflict with itself.
    const nudge = await ctx.send('PATCH', `/api/appointments/${appointment.id}`, owner, {
      version: 2,
      startsAt: at(nextDay, 8.5),
      endsAt: at(nextDay, 9.5),
    });
    expect(nudge.status).toBe(200);
    const events = (await ctx.get(`/api/jobs/${job}`, owner)).body.timeline.map(
      (event: { type: string }) => event.type,
    );
    expect(events.filter((type: string) => type === 'appointment_rescheduled')).toHaveLength(2);
  });

  it('cancelling suppresses reminders, frees the slot and leaves the job status alone', async () => {
    const job = await newJob('Oven circuit');
    const otherDay = futureWeekday(3);
    const created = await book({ jobId: job, startsAt: at(otherDay, 9), endsAt: at(otherDay, 10) });
    const appointment = created.body.appointment;
    const cancelled = await ctx.send('POST', `/api/appointments/${appointment.id}/cancel`, owner, {
      version: 1,
      reason: 'Customer away',
    });
    expect(cancelled.status).toBe(200);
    const detail = appointmentDetailResponse.parse(cancelled.body.appointment);
    expect(detail).toMatchObject({ status: 'cancelled', cancelReason: 'Customer away' });
    expect(detail.reminders.map((r) => r.status)).toEqual(['suppressed']);
    expect((await ctx.get(`/api/jobs/${job}`, owner)).body.job.status).toBe('scheduled');

    // Cancelling again is a no-op.
    const again = await ctx.send('POST', `/api/appointments/${appointment.id}/cancel`, owner, {
      version: 1,
    });
    expect(again.status).toBe(200);
    expect(again.body.warnings).toEqual(['ALREADY_CANCELLED']);
    // A cancelled appointment cannot be moved, and no longer blocks its slot.
    const move = await ctx.send('PATCH', `/api/appointments/${appointment.id}`, owner, {
      version: 2,
      startsAt: at(otherDay, 11),
      endsAt: at(otherDay, 12),
    });
    expect(move.status).toBe(409);
    expect(move.body.error).toBe('APPOINTMENT_CLOSED');
    const rebook = await book({ jobId: job, startsAt: at(otherDay, 9), endsAt: at(otherDay, 10) });
    expect(rebook.status).toBe(201);

    const listed = (
      await ctx.get(
        `/api/appointments?from=${encodeURIComponent(at(otherDay, 0))}&to=${encodeURIComponent(at(otherDay, 24))}`,
        owner,
      )
    ).body.appointments;
    expect(listed.map((a: { id: string }) => a.id)).toEqual([rebook.body.appointment.id]);
    const withCancelled = (
      await ctx.get(
        `/api/appointments?from=${encodeURIComponent(at(otherDay, 0))}&to=${encodeURIComponent(at(otherDay, 24))}&includeCancelled=true`,
        owner,
      )
    ).body.appointments;
    expect(withCancelled).toHaveLength(2);
  });

  it('a proposed appointment schedules the job only when confirmed; quoted jobs move too, active jobs do not', async () => {
    const quoted = await newJob('Switchboard upgrade', 'quoted');
    const proposedDay = futureWeekday(4);
    const proposed = await book({
      jobId: quoted,
      startsAt: at(proposedDay, 13),
      endsAt: at(proposedDay, 15),
      status: 'proposed',
      source: 'customer_request',
    });
    expect(proposed.status).toBe(201);
    expect(proposed.body.jobStatusChange).toBeNull();
    expect(proposed.body.appointment.reminders).toEqual([]);
    expect((await ctx.get(`/api/jobs/${quoted}`, owner)).body.job.status).toBe('quoted');

    const id = proposed.body.appointment.id;
    const confirmed = await ctx.send('POST', `/api/appointments/${id}/confirm`, owner, {
      version: 1,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.jobStatusChange).toEqual({ from: 'quoted', to: 'scheduled' });
    expect(confirmed.body.appointment).toMatchObject({ status: 'confirmed', version: 2 });
    expect(confirmed.body.appointment.reminders).toHaveLength(1);
    const twice = await ctx.send('POST', `/api/appointments/${id}/confirm`, owner, {
      version: 2,
    });
    expect(twice.body.warnings).toEqual(['ALREADY_CONFIRMED']);
    expect(twice.body.appointment.reminders).toHaveLength(1);

    const active = await newJob('Rewire garage', 'in_progress');
    const booked = await book({
      jobId: active,
      startsAt: at(proposedDay, 9),
      endsAt: at(proposedDay, 10),
    });
    expect(booked.status).toBe(201);
    expect(booked.body.jobStatusChange).toBeNull();
    expect((await ctx.get(`/api/jobs/${active}`, owner)).body.job.status).toBe('in_progress');
  });

  it('validates times and refuses closed jobs', async () => {
    const job = await newJob('Validation job');
    const backwards = await book({ jobId: job, startsAt: at(day, 12), endsAt: at(day, 11) });
    expect(backwards.status).toBe(422);
    expect(backwards.body.error).toBe('INVALID_TIME_RANGE');
    const past = await book({
      jobId: job,
      startsAt: '2020-01-01T00:00:00Z',
      endsAt: '2020-01-01T01:00:00Z',
    });
    expect(past.body.error).toBe('APPOINTMENT_IN_PAST');
    const tooLong = await book({ jobId: job, startsAt: at(day, 0), endsAt: at(day, 17) });
    expect(tooLong.body.error).toBe('INVALID_TIME_RANGE');
    const naive = await book({ jobId: job, startsAt: '2030-01-01T10:00', endsAt: at(day, 11) });
    expect(naive.status).toBe(400);
    const completed = (
      await ctx.db.pool.query(
        "SELECT id FROM jobs WHERE status='completed' AND tenant_id='11111111-1111-4111-8111-111111111111' LIMIT 1",
      )
    ).rows[0].id;
    const closed = await book({ jobId: completed, startsAt: at(day, 16), endsAt: at(day, 17) });
    expect(closed.status).toBe(409);
    expect(closed.body.error).toBe('JOB_CLOSED');
  });

  it('offers free slots inside working hours around existing bookings and settings', async () => {
    const response = await ctx.get(
      `/api/scheduling/availability?date=${day}&durationMinutes=60`,
      viewer,
    );
    expect(response.status).toBe(200);
    const availability = availabilityResponse.parse(response.body);
    expect(availability).toMatchObject({ timeZone: NZ, bufferMinutes: 15, fromDate: day });
    const starts = availability.slots.map(
      (slot) => instantToLocal(Date.parse(slot.startsAt), NZ).minuteOfDay / 60,
    );
    // Booked on `day`: 10:00-11:00, 11:15-12:00, 14:00-15:00 (15 minute buffer each side).
    expect(starts).toEqual([7, 7.5, 8, 8.5, 12.5, 15.5, 16]);
    expect(availability.slots.every((slot) => slot.localDate === day)).toBe(true);

    const weekend = addLocalDays(day, (6 - localWeekday(day) + 7) % 7);
    expect(
      (await ctx.get(`/api/scheduling/availability?date=${weekend}`, owner)).body.slots,
    ).toEqual([]);
    const suggestions = await ctx.get(
      `/api/scheduling/availability?date=${weekend}&days=4&limit=3&durationMinutes=120`,
      owner,
    );
    expect(suggestions.body.slots).toHaveLength(3);
    expect(suggestions.body.slots[0].localDate).not.toBe(weekend);

    const settings = await ctx.send('PATCH', '/api/scheduling/settings', owner, {
      bufferMinutes: 0,
      workingHours: [{ weekday: localWeekday(day), startMinute: 12 * 60, endMinute: 13 * 60 }],
    });
    expect(settings.status).toBe(200);
    expect(settings.body).toMatchObject({ bufferMinutes: 0, usingDefaultHours: false });
    const narrowed = (await ctx.get(`/api/scheduling/availability?date=${day}`, owner)).body;
    expect(
      narrowed.slots.map(
        (slot: { startsAt: string }) => instantToLocal(Date.parse(slot.startsAt), NZ).minuteOfDay,
      ),
    ).toEqual([12 * 60]);
    const invalid = await ctx.send('PATCH', '/api/scheduling/settings', owner, {
      workingHours: [
        { weekday: 1, startMinute: 600, endMinute: 700 },
        { weekday: 1, startMinute: 650, endMinute: 800 },
      ],
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error).toBe('INVALID_WORKING_HOURS');
    // Restore defaults for later tests.
    const restored = await ctx.send('PATCH', '/api/scheduling/settings', owner, {
      bufferMinutes: 15,
      workingHours: [],
    });
    expect(restored.body.usingDefaultHours).toBe(true);
    // Outside working hours is allowed but flagged.
    const job = await newJob('Evening callout');
    const evening = await book({ jobId: job, startsAt: at(day, 19), endsAt: at(day, 20) });
    expect(evening.status).toBe(201);
    expect(evening.body.warnings).toContain('OUTSIDE_WORKING_HOURS');
  });

  it('gives viewers read access but 403 on every scheduling mutation', async () => {
    const appointment = (
      await ctx.db.pool.query("SELECT id FROM appointments WHERE status='confirmed' LIMIT 1")
    ).rows[0].id;
    expect((await ctx.get(`/api/appointments/${appointment}`, viewer)).status).toBe(200);
    expect((await ctx.get('/api/scheduling/settings', viewer)).status).toBe(200);
    const job = (await ctx.get('/api/jobs', viewer)).body.jobs[0].id;
    const attempts: Array<['POST' | 'PATCH', string, unknown]> = [
      ['POST', '/api/appointments', { jobId: job, startsAt: at(day, 16), endsAt: at(day, 17) }],
      [
        'PATCH',
        `/api/appointments/${appointment}`,
        { version: 1, startsAt: at(day, 16), endsAt: at(day, 17) },
      ],
      ['POST', `/api/appointments/${appointment}/confirm`, { version: 1 }],
      ['POST', `/api/appointments/${appointment}/cancel`, { version: 1 }],
      ['PATCH', '/api/scheduling/settings', { bufferMinutes: 0 }],
    ];
    for (const [method, path, body] of attempts) {
      const response = await ctx.send(method, path, viewer, body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(response.body.error).toBe('OWNER_REQUIRED');
    }
    for (const path of ['/api/appointments/' + appointment, '/api/scheduling/availability'])
      expect((await ctx.get(path, '')).status, path).toBe(401);
  });

  it('isolates tenants: foreign jobs and appointments are not found and never listed', async () => {
    const foreignCustomer = await customerId(ctx.db, 'Mrs Johnson', TENANT_B);
    const foreignJob = (
      await ctx.db.pool.query('SELECT id FROM jobs WHERE tenant_id=$1 AND customer_id=$2 LIMIT 1', [
        TENANT_B,
        foreignCustomer,
      ])
    ).rows[0].id;
    const foreignAppointment = randomUUID();
    const isoDay = futureWeekday(5);
    await ctx.db.pool.query(
      "INSERT INTO appointments(id,tenant_id,job_id,starts_at,ends_at,title) VALUES($1,$2,$3,$4,$5,'Other tenant')",
      [foreignAppointment, TENANT_B, foreignJob, at(isoDay, 9), at(isoDay, 10)],
    );
    expect(
      (await book({ jobId: foreignJob, startsAt: at(isoDay, 9), endsAt: at(isoDay, 10) })).status,
    ).toBe(404);
    expect((await ctx.get(`/api/appointments/${foreignAppointment}`, owner)).status).toBe(404);
    expect((await ctx.get(`/api/jobs/${foreignJob}/appointments`, owner)).status).toBe(404);
    for (const [method, path, body] of [
      [
        'PATCH',
        `/api/appointments/${foreignAppointment}`,
        { version: 1, startsAt: at(isoDay, 11), endsAt: at(isoDay, 12) },
      ],
      ['POST', `/api/appointments/${foreignAppointment}/confirm`, { version: 1 }],
      ['POST', `/api/appointments/${foreignAppointment}/cancel`, { version: 1 }],
    ] as const) {
      expect((await ctx.send(method, path, owner, body)).status, path).toBe(404);
    }
    const listed = (
      await ctx.get(
        `/api/appointments?from=${encodeURIComponent(at(isoDay, 0))}&to=${encodeURIComponent(at(isoDay, 24))}`,
        owner,
      )
    ).body.appointments;
    expect(listed).toEqual([]);
    // The other tenant's booking does not block this tenant's availability.
    const slots = (await ctx.get(`/api/scheduling/availability?date=${isoDay}`, owner)).body.slots;
    expect(slots.map((slot: { startsAt: string }) => slot.startsAt)).toContain(at(isoDay, 9));
    const untouched = await ctx.db.pool.query(
      'SELECT status,version FROM appointments WHERE id=$1',
      [foreignAppointment],
    );
    expect(untouched.rows[0]).toEqual({ status: 'confirmed', version: 1 });
    // The database refuses a cross-tenant job reference outright.
    await expect(
      ctx.db.pool.query(
        "INSERT INTO appointments(id,tenant_id,job_id,starts_at,ends_at,title) VALUES($1,'11111111-1111-4111-8111-111111111111',$2,now()+interval '1 day',now()+interval '25 hours','x')",
        [randomUUID(), foreignJob],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('0009 extends the job timeline types without dropping earlier ones', async () => {
    const constraint = await ctx.db.pool.query(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='job_events'::regclass AND conname='job_events_type_check'",
    );
    const definition: string = constraint.rows[0].def;
    for (const type of [
      'created',
      'quote_rejected',
      'appointment_scheduled',
      'appointment_cancelled',
    ])
      expect(definition, type).toContain(`'${type}'`);
  });

  it('includes scheduling tables in the owner export', async () => {
    const exported = (await ctx.get('/api/export', owner)).body;
    expect(exported.tables.appointments.rows.length).toBeGreaterThan(0);
    expect(exported.tables.reminders.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(exported.tables.appointments)).not.toContain(TENANT_B);
  });
});

describe('durable reminder preparation', () => {
  let ctx: TestContext;
  let owner: string;
  let queue: PostgresJobQueue;
  let handlers: ReturnType<typeof createTaskHandlers>;

  const bookAppointment = async (title: string, date: string) => {
    const margaret = await customerId(ctx.db, 'Mrs Johnson');
    const kauri = (await ctx.get(`/api/properties?customerId=${margaret}`, owner)).body
      .properties[0].id;
    const job = await ctx.send('POST', '/api/jobs', owner, {
      customerId: margaret,
      title,
      propertyId: kauri,
    });
    const booked = await ctx.send('POST', '/api/appointments', owner, {
      jobId: job.body.id,
      startsAt: at(date, 9),
      endsAt: at(date, 10),
    });
    expect(booked.status).toBe(201);
    return booked.body.appointment as { id: string; reminders: Array<{ id: string }> };
  };
  /** Make a reminder (and its queued task) due now. */
  const makeDue = async (reminderId: string) => {
    await ctx.db.pool.query("UPDATE reminders SET due_at=now() - interval '1 second' WHERE id=$1", [
      reminderId,
    ]);
    await ctx.db.pool.query(
      "UPDATE scheduled_tasks SET run_at=now() - interval '1 second' WHERE kind=$1 AND payload->>'reminderId'=$2",
      [REMINDER_TASK_KIND, reminderId],
    );
  };
  const drafts = async (reminderId: string) =>
    (
      await ctx.db.pool.query(
        'SELECT id,status,direction,channel,subject,text FROM communications WHERE external_reference=$1',
        [`reminder:${reminderId}`],
      )
    ).rows;
  const taskFor = async (reminderId: string): Promise<Task> => {
    const row = (
      await ctx.db.pool.query(
        `SELECT id,tenant_id AS "tenantId",kind,payload,idempotency_key AS "idempotencyKey",attempts,max_attempts AS "maxAttempts"
         FROM scheduled_tasks WHERE kind=$1 AND payload->>'reminderId'=$2`,
        [REMINDER_TASK_KIND, reminderId],
      )
    ).rows[0];
    return { ...row, leaseOwner: 'test' };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await ctx.login('owner');
    queue = new PostgresJobQueue(ctx.db, { baseRetryDelayMs: 1 });
    handlers = createTaskHandlers({ queue, privacyMode: 'LOCAL_ONLY', embeddingProvider: null });
  });
  afterAll(async () => ctx?.close());

  it('prepares a due reminder as one outbound draft, however often the task runs', async () => {
    const appointment = await bookAppointment('Reminder job', futureWeekday(1));
    const reminderId = appointment.reminders[0]!.id;
    // Not due yet: the worker leaves it alone.
    expect(await queue.runOnce('worker-a', handlers)).toBe(0);
    await makeDue(reminderId);
    expect(await queue.runOnce('worker-a', handlers)).toBe(1);

    const created = await drafts(reminderId);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      status: 'draft',
      direction: 'outbound',
      channel: 'email',
      subject: 'Appointment reminder',
    });
    expect(created[0].text).toMatch(/^Kia ora /);
    expect(created[0].text).toContain('14 Kauri Street');
    const detail = (await ctx.get(`/api/appointments/${appointment.id}`, owner)).body;
    expect(detail.reminders[0]).toMatchObject({
      status: 'prepared',
      communicationId: created[0].id,
    });

    // Duplicate delivery of the same task (at-least-once queue) changes nothing.
    const task = await taskFor(reminderId);
    await createReminderHandlers()[REMINDER_TASK_KIND]!(task, { db: ctx.db });
    await createReminderHandlers()[REMINDER_TASK_KIND]!(task, { db: ctx.db });
    expect(await drafts(reminderId)).toHaveLength(1);
    // Re-enqueueing is deduplicated by the reminder id.
    const again = await queue.enqueue({
      tenantId: task.tenantId,
      kind: REMINDER_TASK_KIND,
      payload: { reminderId },
      idempotencyKey: `reminder:${reminderId}`,
    });
    expect(again).toEqual({ id: task.id, created: false });
    const audits = await ctx.db.pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action='reminder.prepared' AND entity_id=$1",
      [reminderId],
    );
    expect(audits.rows[0].n).toBe(1);

    // Cancelling the appointment discards the prepared draft so it cannot be approved by mistake.
    const cancelled = await ctx.send('POST', `/api/appointments/${appointment.id}/cancel`, owner, {
      version: 1,
    });
    expect(cancelled.body.appointment.reminders[0].status).toBe('suppressed');
    expect((await drafts(reminderId))[0].status).toBe('discarded');
  });

  it('retries after a failure part-way and still creates exactly one draft', async () => {
    const appointment = await bookAppointment('Retry job', futureWeekday(2));
    const reminderId = appointment.reminders[0]!.id;
    await makeDue(reminderId);
    // The handler commits its work, then the worker fails before marking the task complete.
    const failing = {
      [REMINDER_TASK_KIND]: async (task: Task, context: { db: typeof ctx.db }) => {
        await createReminderHandlers()[REMINDER_TASK_KIND]!(task, context);
        throw new Error('simulated crash after work');
      },
    };
    expect(await queue.runOnce('worker-b', failing)).toBe(1);
    const status = await ctx.db.pool.query(
      "SELECT status,attempts FROM scheduled_tasks WHERE kind=$1 AND payload->>'reminderId'=$2",
      [REMINDER_TASK_KIND, reminderId],
    );
    expect(status.rows[0]).toMatchObject({ status: 'pending', attempts: 1 });
    await ctx.db.pool.query(
      "UPDATE scheduled_tasks SET run_at=now() - interval '1 second' WHERE kind=$1 AND payload->>'reminderId'=$2",
      [REMINDER_TASK_KIND, reminderId],
    );
    // The retry with the real handler is a no-op on the already prepared reminder.
    expect(await queue.runOnce('worker-b', handlers)).toBe(1);
    expect(await drafts(reminderId)).toHaveLength(1);
    const done = await ctx.db.pool.query(
      "SELECT status FROM scheduled_tasks WHERE kind=$1 AND payload->>'reminderId'=$2",
      [REMINDER_TASK_KIND, reminderId],
    );
    expect(done.rows[0].status).toBe('completed');
  });

  it('suppresses instead of drafting when the appointment was cancelled or moved, and waits when early', async () => {
    const appointment = await bookAppointment('Suppressed job', futureWeekday(3));
    const reminderId = appointment.reminders[0]!.id;
    // An early delivery throws so the queue retries later; nothing is prepared.
    await expect(
      createReminderHandlers()[REMINDER_TASK_KIND]!(await taskFor(reminderId), { db: ctx.db }),
    ).rejects.toThrow(/not due/);
    await makeDue(reminderId);
    // Appointment cancelled behind the reminder's back (e.g. a race with the worker).
    await ctx.db.pool.query(
      "UPDATE appointments SET status='cancelled', cancelled_at=now() WHERE id=$1",
      [appointment.id],
    );
    expect(await queue.runOnce('worker-c', handlers)).toBe(1);
    expect(await drafts(reminderId)).toEqual([]);
    const row = await ctx.db.pool.query('SELECT status,status_reason FROM reminders WHERE id=$1', [
      reminderId,
    ]);
    expect(row.rows[0]).toEqual({ status: 'suppressed', status_reason: 'appointment_cancelled' });

    // A task for a reminder from another tenant (or a bad id) fails permanently.
    const bogus = { ...(await taskFor(reminderId)), payload: { reminderId: randomUUID() } };
    await expect(
      createReminderHandlers()[REMINDER_TASK_KIND]!(bogus, { db: ctx.db }),
    ).rejects.toThrow(/not found/);
  });
});
