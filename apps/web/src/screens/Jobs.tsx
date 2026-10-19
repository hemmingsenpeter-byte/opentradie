import { useState } from 'react';
import type { FormEvent } from 'react';
import { createJob, updateJob } from '../api';
import { JobRow, QuoteRow } from '../components/rows';
import {
  Button,
  Empty,
  ErrorNotice,
  LinkButton,
  Notice,
  PageHeader,
  Pill,
  Section,
  SelectField,
  TextArea,
  TextField,
  ViewOnlyNote,
} from '../components/ui';
import { JOB_STATUS_LABEL, jobStatusLabel } from '../format';
import { href, navigate } from '../router';
import { JOB_STATUSES } from '../types';
import type { Job, JobStatus } from '../types';
import { useWorkspace } from '../workspace';

export function JobsScreen({ segments, query }: { segments: string[]; query: URLSearchParams }) {
  const { state } = useWorkspace();
  const [first] = segments;
  if (first === 'new') return <NewJob customerId={query.get('customer') ?? ''} />;
  if (first) {
    const job = state.jobs.find((entry) => entry.id === first);
    if (!job) {
      return (
        <div className="stack">
          <PageHeader title="Job not found" back={{ href: href('jobs'), label: 'Jobs' }} />
          <Empty icon="jobs" title="This job isn’t in your workspace" />
        </div>
      );
    }
    return <JobDetail key={job.id} job={job} />;
  }
  return <JobList />;
}

type Filter = 'open' | 'all' | JobStatus;

function JobList() {
  const { state, isOwner } = useWorkspace();
  const [filter, setFilter] = useState<Filter>('open');
  const jobs = state.jobs.filter((job) =>
    filter === 'all'
      ? true
      : filter === 'open'
        ? job.status !== 'completed'
        : job.status === filter,
  );
  const filters: { id: Filter; label: string }[] = [
    { id: 'open', label: 'Open' },
    ...JOB_STATUSES.map((status) => ({ id: status as Filter, label: JOB_STATUS_LABEL[status] })),
    { id: 'all', label: 'All' },
  ];
  return (
    <div className="stack">
      <PageHeader
        title="Jobs"
        eyebrow={`${state.jobs.length} total`}
        actions={
          isOwner ? (
            <LinkButton href={href('jobs', 'new')} variant="primary" icon="plus">
              New job
            </LinkButton>
          ) : undefined
        }
      />
      <div className="filters" role="group" aria-label="Filter jobs by status">
        {filters.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="chip"
            aria-pressed={filter === entry.id}
            onClick={() => setFilter(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {jobs.length ? (
        <ul className="rows card">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </ul>
      ) : (
        <Empty
          icon="jobs"
          title="No jobs here"
          action={
            isOwner ? (
              <LinkButton href={href('jobs', 'new')} icon="plus">
                New job
              </LinkButton>
            ) : undefined
          }
        >
          Try another filter, or ask the assistant to set one up from an enquiry.
        </Empty>
      )}
      {!isOwner && <ViewOnlyNote />}
    </div>
  );
}

function JobDetail({ job }: { job: Job }) {
  const { state, isOwner, reload, customerName } = useWorkspace();
  const quotes = state.quotes.filter((quote) => quote.jobId === job.id);
  const [status, setStatus] = useState<JobStatus>(job.status);
  const [notes, setNotes] = useState(job.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const dirty = status !== job.status || notes.trim() !== (job.notes ?? '').trim();

  async function save(event: FormEvent) {
    event.preventDefault();
    const input: { status?: JobStatus; notes?: string } = {};
    if (status !== job.status) input.status = status;
    if (notes.trim() !== (job.notes ?? '').trim() && notes.trim()) input.notes = notes.trim();
    if (!input.status && input.notes === undefined) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await updateJob(job.id, input);
      await reload();
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const clearingNotes = notes.trim() === '' && Boolean(job.notes);
  return (
    <div className="stack">
      <PageHeader title={job.title} eyebrow="Job" back={{ href: href('jobs'), label: 'Jobs' }}>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Pill tone={job.status === 'completed' ? 'approved' : 'neutral'}>
            {jobStatusLabel(job.status)}
          </Pill>
          <a className="text-link" href={href('customers', job.customerId)}>
            {customerName(job.customerId)}
          </a>
        </div>
      </PageHeader>

      <Section title="Quotes" count={quotes.length}>
        {quotes.length ? (
          <ul className="rows">
            {quotes.map((quote) => (
              <QuoteRow key={quote.id} quote={quote} showCustomer={false} />
            ))}
          </ul>
        ) : (
          <Empty icon="quotes" title="No quotes for this job">
            Ask the assistant to prepare one from the enquiry.
          </Empty>
        )}
      </Section>

      <Section title="Status and notes">
        {isOwner ? (
          <form className="form" onSubmit={(event) => void save(event)}>
            {error !== null && <ErrorNotice title="Job not updated" error={error} />}
            {saved && !dirty && <Notice tone="success">Job updated.</Notice>}
            <SelectField
              label="Status"
              value={status}
              onChange={(event) => setStatus(event.target.value as JobStatus)}
            >
              {JOB_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {JOB_STATUS_LABEL[value]}
                </option>
              ))}
            </SelectField>
            <TextArea
              label="Job notes"
              rows={5}
              maxLength={5000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              hint={
                clearingNotes
                  ? 'Notes can’t be cleared here; edit the text instead.'
                  : 'Access, scope and anything to remember. Saved notes are kept in the job history.'
              }
            />
            <div className="form-actions">
              <Button
                type="submit"
                variant="primary"
                icon="check"
                busy={busy}
                disabled={busy || !dirty || (clearingNotes && status === job.status)}
              >
                Save
              </Button>
            </div>
          </form>
        ) : (
          <div className="grid gap-3">
            <p className="note-text">
              {job.notes || <span className="muted">No notes recorded.</span>}
            </p>
            <ViewOnlyNote />
          </div>
        )}
      </Section>
    </div>
  );
}

function NewJob({ customerId }: { customerId: string }) {
  const { state, isOwner, reload } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const known = state.customers.some((customer) => customer.id === customerId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const notes = String(form.get('notes') ?? '').trim();
    setBusy(true);
    setError(null);
    try {
      const job = await createJob({
        customerId: String(form.get('customerId') ?? ''),
        title: String(form.get('title') ?? '').trim(),
        ...(notes ? { notes } : {}),
      });
      await reload();
      navigate(href('jobs', job.id));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHeader title="New job" back={{ href: href('jobs'), label: 'Jobs' }} />
      {!isOwner ? (
        <ViewOnlyNote />
      ) : state.customers.length === 0 ? (
        <Empty
          icon="customers"
          title="Add a customer first"
          action={
            <LinkButton href={href('customers', 'new')} variant="primary" icon="plus">
              Add customer
            </LinkButton>
          }
        >
          Every job belongs to a customer.
        </Empty>
      ) : (
        <form className="card card-pad form" onSubmit={(event) => void submit(event)}>
          {error !== null && <ErrorNotice title="Job not created" error={error} />}
          <SelectField
            label="Customer"
            name="customerId"
            required
            defaultValue={known ? customerId : ''}
          >
            <option value="" disabled>
              Select a customer…
            </option>
            {state.customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </SelectField>
          <TextField
            label="What’s the job?"
            name="title"
            required
            maxLength={300}
            placeholder="e.g. Replace two kitchen power points"
          />
          <TextArea
            label="Notes"
            name="notes"
            optional
            rows={4}
            maxLength={5000}
            placeholder="Access, scope, anything to remember"
          />
          <div className="form-actions">
            <Button type="submit" variant="primary" icon="check" busy={busy} disabled={busy}>
              Create job
            </Button>
            <LinkButton href={href('jobs')}>Cancel</LinkButton>
          </div>
        </form>
      )}
    </div>
  );
}
