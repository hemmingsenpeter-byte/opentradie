/**
 * Scheduling calls and types (Feature 14). Kept beside api.ts so the shared module stays small;
 * it reuses the same request() rules (cookie session, Idempotency-Key, error shape).
 */
import { request } from './api';

export type AppointmentStatus = 'proposed' | 'confirmed' | 'cancelled' | 'completed';

export interface Reminder {
  id: string;
  dueAt: string;
  channel: string;
  status: 'scheduled' | 'prepared' | 'sent' | 'cancelled' | 'suppressed';
  communicationId: string | null;
}

export interface Appointment {
  id: string;
  jobId: string;
  jobTitle: string;
  jobStatus: string;
  customerId: string;
  customerName: string;
  location: string | null;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  title: string;
  notes: string | null;
  version: number;
  conflictAcknowledged: boolean;
  reminders?: Reminder[];
}

export interface AppointmentMutation {
  appointment: Appointment & { reminders: Reminder[] };
  warnings: string[];
  jobStatusChange: { from: string; to: string } | null;
}

export interface Slot {
  startsAt: string;
  endsAt: string;
  localDate: string;
}

export interface Availability {
  timeZone: string;
  durationMinutes: number;
  bufferMinutes: number;
  fromDate: string;
  days: number;
  slots: Slot[];
}

/** Body of a 409 APPOINTMENT_CONFLICT; ApiError keeps only the message, so callers re-check. */
export const CONFLICT_CODE = 'APPOINTMENT_CONFLICT';

const enc = encodeURIComponent;

export const listAppointments = (from: Date, to: Date) =>
  request<{ appointments: Appointment[] }>(
    `/api/appointments?from=${enc(from.toISOString())}&to=${enc(to.toISOString())}`,
  );

export const listJobAppointments = (jobId: string) =>
  request<{ appointments: Appointment[] }>(`/api/jobs/${enc(jobId)}/appointments`);

export const getAvailability = (input: {
  date?: string;
  durationMinutes: number;
  days?: number;
  limit?: number;
}) => {
  const params = new URLSearchParams({ durationMinutes: String(input.durationMinutes) });
  if (input.date) params.set('date', input.date);
  if (input.days) params.set('days', String(input.days));
  if (input.limit) params.set('limit', String(input.limit));
  return request<Availability>(`/api/scheduling/availability?${params.toString()}`);
};

export const createAppointment = (
  input: { jobId: string; startsAt: string; endsAt: string; allowConflict?: boolean },
  idempotencyKey: string,
) =>
  request<AppointmentMutation>('/api/appointments', {
    method: 'POST',
    body: input,
    idempotencyKey,
  });

export const rescheduleAppointment = (
  id: string,
  input: { version: number; startsAt: string; endsAt: string; allowConflict?: boolean },
) => request<AppointmentMutation>(`/api/appointments/${enc(id)}`, { method: 'PATCH', body: input });

export const cancelAppointment = (id: string, version: number) =>
  request<AppointmentMutation>(`/api/appointments/${enc(id)}/cancel`, {
    method: 'POST',
    body: { version },
  });

/** "Tue 27 Oct, 9:00 am – 10:00 am" in the business time zone. */
export function formatSlot(startsAt: string, endsAt: string, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-NZ', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone,
  }).format(new Date(startsAt));
  const time = new Intl.DateTimeFormat('en-NZ', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
  return `${day}, ${time.format(new Date(startsAt))} – ${time.format(new Date(endsAt))}`;
}
