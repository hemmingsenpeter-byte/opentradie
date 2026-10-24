import { useCallback, useEffect, useId, useState } from 'react';
import { ApiError } from '../api';
import { href } from '../router';
import { Button } from '../components/ui';
import { useWorkspace } from '../workspace';
import {
  createTask,
  getToday,
  runTaskScan,
  snoozeTask,
  taskAction,
  type Task,
  type Today,
} from '../tasks-api';

/** Local calendar date (YYYY-MM-DD) of an instant in a time zone. */
function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** The instant of 9:00 am on a local date in the business time zone (DST-aware). */
export function nineAm(date: string, timeZone: string): string {
  const [y, m, d] = date.split('-').map(Number);
  let guess = Date.UTC(y!, m! - 1, d!, 9);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(guess));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    guess += Date.UTC(y!, m! - 1, d!, 9) - shown;
  }
  return new Date(guess).toISOString();
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

const KIND_LABEL: Record<Task['kind'], string> = {
  book_job: 'Book job',
  call: 'Call',
  follow_up_quote: 'Follow up quote',
  reply_message: 'Reply',
  invoice_job: 'Invoice',
  chase_payment: 'Chase payment',
  custom: 'To-do',
};

function when(task: Task, timeZone: string): string | null {
  const at = task.status === 'snoozed' ? task.snoozedUntil : task.dueAt;
  if (!at) return null;
  return new Intl.DateTimeFormat('en-NZ', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(at));
}

function TaskCard({
  task,
  timeZone,
  canEdit,
  onChanged,
}: {
  task: Task;
  timeZone: string;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const dateId = useId();
  const today = localDate(new Date(), timeZone);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };
  const snooze = (date: string) => run(() => snoozeTask(task.id, nineAm(date, timeZone)));
  const due = when(task, timeZone);
  return (
    <li className="task-card" data-testid="task-card" data-kind={task.kind}>
      <div className="task-head">
        <span className={`task-kind task-${task.priority}`}>{KIND_LABEL[task.kind]}</span>
        {due && (
          <span className="task-due">
            {task.status === 'snoozed' ? `Snoozed until ${due}` : due}
          </span>
        )}
      </div>
      <p className="task-title">{task.title}</p>
      {(task.customerName || task.jobTitle) && (
        <p className="task-meta">
          {[task.customerName, task.jobTitle].filter(Boolean).join(' · ')}
        </p>
      )}
      <div className="task-actions">
        {task.customerPhone &&
          (task.kind === 'call' ||
            task.kind === 'chase_payment' ||
            task.kind === 'follow_up_quote') && (
            <a
              className="btn btn-secondary"
              href={`tel:${task.customerPhone.replace(/[^\d+]/g, '')}`}
            >
              Call
            </a>
          )}
        {task.kind === 'book_job' && task.jobId && (
          <a className="btn btn-primary" href={`${href('jobs', task.jobId)}?schedule=1`}>
            Schedule
          </a>
        )}
        {task.threadId && (
          <a className="btn btn-secondary" href={href('inbox', task.threadId)}>
            {task.kind === 'reply_message' ? 'Draft reply' : 'Open thread'}
          </a>
        )}
        {task.invoiceId && (
          <a className="btn btn-secondary" href={href('invoices', task.invoiceId)}>
            Open invoice
          </a>
        )}
        {task.quoteId && task.kind === 'follow_up_quote' && (
          <a className="btn btn-secondary" href={href('quotes', task.quoteId)}>
            Open quote
          </a>
        )}
        {task.jobId && task.kind !== 'book_job' && (
          <a className="btn btn-secondary" href={href('jobs', task.jobId)}>
            Open job
          </a>
        )}
        {canEdit && (
          <>
            {task.status === 'snoozed' ? (
              <Button disabled={busy} onClick={() => void run(() => taskAction(task.id, 'reopen'))}>
                Wake now
              </Button>
            ) : (
              <Button
                variant="primary"
                icon="check"
                disabled={busy}
                aria-label={`Complete: ${task.title}`}
                onClick={() => void run(() => taskAction(task.id, 'complete'))}
              >
                Done
              </Button>
            )}
            <details className="task-more">
              <summary className="btn btn-secondary">Snooze</summary>
              <div className="task-snooze">
                <Button disabled={busy} onClick={() => void snooze(addDays(today, 1))}>
                  Tomorrow
                </Button>
                <Button disabled={busy} onClick={() => void snooze(addDays(today, 7))}>
                  Next week
                </Button>
                {picking ? (
                  <label htmlFor={dateId} className="task-pick">
                    <span>Snooze until</span>
                    <input
                      id={dateId}
                      type="date"
                      min={addDays(today, 1)}
                      onChange={(event) => event.target.value && void snooze(event.target.value)}
                    />
                  </label>
                ) : (
                  <Button disabled={busy} onClick={() => setPicking(true)}>
                    Pick date
                  </Button>
                )}
              </div>
            </details>
            <Button
              disabled={busy}
              aria-label={`Dismiss: ${task.title}`}
              onClick={() => void run(() => taskAction(task.id, 'dismiss'))}
            >
              Dismiss
            </Button>
          </>
        )}
      </div>
      {error && (
        <p className="task-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function Group({
  title,
  tasks,
  timeZone,
  canEdit,
  onChanged,
  collapsed = false,
}: {
  title: string;
  tasks: Task[];
  timeZone: string;
  canEdit: boolean;
  onChanged: () => void;
  collapsed?: boolean;
}) {
  const id = useId();
  if (!tasks.length) return null;
  const list = (
    <ul className="task-list" aria-labelledby={id}>
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          timeZone={timeZone}
          canEdit={canEdit}
          onChanged={onChanged}
        />
      ))}
    </ul>
  );
  if (collapsed)
    return (
      <details className="task-group">
        <summary>
          <h3 id={id} className="task-group-title">
            {title} <span className="count">{tasks.length}</span>
          </h3>
        </summary>
        {list}
      </details>
    );
  return (
    <div className="task-group">
      <h3 id={id} className="task-group-title">
        {title} <span className="count">{tasks.length}</span>
      </h3>
      {list}
    </div>
  );
}

/** The Today panel: the owner's single to-do list, at the top of Home. */
export function TodayPanel() {
  const { isOwner, state } = useWorkspace();
  const [today, setToday] = useState<Today | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [title, setTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [scanning, setScanning] = useState(false);
  const inputId = useId();
  const load = useCallback(async () => {
    try {
      setToday(await getToday());
      setUnavailable(false);
    } catch (failure) {
      if (failure instanceof ApiError || failure instanceof Error) setUnavailable(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (unavailable && !today) return null;
  const timeZone = today?.timeZone ?? state.business.timeZone;
  const add = async () => {
    if (!title.trim()) return;
    setAdding(true);
    try {
      await createTask({ title: title.trim(), kind: 'custom', dueAt: null });
      setTitle('');
      await load();
    } finally {
      setAdding(false);
    }
  };
  const time = (iso: string) =>
    new Intl.DateTimeFormat('en-NZ', { timeZone, hour: 'numeric', minute: '2-digit' }).format(
      new Date(iso),
    );
  const due = today ? today.counts.overdue + today.counts.today : 0;
  return (
    <section className="card card-hivis today" aria-labelledby="today-title">
      <div className="section-head">
        <h2 id="today-title" className="section-title">
          Today
          {today && (
            <span className="count" aria-label={`${due} due`}>
              {due}
            </span>
          )}
        </h2>
        {isOwner && (
          <Button
            busy={scanning}
            icon="refresh"
            onClick={async () => {
              setScanning(true);
              try {
                await runTaskScan();
                await load();
              } finally {
                setScanning(false);
              }
            }}
          >
            Check now
          </Button>
        )}
      </div>
      {today && today.appointments.length > 0 && (
        <ul className="today-strip" aria-label="Today’s appointments">
          {today.appointments.map((appointment) => (
            <li key={appointment.id}>
              <a href={href('jobs', appointment.jobId)} className="today-appt">
                <strong>{time(appointment.startsAt)}</strong> {appointment.jobTitle}
                <span className="task-meta"> · {appointment.customerName}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {isOwner && (
        <form
          className="task-add field"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            New task
          </label>
          <input
            id={inputId}
            placeholder="Add a to-do…"
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Button
            type="submit"
            variant="primary"
            icon="plus"
            busy={adding}
            disabled={!title.trim()}
          >
            Add
          </Button>
        </form>
      )}
      {today ? (
        today.overdue.length + today.today.length + today.upcoming.length + today.snoozed.length ? (
          <>
            <Group
              title="Overdue"
              tasks={today.overdue}
              timeZone={timeZone}
              canEdit={isOwner}
              onChanged={load}
            />
            <Group
              title="Today"
              tasks={today.today}
              timeZone={timeZone}
              canEdit={isOwner}
              onChanged={load}
            />
            <Group
              title="Upcoming"
              tasks={today.upcoming}
              timeZone={timeZone}
              canEdit={isOwner}
              onChanged={load}
            />
            <Group
              title="Snoozed"
              tasks={today.snoozed}
              timeZone={timeZone}
              canEdit={isOwner}
              onChanged={load}
              collapsed
            />
          </>
        ) : (
          <p className="muted">Nothing on your list. Nice.</p>
        )
      ) : (
        <p className="muted">Loading your list…</p>
      )}
    </section>
  );
}
