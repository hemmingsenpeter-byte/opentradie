import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  approveProposal,
  listProposals,
  newIdempotencyKey,
  rejectProposal,
} from '../api';
import { QuoteRow } from '../components/rows';
import {
  Button,
  Dialog,
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  Pill,
  Section,
  TextArea,
  TextField,
  ViewOnlyNote,
} from '../components/ui';
import { formatDate } from '../format';
import { href } from '../router';
import type { ActionProposal } from '../types';
import { useWorkspace } from '../workspace';

/** Payload fields an owner may correct before approving. Everything else is fixed. */
const EDITABLE = ['title', 'name', 'subject', 'description', 'text'] as const;
const SOURCE_LABEL: Record<ActionProposal['source'], string> = {
  agent: 'From the assistant',
  voice: 'From a voice note',
  email: 'From an email',
  user: 'Entered by you',
};
const FIELD_LABEL: Record<string, string> = {
  text: 'Text',
  title: 'Title',
  name: 'Name',
  subject: 'Subject',
  description: 'Description',
  status: 'New status',
  rateCode: 'Rate code',
  quantityMilli: 'Quantity',
  reportedUnitCostCents: 'Reported supplier cost per unit',
  channel: 'Channel',
  dueAt: 'Due',
  supplier: 'Supplier',
  unit: 'Unit',
};

/** "25" or "12.5" percent → basis points, without floating point. Null when invalid. */
export function percentToBasisPoints(value: string): number | null {
  const match = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return basisPoints <= 100_000 ? basisPoints : null;
}

function display(key: string, value: unknown, money: (cents: number) => string): string {
  if (key === 'quantityMilli' && typeof value === 'number') {
    const whole = Math.trunc(value / 1000);
    const fraction = String(value % 1000)
      .padStart(3, '0')
      .replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : String(whole);
  }
  if (key === 'reportedUnitCostCents' && typeof value === 'number')
    return `${money(value)} (reported, not a price)`;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `${value.length} item(s)`;
  return JSON.stringify(value);
}

export function ApprovalsScreen() {
  const { state } = useWorkspace();
  const [proposals, setProposals] = useState<ActionProposal[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setProposals((await listProposals()).proposals);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const draftQuotes = state.quotes.filter((quote) => quote.status === 'draft');
  const open = proposals?.filter((p) => p.status === 'pending' || p.status === 'failed') ?? [];
  const decided = proposals?.filter((p) => p.status !== 'pending' && p.status !== 'failed') ?? [];

  return (
    <div className="stack">
      <PageHeader
        title="Approval inbox"
        eyebrow="Nothing happens until you approve it"
        back={{ href: href('home'), label: 'Home' }}
      />
      <Section title="Quotes awaiting approval" count={draftQuotes.length}>
        {draftQuotes.length ? (
          <ul className="rows">
            {draftQuotes.map((quote) => (
              <QuoteRow key={quote.id} quote={quote} />
            ))}
          </ul>
        ) : (
          <Empty icon="check" title="No draft quotes" />
        )}
      </Section>
      <Section title="Proposed actions" count={open.length}>
        {error !== null ? (
          <ErrorNotice title="Proposals didn’t load" error={error} retry={() => void load()} />
        ) : proposals === null ? (
          <Loading label="Loading proposals…" />
        ) : open.length ? (
          <ul className="stack" aria-label="Proposed actions">
            {open.map((proposal) => (
              <ProposalCard key={proposal.id} proposal={proposal} onChanged={load} />
            ))}
          </ul>
        ) : (
          <Empty icon="assistant" title="No proposed actions">
            When the assistant suggests a note, time, materials or a status change, it waits here
            for you.
          </Empty>
        )}
      </Section>
      {decided.length > 0 && (
        <Section title="Recently decided" count={decided.length}>
          <ul className="rows">
            {decided.slice(0, 20).map((proposal) => (
              <li key={proposal.id} className="enquiry">
                <p className="row-sub">
                  <Pill tone={proposal.status === 'executed' ? 'approved' : 'rejected'}>
                    {proposal.status === 'executed' ? 'Done' : proposal.status}
                  </Pill>{' '}
                  {proposal.toolTitle}
                  {proposal.decidedAt &&
                    ` · ${formatDate(proposal.decidedAt, state.business.timeZone)}`}
                </p>
                <p className="enquiry-text">{proposal.summary}</p>
                {proposal.decisionReason && (
                  <p className="muted">Reason: {proposal.decisionReason}</p>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function ProposalCard({
  proposal,
  onChanged,
}: {
  proposal: ActionProposal;
  onChanged: () => Promise<void>;
}) {
  const { isOwner, money, reload, state } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>(proposal.payload);
  const [markup, setMarkup] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // One key per card render: a double tap or retry of the same approval is safe.
  const [key, setKey] = useState(newIdempotencyKey);
  const needsMarkup =
    proposal.tool === 'job.add_material' && proposal.payload.reportedUnitCostCents !== undefined;
  const markupBasisPoints = needsMarkup ? percentToBasisPoints(markup) : null;
  const editable = EDITABLE.filter((field) => typeof proposal.payload[field] === 'string');
  const titleId = `proposal-${proposal.id}`;

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await approveProposal(
        proposal.id,
        {
          ...(editing ? { payload: draft } : {}),
          ...(markupBasisPoints !== null ? { markupBasisPoints } : {}),
        },
        key,
      );
      await Promise.all([onChanged(), reload().catch(() => undefined)]);
    } catch (err) {
      setError(err);
      setKey(newIdempotencyKey());
      if (err instanceof ApiError && err.code === 'PROPOSAL_FAILED') await onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="card card-pad" aria-labelledby={titleId}>
      <p className="row-sub">
        <Pill tone="info">{SOURCE_LABEL[proposal.source]}</Pill>{' '}
        {proposal.financial && <Pill tone="draft">Money</Pill>}{' '}
        {proposal.customerFacing && <Pill tone="draft">Customer-facing</Pill>}{' '}
        <time dateTime={proposal.createdAt}>
          {formatDate(proposal.createdAt, state.business.timeZone)}
        </time>
      </p>
      <h3 id={titleId} className="sub-title">
        {proposal.toolTitle}
      </h3>
      <p>{proposal.summary}</p>
      {proposal.jobId && (
        <a className="text-link" href={href('jobs', proposal.jobId)}>
          View job
        </a>
      )}

      {proposal.clarifications.length > 0 && (
        <Notice tone="warning" title="Check before approving">
          <ul>
            {proposal.clarifications.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </Notice>
      )}
      {proposal.failure && (
        <Notice tone="error" title="Last approval was refused">
          {proposal.failure.reason ?? proposal.failure.code}
        </Notice>
      )}
      {!proposal.executable && proposal.notExecutableReason && (
        <Notice tone="info" title="Not available yet">
          {proposal.notExecutableReason}
        </Notice>
      )}

      {editing ? (
        <div className="stack">
          {editable.map((field) => (
            <TextArea
              key={field}
              label={FIELD_LABEL[field] ?? field}
              rows={field === 'text' ? 4 : 2}
              value={String(draft[field] ?? '')}
              onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
            />
          ))}
        </div>
      ) : (
        <dl className="details">
          {Object.entries(proposal.payload)
            .filter(([field]) => !field.endsWith('Id') && field !== 'lines')
            .map(([field, value]) => (
              <div key={field}>
                <dt>{FIELD_LABEL[field] ?? field}</dt>
                {/* Untrusted text: rendered as text, never as markup or links. */}
                <dd className="enquiry-text">{display(field, value, money)}</dd>
              </div>
            ))}
        </dl>
      )}

      {needsMarkup && (
        <TextField
          label="Markup %"
          inputMode="decimal"
          value={markup}
          onChange={(event) => setMarkup(event.target.value)}
          hint="Required. The sell price is the confirmed cost plus this markup, calculated by the server."
        />
      )}

      {error !== null && (
        <ErrorNotice
          title={
            error instanceof ApiError && error.status === 403
              ? 'Not allowed'
              : 'The action was not approved'
          }
          error={error}
        />
      )}
      <div className="approval-buttons">
        <Button
          variant="go"
          icon="check"
          busy={busy}
          disabled={
            !isOwner || busy || !proposal.executable || (needsMarkup && markupBasisPoints === null)
          }
          onClick={() => void approve()}
        >
          {editing ? 'Approve with edits' : 'Approve'}
        </Button>
        {editable.length > 0 && (
          <Button
            icon="edit"
            disabled={!isOwner || busy}
            onClick={() => {
              setEditing(!editing);
              setDraft(proposal.payload);
            }}
          >
            {editing ? 'Cancel edit' : 'Edit'}
          </Button>
        )}
        <Button
          variant="stop"
          icon="close"
          disabled={!isOwner || busy}
          onClick={() => setRejecting(true)}
        >
          Reject
        </Button>
      </div>
      {!isOwner && (
        <ViewOnlyNote>View-only access: only the business owner can decide proposals.</ViewOnlyNote>
      )}
      {rejecting && (
        <RejectDialog
          proposal={proposal}
          onClose={() => setRejecting(false)}
          onDone={async () => {
            setRejecting(false);
            await onChanged();
          }}
        />
      )}
    </li>
  );
}

function RejectDialog({
  proposal,
  onClose,
  onDone,
}: {
  proposal: ActionProposal;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [key] = useState(newIdempotencyKey);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog title="Reject this proposal?" onClose={onClose}>
      <p>{proposal.summary}</p>
      <TextArea
        label="Reason"
        rows={3}
        maxLength={500}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        hint="Kept with the audit record."
      />
      {error !== null && <ErrorNotice title="The rejection was not saved" error={error} />}
      <div className="dialog-actions">
        <Button
          variant="stop"
          icon="close"
          busy={busy}
          disabled={busy || reason.trim().length === 0}
          onClick={() => {
            setBusy(true);
            setError(null);
            rejectProposal(proposal.id, reason.trim(), key)
              .then(onDone)
              .catch((err: unknown) => {
                setError(err);
                setBusy(false);
              });
          }}
        >
          Yes, reject
        </Button>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}
