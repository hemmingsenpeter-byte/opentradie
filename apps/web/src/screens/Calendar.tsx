import type {
  BusinessHoursInput,
  EventChangeArg,
  EventClickArg,
  EventInput,
  EventSourceFuncArg,
} from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import listPlugin from '@fullcalendar/list';
import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { request } from '../api';
import { ErrorNotice, Notice, PageHeader, ViewOnlyNote } from '../components/ui';
import { href, navigate } from '../router';
import { listAppointments, rescheduleAppointment, type Appointment } from '../scheduling-api';
import { useWorkspace } from '../workspace';
import './calendar.css';

interface WorkingHours {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Phones get the list view by default; wider screens the week grid. */
function isNarrow(): boolean {
  if (typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(max-width: 767px)').matches;
}

export function toEvent(appointment: Appointment, editable: boolean): EventInput {
  return {
    id: appointment.id,
    title: `${appointment.title} · ${appointment.customerName}`,
    start: appointment.startsAt,
    end: appointment.endsAt,
    editable: editable && appointment.status !== 'cancelled' && appointment.status !== 'completed',
    classNames: [`appt-${appointment.status}`],
    extendedProps: { jobId: appointment.jobId, version: appointment.version },
  };
}

/**
 * Calendar of appointments (FullCalendar Standard, MIT packages only). Dragging or resizing an
 * appointment reschedules it through the API with its version; the server's clash check,
 * buffer and optimistic concurrency decide, and a refused move snaps back.
 */
export function CalendarScreen() {
  const { isOwner, state } = useWorkspace();
  const calendar = useRef<FullCalendar>(null);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [hours, setHours] = useState<WorkingHours[]>([]);
  const narrow = useMemo(isNarrow, []);
  const businessZone = state.business.timeZone || 'Pacific/Auckland';
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    request<{ workingHours: WorkingHours[] }>('/api/scheduling/settings')
      .then((settings) => setHours(settings.workingHours))
      .catch(() => setHours([]));
  }, []);

  const events = useCallback(
    (
      info: EventSourceFuncArg,
      success: (events: EventInput[]) => void,
      failure: (e: Error) => void,
    ) => {
      listAppointments(info.start, info.end)
        .then((result) => {
          setError(null);
          success(result.appointments.map((appointment) => toEvent(appointment, isOwner)));
        })
        .catch((err: Error) => {
          setError(err);
          failure(err);
        });
    },
    [isOwner],
  );

  const moved = useCallback(async (change: EventChangeArg) => {
    const { event } = change;
    setError(null);
    setMessage(null);
    if (!event.start || !event.end) return change.revert();
    try {
      const result = await rescheduleAppointment(event.id, {
        version: Number(event.extendedProps.version),
        startsAt: event.start.toISOString(),
        endsAt: event.end.toISOString(),
      });
      event.setExtendedProp('version', result.appointment.version);
      setMessage(
        result.warnings.includes('OUTSIDE_WORKING_HOURS')
          ? 'Moved. Note: this is outside your working hours.'
          : 'Moved. The customer reminder now follows the new time.',
      );
    } catch (err) {
      change.revert();
      setError(err);
      calendar.current?.getApi().refetchEvents();
    }
  }, []);

  const businessHours: BusinessHoursInput = hours.map((rule) => ({
    daysOfWeek: [rule.weekday],
    startTime: hhmm(rule.startMinute),
    endTime: hhmm(rule.endMinute),
  }));

  return (
    <div className="stack">
      <PageHeader title="Calendar" eyebrow="Appointments" />
      {deviceZone !== businessZone && (
        <Notice tone="info">
          Times are shown in this device’s time zone ({deviceZone}); the business runs on{' '}
          {businessZone}.
        </Notice>
      )}
      {!isOwner && <ViewOnlyNote />}
      {message && <Notice tone="success">{message}</Notice>}
      {error !== null && <ErrorNotice title="Calendar not updated" error={error} />}
      <div className="card card-pad calendar-host" data-testid="calendar">
        <FullCalendar
          ref={calendar}
          plugins={[listPlugin, timeGridPlugin, dayGridPlugin, interactionPlugin]}
          initialView={narrow ? 'listWeek' : 'timeGridWeek'}
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: narrow
              ? 'listWeek,timeGridDay'
              : 'listWeek,timeGridDay,timeGridWeek,dayGridMonth',
          }}
          buttonText={{
            listWeek: 'List',
            timeGridDay: 'Day',
            timeGridWeek: 'Week',
            dayGridMonth: 'Month',
          }}
          firstDay={1}
          timeZone="local"
          height="auto"
          nowIndicator
          allDaySlot={false}
          slotMinTime="06:00:00"
          slotMaxTime="21:00:00"
          businessHours={businessHours}
          editable={isOwner}
          eventDurationEditable={isOwner}
          snapDuration="00:15:00"
          events={events}
          eventDrop={(change) => void moved(change)}
          eventResize={(change) => void moved(change)}
          eventClick={(click: EventClickArg) => {
            click.jsEvent.preventDefault();
            navigate(href('jobs', String(click.event.extendedProps.jobId)));
          }}
          noEventsContent="No appointments in this period. Book one from a job card."
        />
      </div>
    </div>
  );
}
