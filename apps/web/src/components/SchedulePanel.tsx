import { useCallback, useEffect, useState } from 'react';
import { ApiError, newIdempotencyKey } from '../api';
import { href } from '../router';
import {
  cancelAppointment,
  CONFLICT_CODE,
  createAppointment,
  formatSlot,
  getAvailability,
  listJobAppointments,
  type Appointment,
  type Slot,
} from '../scheduling-api';
import { useWorkspace } from '../workspace';
import { Button, ErrorNotice, Notice, Pill, Section, SelectField, ViewOnlyNote } from './ui';

const DURATIONS = [
  { value: '60', label: '1 hour' },
  { value: '120', label: '2 hours' },
  { value: '240', label: 'Half day (4 hours)' },
  { value: '480', label: 'Full day (8 hours)' },
];

/**
 * Appointments for one job plus a "Schedule" action that offers free slots from the server
 * (working hours, travel buffer and existing bookings are applied there, not here).
 */
export function SchedulePanel({
  jobId,
  jobClosed,
  onChanged,
  autoOpen = false,
}: {
  jobId: string;
  jobClosed: boolean;
  onChanged: () => Promise<void>;
  /** Open the slot suggestions at once (the Today screen's "Schedule" action). */
  autoOpen?: boolean;
}) {
  const { isOwner, state } = useWorkspace();
  const timeZone = state.business.timeZone || 'Pacific/Auckland';
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [picking, setPicking] = useState(false);
  const [duration, setDuration] = useState('60');
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAppointments((await listJobAppointments(jobId)).appointments);
      setLoadError(null);
    } catch (err) {
      setLoadError(err);
    }
  }, [jobId]);
  useEffect(() => {
    void load();
  }, [load]);

  const suggest = useCallback(async (minutes: string, keepError = false) => {
    setSlots(null);
    if (!keepError) setError(null);
    try {
      const availability = await getAvailability({
        durationMinutes: Number(minutes),
        days: 14,
        limit: 6,
      });
      setSlots(availability.slots);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    if (!autoOpen || !isOwner || jobClosed) return;
    setPicking(true);
    void suggest('60');
  }, [autoOpen, isOwner, jobClosed, suggest]);

  async function book(slot: Slot) {
    setBusy(slot.startsAt);
    setError(null);
    setMessage(null);
    try {
      const result = await createAppointment(
        { jobId, startsAt: slot.startsAt, endsAt: slot.endsAt },
        newIdempotencyKey(),
      );
      setPicking(false);
      setSlots(null);
      setMessage(
        `Booked ${formatSlot(slot.startsAt, slot.endsAt, timeZone)}.` +
          (result.jobStatusChange ? ' The job is now scheduled.' : '') +
          (result.appointment.reminders.length
            ? ' A reminder draft will be prepared for your approval the day before.'
            : ''),
      );
      await Promise.all([load(), onChanged()]);
    } catch (err) {
      setError(err);
      // Someone else booked that time since the list was loaded: offer fresh slots.
      if (err instanceof ApiError && err.code === CONFLICT_CODE) await suggest(duration, true);
    } finally {
      setBusy(null);
    }
  }

  async function cancel(appointment: Appointment) {
    setBusy(appointment.id);
    setError(null);
    setMessage(null);
    try {
      await cancelAppointment(appointment.id, appointment.version);
      setMessage('Appointment cancelled. Its reminder will not be prepared.');
      await Promise.all([load(), onChanged()]);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  const upcoming = appointments.filter((appointment) => appointment.status !== 'cancelled');
  return (
    <Section
      title="Appointments"
      count={upcoming.length}
      action={
        isOwner && !jobClosed && !picking ? (
          <Button
            icon="calendar"
            onClick={() => {
              setPicking(true);
              void suggest(duration);
            }}
          >
            Schedule
          </Button>
        ) : undefined
      }
    >
      <div className="grid gap-3">
        {loadError !== null && <ErrorNotice title="Appointments didn’t load" error={loadError} />}
        {message && <Notice tone="success">{message}</Notice>}
        {error !== null && <ErrorNotice title="Not booked" error={error} />}
        {upcoming.length ? (
          <ul className="rows" aria-label="Appointments">
            {upcoming.map((appointment) => (
              <li key={appointment.id} className="row">
                <div className="min-w-0">
                  <p className="row-title">
                    {formatSlot(appointment.startsAt, appointment.endsAt, timeZone)}
                  </p>
                  <p className="row-sub">
                    <Pill tone={appointment.status === 'confirmed' ? 'approved' : 'draft'}>
                      {appointment.status === 'confirmed' ? 'Confirmed' : 'Proposed'}
                    </Pill>{' '}
                    {appointment.location ?? ''}
                  </p>
                </div>
                {isOwner && (
                  <Button
                    variant="quiet"
                    busy={busy === appointment.id}
                    disabled={busy !== null}
                    onClick={() => void cancel(appointment)}
                    aria-label={`Cancel appointment ${formatSlot(appointment.startsAt, appointment.endsAt, timeZone)}`}
                  >
                    Cancel
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          loadError === null && <p className="muted">No appointments booked.</p>
        )}
        {!isOwner && <ViewOnlyNote />}
        {picking && (
          <div className="grid gap-3" aria-label="Choose a time">
            <SelectField
              label="How long?"
              value={duration}
              onChange={(event) => {
                setDuration(event.target.value);
                void suggest(event.target.value);
              }}
            >
              {DURATIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </SelectField>
            {slots === null && <p className="muted">Finding free times…</p>}
            {slots && slots.length === 0 && (
              <p className="muted">No free time in the next two weeks within working hours.</p>
            )}
            {slots && slots.length > 0 && (
              <div className="form-actions" role="group" aria-label="Suggested times">
                {slots.map((slot) => (
                  <Button
                    key={slot.startsAt}
                    busy={busy === slot.startsAt}
                    disabled={busy !== null}
                    onClick={() => void book(slot)}
                  >
                    {formatSlot(slot.startsAt, slot.endsAt, timeZone)}
                  </Button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-3">
              <Button variant="quiet" onClick={() => setPicking(false)}>
                Close
              </Button>
              <a className="text-link" href={href('calendar')}>
                Open the calendar
              </a>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}
