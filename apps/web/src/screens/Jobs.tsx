import { useCallback, useEffect, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import {
  addJobNote,
  createJob,
  documentUrl,
  getJobDetail,
  newIdempotencyKey,
  updateJob,
  uploadEvidence,
} from '../api';
import { Icon } from '../components/Icons';
import { JobRow, QuoteRow } from '../components/rows';
import {
  Button,
  Empty,
  ErrorNotice,
  LinkButton,
  Loading,
  PageHeader,
  Pill,
  Section,
  SelectField,
  TextArea,
  TextField,
  ViewOnlyNote,
} from '../components/ui';
import { formatBytes, formatDate, JOB_STATUS_LABEL, jobStatusLabel } from '../format';
import { href, navigate } from '../router';
import { JOB_STATUSES } from '../types';
import type { Job, JobDetail, JobStatus } from '../types';
import { useWorkspace } from '../workspace';

export function JobsScreen({ segments, query }: { segments: string[]; query: URLSearchParams }) {
  const { state } = useWorkspace();
  const [first] = segments;
  if (first === 'new')
    return (
      <NewJob customerId={query.get('customer') ?? ''} propertyId={query.get('property') ?? ''} />
    );
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
    return <JobDetailScreen key={job.id} job={job} />;
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
        ? job.status !== 'completed' && job.status !== 'cancelled'
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

const EVIDENCE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];
const EVIDENCE_MAX_BYTES = 6 * 1024 * 1024;

function guessMediaType(file: File): string {
  if (file.type) return file.type === 'image/jpg' ? 'image/jpeg' : file.type;
  const extension = file.name.split('.').pop()?.toLowerCase();
  const byExtension: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    heic: 'image/heic',
    pdf: 'application/pdf',
  };
  return (extension && byExtension[extension]) || '';
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}

function JobDetailScreen({ job }: { job: Job }) {
  const { state, reload, customerName } = useWorkspace();
  const quotes = state.quotes.filter((quote) => quote.jobId === job.id);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    try {
      setDetail(await getJobDetail(job.id));
      setLoadError(null);
    } catch (error) {
      setLoadError(error);
    }
  }, [job.id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const changed = useCallback(async () => {
    await Promise.all([reload(), refresh()]);
  }, [reload, refresh]);

  const status = detail?.job.status ?? job.status;
  return (
    <div className="stack">
      <PageHeader title={job.title} eyebrow="Job" back={{ href: href('jobs'), label: 'Jobs' }}>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Pill
            tone={
              status === 'completed' ? 'approved' : status === 'cancelled' ? 'rejected' : 'neutral'
            }
          >
            <span data-testid="job-status">{jobStatusLabel(status)}</span>
          </Pill>
          <a className="text-link" href={href('customers', job.customerId)}>
            {customerName(job.customerId)}
          </a>
        </div>
      </PageHeader>

      {loadError !== null && (
        <ErrorNotice title="Job card didn’t load" error={loadError} retry={() => void refresh()} />
      )}

      <Section title="Job site">
        {detail?.property ? (
          <div className="grid gap-2">
            <p className="row-title">{detail.property.label ?? 'Property'}</p>
            <p className="note-text">{detail.property.address}</p>
            {detail.property.accessNotes && (
              <p className="row-sub">Access: {detail.property.accessNotes}</p>
            )}
          </div>
        ) : job.siteAddress ? (
          <p className="note-text">{job.siteAddress}</p>
        ) : (
          <p className="muted">No job site recorded.</p>
        )}
      </Section>

      {detail ? (
        <StatusControl detail={detail} onChanged={changed} />
      ) : (
        loadError === null && <Loading label="Loading job card…" />
      )}

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

      {detail && (
        <>
          <NotesSection detail={detail} onChanged={changed} />
          <EvidenceSection detail={detail} onChanged={changed} />
          <TimelineSection detail={detail} />
        </>
      )}
    </div>
  );
}

function StatusControl({
  detail,
  onChanged,
}: {
  detail: JobDetail;
  onChanged: () => Promise<void>;
}) {
  const { isOwner } = useWorkspace();
  const [busy, setBusy] = useState<JobStatus | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function move(status: JobStatus, reopen: boolean) {
    setBusy(status);
    setError(null);
    try {
      await updateJob(detail.job.id, reopen ? { status, reopen: true } : { status });
      await onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section title="Status">
      <div className="grid gap-3">
        <p>
          Currently <strong>{jobStatusLabel(detail.job.status)}</strong>
        </p>
        {error !== null && <ErrorNotice title="Status not changed" error={error} />}
        {!isOwner ? (
          <ViewOnlyNote />
        ) : detail.nextStatuses.length ? (
          <div className="form-actions" role="group" aria-label="Change status">
            {detail.nextStatuses.map((next) => (
              <Button
                key={next.status}
                variant={
                  next.status === 'cancelled'
                    ? 'stop'
                    : next.status === 'completed'
                      ? 'go'
                      : 'secondary'
                }
                busy={busy === next.status}
                disabled={busy !== null}
                onClick={() => void move(next.status, next.reopen)}
              >
                {next.reopen
                  ? `Reopen as ${jobStatusLabel(next.status).toLowerCase()}`
                  : jobStatusLabel(next.status)}
              </Button>
            ))}
          </div>
        ) : (
          <p className="muted">No further status changes.</p>
        )}
      </div>
    </Section>
  );
}

function NotesSection({
  detail,
  onChanged,
}: {
  detail: JobDetail;
  onChanged: () => Promise<void>;
}) {
  const { isOwner, state } = useWorkspace();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addJobNote(detail.job.id, text.trim());
      setText('');
      await onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Notes" count={detail.notes.length}>
      <div className="grid gap-4">
        {isOwner && (
          <form className="form" onSubmit={(event) => void save(event)}>
            {error !== null && <ErrorNotice title="Note not saved" error={error} />}
            <TextArea
              label="Add a note"
              rows={3}
              maxLength={5000}
              value={text}
              onChange={(event) => setText(event.target.value)}
              hint="What you found, what you did, anything to remember."
            />
            <div className="form-actions">
              <Button
                type="submit"
                variant="primary"
                icon="check"
                busy={busy}
                disabled={busy || !text.trim()}
              >
                Save note
              </Button>
            </div>
          </form>
        )}
        {detail.notes.length ? (
          <ul className="notes">
            {detail.notes.map((note) => (
              <li key={note.id}>
                <p className="row-sub">
                  <time dateTime={note.createdAt}>
                    {formatDate(note.createdAt, state.business.timeZone)}
                  </time>
                  {note.provenance === 'inferred' && ' · assistant suggestion, unverified'}
                </p>
                <p className="note-text">{note.text}</p>
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon="file" title="No notes yet" />
        )}
        {!isOwner && <ViewOnlyNote />}
      </div>
    </Section>
  );
}

function EvidenceSection({
  detail,
  onChanged,
}: {
  detail: JobDetail;
  onChanged: () => Promise<void>;
}) {
  const { isOwner } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const evidence = detail.documents.filter((document) => document.kind !== 'approved_quote');

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setError(null);
    const mediaType = guessMediaType(file);
    if (!EVIDENCE_TYPES.includes(mediaType)) {
      setError(new Error('Choose a JPEG, PNG, WebP or HEIC photo, or a PDF.'));
      input.value = '';
      return;
    }
    if (file.size > EVIDENCE_MAX_BYTES) {
      setError(new Error(`That file is ${formatBytes(file.size)}. Files can be up to 6 MB.`));
      input.value = '';
      return;
    }
    setBusy(true);
    try {
      const dataBase64 = await readBase64(file);
      await uploadEvidence(
        detail.job.id,
        { fileName: file.name, mediaType, dataBase64 },
        newIdempotencyKey(),
      );
      await onChanged();
    } catch (err) {
      setError(err);
    } finally {
      input.value = '';
      setBusy(false);
    }
  }

  return (
    <Section title="Photos and files" count={evidence.length}>
      <div className="grid gap-4">
        {error !== null && <ErrorNotice title="File not added" error={error} />}
        {isOwner && (
          <label className={`btn btn-secondary upload ${busy ? 'is-busy' : ''}`}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="plus" />}
            <span>{busy ? 'Uploading…' : 'Add photo or file'}</span>
            <input
              type="file"
              className="sr-only"
              accept="image/*,application/pdf"
              capture="environment"
              disabled={busy}
              onChange={(event) => void upload(event)}
              data-testid="evidence-input"
            />
          </label>
        )}
        {evidence.length ? (
          <ul className="evidence" aria-label="Photos and files">
            {evidence.map((document) => (
              <li key={document.id}>
                <a href={documentUrl(document.id)} className="evidence-item">
                  {document.mediaType.startsWith('image/') &&
                  document.mediaType !== 'image/heic' ? (
                    <img src={documentUrl(document.id)} alt={document.fileName} loading="lazy" />
                  ) : (
                    <span className="evidence-icon" aria-hidden="true">
                      <Icon name="file" size={32} />
                    </span>
                  )}
                  <span className="row-sub">
                    {document.fileName} · {formatBytes(document.sizeBytes)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon="file" title="No photos or files yet">
            {isOwner ? 'Take a photo of the work or attach a certificate.' : undefined}
          </Empty>
        )}
      </div>
    </Section>
  );
}

function TimelineSection({ detail }: { detail: JobDetail }) {
  const { state } = useWorkspace();
  return (
    <Section title="History" count={detail.timeline.length}>
      <ol className="timeline" aria-label="Job history">
        {detail.timeline.map((event) => (
          <li key={event.id} className={`timeline-item timeline-${event.type}`}>
            <p className="row-sub">
              <time dateTime={event.createdAt}>
                {formatDate(event.createdAt, state.business.timeZone)}
              </time>
              {' · '}
              {event.actorType === 'agent'
                ? 'Assistant'
                : event.actorType === 'system'
                  ? 'System'
                  : (event.actorName ?? 'User')}
            </p>
            <p className="timeline-summary">
              {event.summary}
              {event.type === 'status_changed' && event.fromStatus && event.toStatus && (
                <>
                  : {jobStatusLabel(event.fromStatus)} → {jobStatusLabel(event.toStatus)}
                </>
              )}
            </p>
            {event.noteText && <p className="note-text">{event.noteText}</p>}
          </li>
        ))}
      </ol>
    </Section>
  );
}

function NewJob({ customerId, propertyId }: { customerId: string; propertyId: string }) {
  const { state, isOwner, reload } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const known = state.customers.some((customer) => customer.id === customerId);
  const [selected, setSelected] = useState(known ? customerId : '');
  const properties = (state.properties ?? []).filter(
    (property) => property.customerId === selected,
  );
  const initialProperty = properties.some((property) => property.id === propertyId)
    ? propertyId
    : properties.length === 1
      ? properties[0]!.id
      : '';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const notes = String(form.get('notes') ?? '').trim();
    const property = String(form.get('propertyId') ?? '');
    setBusy(true);
    setError(null);
    try {
      const job = await createJob({
        customerId: String(form.get('customerId') ?? ''),
        title: String(form.get('title') ?? '').trim(),
        ...(property ? { propertyId: property } : {}),
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
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
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
          {selected && (
            <SelectField
              key={selected}
              label="Job site"
              name="propertyId"
              defaultValue={initialProperty}
              hint={
                properties.length
                  ? undefined
                  : 'No properties on file. Add one on the customer’s page to record the site.'
              }
            >
              <option value="">No site recorded</option>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.label ? `${property.label} · ` : ''}
                  {property.address}
                </option>
              ))}
            </SelectField>
          )}
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
