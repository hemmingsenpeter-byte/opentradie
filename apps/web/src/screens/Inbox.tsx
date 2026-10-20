import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  approveAndSend,
  createJobFromThread,
  discardDraft,
  documentUrl,
  getInboxThread,
  linkThread,
  listInboxThreads,
  markThreadRead,
  newIdempotencyKey,
  pasteEmail,
} from '../api';
import type { InboxFilter } from '../api';
import { Icon } from '../components/Icons';
import {
  Button,
  Empty,
  ErrorNotice,
  LinkButton,
  Loading,
  MockBadge,
  Notice,
  PageHeader,
  Pill,
  Section,
  TextArea,
  TextField,
  ViewOnlyNote,
} from '../components/ui';
import { formatBytes, formatDate } from '../format';
import { href, navigate } from '../router';
import type { InboxMessage, InboxThreadDetail, InboxThreadSummary } from '../types';
import { useWorkspace } from '../workspace';

const REVIEW_TEXT: Record<string, string> = {
  customer_ambiguous: 'More than one customer could match this sender. Choose the right one.',
  customer_name_only:
    'Matched by name only, not by email address. Check it is the right customer before replying.',
  job_ambiguous: 'This customer has several open jobs. Choose the job this message is about.',
  customer_unknown: 'The sender is not a customer yet. Create a job from this if it is new work.',
  triage_failed: 'The assistant could not read this message. Reply yourself.',
};

const CLASSIFICATION: Record<string, string> = {
  new_enquiry: 'New enquiry',
  existing_job_update: 'Job update',
  quote_response: 'Quote response',
  scheduling: 'Scheduling',
  invoice_or_payment: 'Invoice or payment',
  complaint: 'Complaint',
  spam_or_automated: 'Automated',
  other: 'Other',
};

const WARNING_TEXT: Record<string, string> = {
  contains_price:
    'mentions a price. Prices must come from your approved rates; send a quote instead.',
  contains_bank_account: 'contains what looks like bank details. Check every digit is yours.',
  contains_link: 'contains a link. Make sure you meant to include it.',
  contains_email_address: 'contains an email address. Check it is correct.',
};

const SEND_ERROR_TEXT: Record<string, string> = {
  NO_MAIL_CONNECTION:
    'Not sent: no mailbox is connected to OPENTRADIE yet. Copy the reply into your email app, or connect a mailbox and approve again.',
  SEND_OUTCOME_UNKNOWN:
    'The send was interrupted and may or may not have gone out. Check your Sent folder before approving again.',
  PROVIDER_AUTH_EXPIRED:
    'Not sent: the mailbox sign-in has expired. Reconnect it and approve again.',
  PROVIDER_REAUTHORISATION_REQUIRED: 'Not sent: reconnect the mailbox, then approve again.',
  PROVIDER_RATE_LIMITED: 'Not sent: the mail provider is busy. Approve again in a few minutes.',
  PROVIDER_REJECTED: 'Not sent: the mail provider rejected the message.',
  PROVIDER_UNAVAILABLE: 'Not sent: the mail provider could not be reached. Approve again to retry.',
};

export function InboxScreen({ segments }: { segments: string[] }) {
  const [first] = segments;
  if (first === 'paste') return <PasteEmail />;
  if (first) return <ThreadView id={first} />;
  return <ThreadList />;
}

function ThreadList() {
  const { isOwner } = useWorkspace();
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [threads, setThreads] = useState<InboxThreadSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setThreads((await listInboxThreads(filter)).threads);
    } catch (failure) {
      setError(failure);
    }
  }, [filter]);
  useEffect(() => {
    void load();
  }, [load]);

  const filters: { value: InboxFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'needs_review', label: 'Needs review' },
    { value: 'unread', label: 'Unread' },
  ];
  return (
    <div className="stack">
      <PageHeader
        title="Inbox"
        eyebrow="Customer email"
        back={{ href: href('home'), label: 'Home' }}
        actions={
          isOwner ? (
            <LinkButton href={href('inbox', 'paste')} icon="plus" variant="primary">
              Paste an email
            </LinkButton>
          ) : undefined
        }
      />
      <div className="filters" role="group" aria-label="Filter conversations">
        {filters.map((item) => (
          <button
            key={item.value}
            type="button"
            className="chip"
            aria-pressed={filter === item.value}
            onClick={() => setFilter(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {error ? (
        <ErrorNotice title="The inbox didn’t load" error={error} retry={() => void load()} />
      ) : !threads ? (
        <Loading label="Loading conversations…" />
      ) : threads.length === 0 ? (
        <Empty icon="mail" title={filter === 'all' ? 'No email yet' : 'Nothing here'}>
          Emails sent to your connected inbox, or pasted here, appear as conversations.
        </Empty>
      ) : (
        <section className="card" aria-label="Conversations">
          <ul className="rows">
            {threads.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ThreadRow({ thread }: { thread: InboxThreadSummary }) {
  const { state } = useWorkspace();
  const sender =
    thread.customerName ?? thread.latestFromName ?? thread.latestFromAddress ?? 'Unknown sender';
  return (
    <li>
      <a className="row thread-row" href={href('inbox', thread.id)}>
        <span className="row-main">
          <span className={`row-title ${thread.unreadCount > 0 ? 'is-unread' : ''}`}>
            {thread.subject || '(no subject)'}
          </span>
          <span className="row-sub">
            {sender} ·{' '}
            <time dateTime={thread.lastMessageAt}>
              {formatDate(thread.lastMessageAt, state.business.timeZone)}
            </time>
          </span>
          {thread.snippet && <span className="thread-snippet">{thread.snippet}</span>}
          <span className="thread-chips">
            {thread.unreadCount > 0 && <Pill tone="info">{thread.unreadCount} new</Pill>}
            {thread.needsReview && <Pill tone="draft">Needs review</Pill>}
            {thread.pendingDrafts > 0 && <Pill tone="approved">Reply ready</Pill>}
            {thread.jobTitle && <Pill tone="neutral">Job: {thread.jobTitle}</Pill>}
          </span>
        </span>
        <Icon name="chevron" className="row-chevron" />
      </a>
    </li>
  );
}

function ThreadView({ id }: { id: string }) {
  const { isOwner, state, reload } = useWorkspace();
  const [detail, setDetail] = useState<InboxThreadDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const markedRead = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await getInboxThread(id);
      setDetail(next);
      if (
        isOwner &&
        !markedRead.current &&
        next.messages.some((m) => m.direction === 'inbound' && !m.readAt)
      ) {
        markedRead.current = true;
        void markThreadRead(id).catch(() => undefined);
      }
    } catch (failure) {
      setError(failure);
    }
  }, [id, isOwner]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      await Promise.all([load(), reload()]);
    } catch (failure) {
      setActionError(failure);
    } finally {
      setBusy(false);
    }
  };

  if (error)
    return (
      <div className="stack">
        <PageHeader title="Conversation" back={{ href: href('inbox'), label: 'Inbox' }} />
        <ErrorNotice
          title="This conversation didn’t load"
          error={error}
          retry={() => void load()}
        />
      </div>
    );
  if (!detail) return <Loading label="Opening conversation…" />;
  const { thread, messages } = detail;
  const latestInbound = [...messages].reverse().find((m) => m.direction === 'inbound');
  const match = latestInbound?.triage?.match;

  return (
    <div className="stack">
      <PageHeader
        title={thread.subject || '(no subject)'}
        eyebrow="Conversation"
        back={{ href: href('inbox'), label: 'Inbox' }}
      >
        <p className="thread-chips">
          {thread.customerId ? (
            <a className="pill pill-info" href={href('customers', thread.customerId)}>
              {thread.customerName}
            </a>
          ) : (
            <Pill tone="neutral">No customer linked</Pill>
          )}
          {thread.jobId ? (
            <a className="pill pill-neutral" href={href('jobs', thread.jobId)}>
              Job: {thread.jobTitle}
            </a>
          ) : (
            <Pill tone="neutral">No job linked</Pill>
          )}
        </p>
      </PageHeader>
      {!isOwner && <ViewOnlyNote />}
      {actionError ? <ErrorNotice title="That didn’t work" error={actionError} /> : null}

      {thread.needsReview && thread.reviewReason && (
        <Notice tone="warning" title="Check before replying">
          <p>{REVIEW_TEXT[thread.reviewReason] ?? 'This conversation needs your review.'}</p>
          {isOwner && match && (
            <div className="inbox-actions">
              {match.job.candidates.map((job) => (
                <Button
                  key={job.id}
                  busy={busy}
                  onClick={() =>
                    void act(() => linkThread(id, { jobId: job.id }, newIdempotencyKey()))
                  }
                >
                  Link to {job.title}
                </Button>
              ))}
              {match.customer.candidates.map((customer) => (
                <Button
                  key={customer.id}
                  busy={busy}
                  onClick={() =>
                    void act(() => linkThread(id, { customerId: customer.id }, newIdempotencyKey()))
                  }
                >
                  It’s {customer.name}
                </Button>
              ))}
            </div>
          )}
        </Notice>
      )}

      {isOwner && !thread.jobId && (
        <Button
          icon="jobs"
          busy={busy}
          onClick={() => void act(() => createJobFromThread(id, newIdempotencyKey()))}
        >
          Create job from this
        </Button>
      )}

      <ol className="messages" aria-label="Messages">
        {messages.map((message) => (
          <li key={message.id}>
            {message.direction === 'inbound' ? (
              <InboundMessage message={message} timeZone={state.business.timeZone} />
            ) : (
              <OutboundMessage message={message} busy={busy} act={act} />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function InboundMessage({ message, timeZone }: { message: InboxMessage; timeZone: string }) {
  const triage = message.triage;
  return (
    <article className="card message message-in">
      <header className="message-head">
        <strong>{message.fromName ?? message.fromAddress ?? 'Unknown sender'}</strong>
        {message.fromName && message.fromAddress && (
          <span className="row-sub"> {message.fromAddress}</span>
        )}
        <time className="row-sub" dateTime={message.createdAt}>
          {formatDate(message.receivedAt ?? message.createdAt, timeZone)}
        </time>
      </header>
      {message.triageStatus === 'completed' && triage?.summary && (
        <div className="ai-box" aria-label="Assistant summary">
          <p className="ai-box-head">
            <Icon name="assistant" size={18} /> Assistant summary
            {triage.classification && (
              <Pill tone="info">
                {CLASSIFICATION[triage.classification] ?? triage.classification}
              </Pill>
            )}
            {triage.synthetic && <MockBadge />}
          </p>
          <p className="note-text">{triage.summary}</p>
          {triage.suggestedActions && triage.suggestedActions.length > 0 && (
            <ul className="ai-suggestions">
              {triage.suggestedActions.map((action) => (
                <li key={action.type}>{action.note}</li>
              ))}
            </ul>
          )}
          <p className="hint">Suggestions only. Nothing happens unless you do it.</p>
        </div>
      )}
      {message.triageStatus === 'pending' && (
        <p className="hint">The assistant is preparing a summary and a reply…</p>
      )}
      {message.triageStatus === 'policy_denied' && (
        <Notice tone="info" title="No AI reply prepared">
          {triage?.outcome?.explanation ??
            'Your privacy setting does not allow this message to be sent to the configured model.'}
        </Notice>
      )}
      {(message.triageStatus === 'unavailable' || message.triageStatus === 'invalid_output') && (
        <Notice tone="info" title="No AI reply prepared">
          The assistant could not prepare a reply for this message. Write the reply yourself.
        </Notice>
      )}
      <p className="message-text">{message.text}</p>
      {message.attachments.length > 0 && (
        <ul className="attachments" aria-label="Attachments">
          {message.attachments.map((file) => (
            <li key={file.id}>
              <a className="text-link" href={documentUrl(file.id)}>
                <Icon name="file" size={18} /> {file.fileName}
              </a>{' '}
              <span className="row-sub">{formatBytes(file.sizeBytes)}</span>
            </li>
          ))}
        </ul>
      )}
      {triage?.attachments && triage.attachments.rejected.length > 0 && (
        <p className="hint">
          {triage.attachments.rejected.length} attachment(s) were not stored (only photos and PDFs
          are kept).
        </p>
      )}
    </article>
  );
}

function OutboundMessage({
  message,
  busy,
  act,
}: {
  message: InboxMessage;
  busy: boolean;
  act: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const { isOwner } = useWorkspace();
  const [text, setText] = useState(message.text);
  const key = useRef(newIdempotencyKey());
  useEffect(() => setText(message.text), [message.text]);
  const editable = message.status === 'draft' || message.status === 'failed';
  const warnings = message.triage?.draftWarnings ?? [];
  const to = message.toAddresses.join(', ') || 'the customer';

  if (!editable)
    return (
      <article className="card message message-out">
        <header className="message-head">
          <strong>Your reply</strong>
          <Pill tone={message.status === 'sent' ? 'approved' : 'draft'}>
            {message.status === 'sent'
              ? 'Sent'
              : message.status === 'approved'
                ? 'Approved, sending'
                : message.status === 'sending'
                  ? 'Sending'
                  : message.status}
          </Pill>
        </header>
        <p className="row-sub">To {to}</p>
        <p className="message-text">{message.text}</p>
      </article>
    );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await act(async () => {
      await approveAndSend(message.id, text, key.current);
      key.current = newIdempotencyKey();
    });
  };
  return (
    <form className="card message message-out" onSubmit={(event) => void submit(event)}>
      <header className="message-head">
        <strong>
          {message.origin === 'agent_draft'
            ? 'Draft reply (prepared by the assistant)'
            : 'Draft reply'}
        </strong>
        <Pill tone={message.status === 'failed' ? 'rejected' : 'draft'}>
          {message.status === 'failed' ? 'Not sent' : 'Awaiting your approval'}
        </Pill>
      </header>
      {message.status === 'failed' && message.sendErrorCode && (
        <Notice tone="error" title="Not sent">
          {SEND_ERROR_TEXT[message.sendErrorCode] ?? `Not sent (${message.sendErrorCode}).`}
        </Notice>
      )}
      {warnings.map((warning) => (
        <Notice key={warning} tone="warning">
          This draft {WARNING_TEXT[warning] ?? warning}
        </Notice>
      ))}
      <p className="row-sub">To {to}</p>
      <TextArea
        label="Reply"
        rows={8}
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={!isOwner || busy}
        hint="Check and edit the reply. It is sent only when you approve it."
      />
      {isOwner && (
        <div className="inbox-actions">
          <Button type="submit" variant="go" icon="send" busy={busy} disabled={!text.trim()}>
            Approve &amp; send
          </Button>
          <Button
            variant="quiet"
            busy={busy}
            onClick={() => void act(() => discardDraft(message.id))}
          >
            Discard
          </Button>
        </div>
      )}
    </form>
  );
}

function PasteEmail() {
  const { isOwner, reload } = useWorkspace();
  const [form, setForm] = useState({ from: '', fromName: '', subject: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const key = useRef(newIdempotencyKey());

  if (!isOwner)
    return (
      <div className="stack">
        <PageHeader title="Paste an email" back={{ href: href('inbox'), label: 'Inbox' }} />
        <ViewOnlyNote />
      </div>
    );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await pasteEmail(
        {
          from: form.from.trim(),
          ...(form.fromName.trim() ? { fromName: form.fromName.trim() } : {}),
          subject: form.subject.trim(),
          text: form.text,
        },
        key.current,
      );
      await reload();
      navigate(href('inbox', result.threadId));
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };
  const set = (name: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [name]: event.target.value }));
  return (
    <div className="stack">
      <PageHeader
        title="Paste an email"
        eyebrow="Inbox"
        back={{ href: href('inbox'), label: 'Inbox' }}
      />
      <Section title="The customer’s email">
        <form className="stack" onSubmit={(event) => void submit(event)}>
          <p className="hint">
            Copy an email from your mail app. It is handled exactly like one that arrives by email:
            matched to a customer and job, and given a draft reply for you to approve.
          </p>
          {error ? <ErrorNotice title="The email wasn’t added" error={error} /> : null}
          <TextField
            label="From (email address)"
            type="email"
            required
            value={form.from}
            onChange={set('from')}
            autoComplete="off"
          />
          <TextField
            label="Sender name"
            optional
            value={form.fromName}
            onChange={set('fromName')}
            autoComplete="off"
          />
          <TextField label="Subject" optional value={form.subject} onChange={set('subject')} />
          <TextArea label="Message" required rows={8} value={form.text} onChange={set('text')} />
          <Button type="submit" variant="primary" icon="mail" busy={busy} block>
            Add to inbox
          </Button>
        </form>
      </Section>
    </div>
  );
}
