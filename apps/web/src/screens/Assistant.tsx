import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../api';
import { Icon } from '../components/Icons';
import { QuoteApproval, QuoteChecks, QuoteLines, QuoteStatusPill } from '../components/quote';
import {
  Button,
  ErrorNotice,
  LinkButton,
  Loading,
  Notice,
  PageHeader,
  SelectField,
  ViewOnlyNote,
} from '../components/ui';
import { jobStatusLabel } from '../format';
import { href, navigate } from '../router';
import type { Clarification } from '../types';
import { useConversation, useWorkspace } from '../workspace';
import type { Turn } from '../workspace';

export const EXAMPLE_REQUEST =
  'Mrs Johnson needs two power points replaced. Check her existing information and prepare a quote.';

export function AssistantComposer({
  compact = false,
  goToAssistant = false,
}: {
  compact?: boolean;
  goToAssistant?: boolean;
}) {
  const { isOwner } = useWorkspace();
  const { ask, busy } = useConversation();
  const [text, setText] = useState('');
  const trimmed = text.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < 5;

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!isOwner || busy || trimmed.length < 5) return;
    setText('');
    if (goToAssistant) navigate(href('assistant'));
    void ask(trimmed);
  }

  return (
    <form className="composer" onSubmit={submit} aria-label="Ask the assistant">
      <label htmlFor={compact ? 'composer-home' : 'composer-main'} className="sr-only">
        Describe the work or what you need
      </label>
      <textarea
        id={compact ? 'composer-home' : 'composer-main'}
        rows={compact ? 3 : 4}
        maxLength={8000}
        value={text}
        disabled={!isOwner}
        placeholder="e.g. Mrs Johnson needs two power points replaced. Check her history and prepare a quote."
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
        }}
        aria-describedby={tooShort ? 'composer-short' : undefined}
      />
      {tooShort && (
        <p id="composer-short" className="hint">
          Add a little more detail (at least 5 characters).
        </p>
      )}
      {isOwner ? (
        <div className="composer-actions">
          <Button
            type="submit"
            variant="primary"
            icon="send"
            busy={busy}
            disabled={busy || trimmed.length < 5}
          >
            {busy ? 'Working…' : 'Send'}
          </Button>
          {!text && (
            <button type="button" className="chip" onClick={() => setText(EXAMPLE_REQUEST)}>
              <Icon name="bolt" size={18} />
              Use the Mrs Johnson example
            </button>
          )}
        </div>
      ) : (
        <ViewOnlyNote>
          View-only access: only the business owner can ask the assistant to prepare jobs and
          quotes.
        </ViewOnlyNote>
      )}
    </form>
  );
}

export function AssistantScreen() {
  const { turns, clear, busy } = useConversation();
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' });
  }, [turns]);

  return (
    <div className="stack">
      <PageHeader
        title="Assistant"
        eyebrow="Proposes. You decide."
        actions={
          turns.length > 0 && !busy ? (
            <Button icon="refresh" onClick={clear}>
              New chat
            </Button>
          ) : undefined
        }
      />

      {turns.length === 0 && (
        <Notice tone="info" title="How it works">
          Tell it about a job in plain words. It finds the customer and their history, proposes a
          job and drafts a quote using only your approved rates. Nothing is approved or sent without
          you.
        </Notice>
      )}

      <ol className="conversation" aria-live="polite" aria-label="Conversation">
        {turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} />
        ))}
      </ol>
      <div ref={endRef} />

      <section className="card" aria-label="New message">
        <AssistantComposer />
      </section>
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  const { retry } = useConversation();
  return (
    <li className="turn">
      <div className="bubble-user">
        <p className="bubble-label">You</p>
        <p>{turn.text}</p>
        {turn.customerLabel && (
          <p className="bubble-note">
            <Icon name="customers" size={16} /> Customer: {turn.customerLabel}
          </p>
        )}
      </div>
      <div className="bubble-assistant">
        <p className="bubble-label">
          <Icon name="assistant" size={16} /> Assistant
        </p>
        {turn.status === 'pending' && (
          <Loading label="Checking customers, history and approved rates…" />
        )}
        {turn.status === 'error' && (
          <ErrorNotice
            title={errorTitle(turn.error)}
            error={turn.error}
            retry={retryable(turn.error) ? () => void retry(turn.id) : undefined}
          />
        )}
        {turn.status === 'done' && turn.result?.clarification && (
          <ClarificationView text={turn.text} clarification={turn.result.clarification} />
        )}
        {turn.status === 'done' && turn.result?.quoteId && (
          <ProposalView jobId={turn.result.jobId} quoteId={turn.result.quoteId} />
        )}
      </div>
    </li>
  );
}

function errorTitle(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong';
  if (error.code === 'AGENT_UNAVAILABLE') return 'Assistant unavailable';
  if (error.code === 'MODEL_POLICY_DENIED') return 'Blocked by your privacy setting';
  if (error.status === 403) return 'Not allowed';
  if (error.status === 0) return 'Can’t reach OPENTRADIE';
  return 'The assistant couldn’t finish';
}

const retryable = (error: unknown) =>
  !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.status === 429;

function ClarificationView({
  text,
  clarification,
}: {
  text: string;
  clarification: Clarification;
}) {
  const { state } = useWorkspace();
  const { ask, busy } = useConversation();
  const [chosen, setChosen] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const options = clarification.matches;

  function choose(customer: { id: string; name: string }) {
    setChosen(customer.id);
    void ask(text, customer);
  }

  return (
    <div className="grid gap-3">
      <Notice tone="warning" title="Which customer?">
        {clarification.message}
      </Notice>
      {options.length > 0 ? (
        <fieldset className="choices" disabled={busy || chosen !== null}>
          <legend className="sub-title">Matching customers</legend>
          {options.map((match) => (
            <Button
              key={match.id}
              block
              icon={chosen === match.id ? 'check' : 'customers'}
              onClick={() => choose(match)}
              aria-pressed={chosen === match.id}
            >
              {match.name}
            </Button>
          ))}
        </fieldset>
      ) : (
        <fieldset className="choices" disabled={busy || chosen !== null}>
          <legend className="sub-title">Pick an existing customer</legend>
          <SelectField
            label="Customer"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Select a customer…</option>
            {state.customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </SelectField>
          <Button
            variant="primary"
            icon="arrow"
            disabled={!selected}
            onClick={() => {
              const customer = state.customers.find((entry) => entry.id === selected);
              if (customer) choose(customer);
            }}
          >
            Use this customer
          </Button>
        </fieldset>
      )}
      <LinkButton href={href('customers', 'new')} icon="plus" variant="quiet">
        Add a new customer instead
      </LinkButton>
    </div>
  );
}

function ProposalView({ jobId, quoteId }: { jobId?: string; quoteId: string }) {
  const { state, customerName } = useWorkspace();
  const quote = state.quotes.find((entry) => entry.id === quoteId);
  const job = state.jobs.find((entry) => entry.id === (jobId ?? quote?.jobId));
  if (!quote) {
    return (
      <Notice
        tone="info"
        title="Draft quote prepared"
        action={
          <LinkButton href={href('quotes', quoteId)} icon="quotes">
            Open the quote
          </LinkButton>
        }
      >
        The quote was saved but this screen hasn’t refreshed yet.
      </Notice>
    );
  }
  return (
    <div className="grid gap-4" data-testid="proposal">
      <p>Here’s what I’ve prepared from your records. Check it before approving.</p>
      <div className="proposal-facts">
        <div className="fact">
          <span className="fact-label">Matched customer</span>
          <a className="fact-value text-link" href={href('customers', quote.customerId)}>
            {customerName(quote.customerId)}
          </a>
        </div>
        {job && (
          <div className="fact">
            <span className="fact-label">Proposed job</span>
            <a className="fact-value text-link" href={href('jobs', job.id)}>
              {job.title}
            </a>
            <span className="row-sub">
              {jobStatusLabel(job.status)} · review the scope before approving
            </span>
          </div>
        )}
      </div>
      <div className="card card-inset">
        <div className="section-head">
          <h3 className="section-title">Draft quote</h3>
          <QuoteStatusPill status={quote.status} />
        </div>
        <div className="section-body">
          <QuoteLines quote={quote} />
        </div>
      </div>
      <QuoteChecks quote={quote} />
      <QuoteApproval quote={quote} />
      <a className="text-link" href={href('quotes', quote.id)}>
        Open full quote
      </a>
    </div>
  );
}
