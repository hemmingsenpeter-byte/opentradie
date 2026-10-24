import { randomUUID } from 'node:crypto';
import { recordAudit, transaction, type Queryable } from '@opentradie/database';
import { PermanentTaskError, type PostgresJobQueue, type TaskHandler } from './job-queue.js';

export const REMINDER_TASK_KIND = 'reminder.prepare';

/**
 * Enqueue the durable task that prepares a reminder when it falls due. The task key is the
 * reminder id, so enqueueing twice (retries, replays) never creates a second task.
 */
export function enqueueReminder(
  queue: PostgresJobQueue,
  client: Queryable,
  input: { tenantId: string; reminderId: string; dueAt: Date },
) {
  return queue.enqueue(
    {
      tenantId: input.tenantId,
      kind: REMINDER_TASK_KIND,
      payload: { reminderId: input.reminderId },
      idempotencyKey: `reminder:${input.reminderId}`,
      runAt: input.dueAt,
      maxAttempts: 8,
    },
    client,
  );
}

interface ReminderRow {
  id: string;
  subjectType: string;
  subjectId: string | null;
  jobId: string | null;
  customerId: string | null;
  channel: string;
  status: string;
  due: boolean;
  payload: { template?: unknown; proposalId?: unknown };
}

interface AppointmentContext {
  status: string;
  startsAt: Date;
  location: string | null;
  upcoming: boolean;
  customerName: string;
  preferredName: string | null;
  businessName: string;
  timeZone: string;
  locale: string;
}

/** Customer-facing wording for an appointment reminder draft. The owner edits and approves it. */
export function appointmentReminderText(context: AppointmentContext): string {
  let when: string;
  try {
    when = new Intl.DateTimeFormat(context.locale, {
      timeZone: context.timeZone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
    }).format(context.startsAt);
  } catch {
    when = context.startsAt.toISOString();
  }
  const name = context.preferredName ?? context.customerName;
  const where = context.location ? ` at ${context.location}` : '';
  return `Kia ora ${name}, this is a reminder of your appointment with ${context.businessName} on ${when}${where}. Reply to this message if the time no longer suits.`;
}

/**
 * Reminder handlers. A due reminder becomes an outbound communication DRAFT: nothing is sent
 * (no provider is connected and every send needs owner approval). Safe under at-least-once
 * delivery: the reminder row is locked, only 'scheduled' reminders are prepared, and the draft is
 * deduplicated on `reminder:<id>` in communications.
 */
export function createReminderHandlers(): Record<string, TaskHandler> {
  return {
    [REMINDER_TASK_KIND]: async (task, { db }) => {
      const reminderId = String(task.payload.reminderId ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(reminderId))
        throw new PermanentTaskError('Invalid reminder id.');
      await transaction(db, async (client) => {
        const found = await client.query<ReminderRow>(
          `SELECT id,subject_type AS "subjectType",subject_id AS "subjectId",job_id AS "jobId",customer_id AS "customerId",
             channel,status,(due_at <= now()) AS due,payload
           FROM reminders WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [task.tenantId, reminderId],
        );
        const reminder = found.rows[0];
        if (!reminder) throw new PermanentTaskError('Reminder not found for this tenant.');
        // Already prepared, sent, cancelled or suppressed: a duplicate delivery does nothing.
        if (reminder.status !== 'scheduled') return;
        // Delivered early (clock skew or a manual run): retry later rather than prepare early.
        if (!reminder.due) throw new Error('Reminder is not due yet.');

        const setStatus = async (status: string, reason: string, communicationId?: string) => {
          await client.query(
            `UPDATE reminders SET status=$3,status_reason=$4,communication_id=coalesce($5,communication_id),
               prepared_at=CASE WHEN $3='prepared' THEN now() ELSE prepared_at END,updated_at=now()
             WHERE tenant_id=$1 AND id=$2`,
            [task.tenantId, reminderId, status, reason, communicationId ?? null],
          );
          await recordAudit(client, {
            tenantId: task.tenantId,
            actorType: 'system',
            actorId: null,
            action: status === 'prepared' ? 'reminder.prepared' : 'reminder.suppressed',
            entityType: 'reminder',
            entityId: reminderId,
            requestId: `task:${task.id}`,
            metadata: {
              subjectType: reminder.subjectType,
              subjectId: reminder.subjectId,
              reason,
              ...(communicationId ? { communicationId } : {}),
            },
          });
        };

        const prepareDraft = async (subject: string, text: string) => {
          const reference = `reminder:${reminderId}`;
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO communications(id,tenant_id,customer_id,job_id,direction,channel,status,subject,text,external_reference)
             VALUES($1,$2,$3,$4,'outbound',$5,'draft',$6,$7,$8)
             ON CONFLICT (tenant_id,channel,external_reference) WHERE external_reference IS NOT NULL DO NOTHING
             RETURNING id`,
            [
              randomUUID(),
              task.tenantId,
              reminder.customerId,
              reminder.jobId,
              reminder.channel,
              subject,
              text,
              reference,
            ],
          );
          const communicationId =
            inserted.rows[0]?.id ??
            (
              await client.query<{ id: string }>(
                'SELECT id FROM communications WHERE tenant_id=$1 AND channel=$2 AND external_reference=$3',
                [task.tenantId, reminder.channel, reference],
              )
            ).rows[0]!.id;
          await setStatus('prepared', 'draft_created', communicationId);
        };

        if (reminder.subjectType === 'job' || reminder.subjectType === 'custom') {
          // Owner reminders from an approved assistant proposal (reminder.create). The text lives
          // on the proposal, never in the reminder payload; it becomes a manual draft for the
          // owner to act on. Nothing is sent.
          const proposalId = reminder.payload.proposalId;
          if (
            reminder.payload.template !== 'owner_reminder' ||
            typeof proposalId !== 'string' ||
            !/^[0-9a-f-]{36}$/i.test(proposalId)
          )
            return void (await setStatus('suppressed', 'unsupported_subject'));
          const proposal = await client.query<{ text: unknown }>(
            "SELECT payload->'text' AS text FROM action_proposals WHERE tenant_id=$1 AND id=$2 AND status='executed'",
            [task.tenantId, proposalId],
          );
          const text = proposal.rows[0]?.text;
          if (typeof text !== 'string' || !text.trim())
            return void (await setStatus('suppressed', 'proposal_missing'));
          await prepareDraft('Reminder', text);
          return;
        }
        if (reminder.subjectType !== 'appointment') {
          // Invoice reminders arrive with Phase 6b; until then they are not prepared.
          await setStatus('suppressed', 'unsupported_subject');
          return;
        }
        const appointment = await client.query<AppointmentContext>(
          `SELECT a.status,a.starts_at AS "startsAt",a.location,(a.starts_at > now()) AS upcoming,
             c.name AS "customerName",c.preferred_name AS "preferredName",
             b.name AS "businessName",b.time_zone AS "timeZone",b.locale
           FROM appointments a
             JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
             JOIN customers c ON c.tenant_id=j.tenant_id AND c.id=j.customer_id
             JOIN businesses b ON b.id=a.tenant_id
           WHERE a.tenant_id=$1 AND a.id=$2`,
          [task.tenantId, reminder.subjectId],
        );
        const context = appointment.rows[0];
        if (!context) return void (await setStatus('suppressed', 'appointment_missing'));
        if (context.status !== 'confirmed')
          return void (await setStatus('suppressed', `appointment_${context.status}`));
        if (!context.upcoming) return void (await setStatus('suppressed', 'appointment_started'));

        await prepareDraft('Appointment reminder', appointmentReminderText(context));
      });
    },
  };
}
