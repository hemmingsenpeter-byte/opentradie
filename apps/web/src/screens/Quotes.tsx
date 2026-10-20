import { useEffect, useState } from 'react';
import { getQuoteActivity } from '../api';
import { QuoteEditor } from '../components/QuoteEditor';
import { QuoteApproval, QuoteChecks, QuoteLines, QuoteStatusPill } from '../components/quote';
import { QuoteRow } from '../components/rows';
import { Button, Empty, LinkButton, PageHeader, Section } from '../components/ui';
import { formatDate } from '../format';
import { href } from '../router';
import type { Quote } from '../types';
import { useWorkspace } from '../workspace';

export function QuotesScreen({ segments }: { segments: string[] }) {
  const { state } = useWorkspace();
  const [id] = segments;
  if (id) {
    const quote = state.quotes.find((entry) => entry.id === id);
    if (!quote) {
      return (
        <div className="stack">
          <PageHeader title="Quote not found" back={{ href: href('quotes'), label: 'Quotes' }} />
          <Empty icon="quotes" title="This quote isn’t in your workspace" />
        </div>
      );
    }
    return <QuoteDetail quote={quote} />;
  }
  return <QuoteList />;
}

function QuoteList() {
  const { state } = useWorkspace();
  const groups: { title: string; quotes: Quote[] }[] = [
    {
      title: 'Awaiting approval',
      quotes: state.quotes.filter((quote) => quote.status === 'draft'),
    },
    { title: 'Approved', quotes: state.quotes.filter((quote) => quote.status === 'approved') },
    { title: 'Sent', quotes: state.quotes.filter((quote) => quote.status === 'sent') },
    { title: 'Accepted', quotes: state.quotes.filter((quote) => quote.status === 'accepted') },
    {
      title: 'Closed',
      quotes: state.quotes.filter(
        (quote) => quote.status === 'rejected' || quote.status === 'expired',
      ),
    },
  ];
  return (
    <div className="stack">
      <PageHeader
        title="Quotes"
        eyebrow="Priced from your approved rates"
        actions={
          <LinkButton href={href('invoices')} icon="file">
            Invoices
          </LinkButton>
        }
      />
      {state.quotes.length === 0 ? (
        <Empty
          icon="quotes"
          title="No quotes yet"
          action={
            <LinkButton href={href('assistant')} variant="primary" icon="assistant">
              Ask the assistant
            </LinkButton>
          }
        >
          Describe a job to the assistant and it will draft a quote for you to check.
        </Empty>
      ) : (
        groups
          .filter(
            (group) =>
              group.quotes.length > 0 ||
              group.title === 'Awaiting approval' ||
              group.title === 'Approved',
          )
          .map((group) => (
            <Section key={group.title} title={group.title} count={group.quotes.length}>
              {group.quotes.length ? (
                <ul className="rows">
                  {group.quotes.map((quote) => (
                    <QuoteRow key={quote.id} quote={quote} />
                  ))}
                </ul>
              ) : (
                <Empty icon="check" title={`No quotes ${group.title.toLowerCase()}`} />
              )}
            </Section>
          ))
      )}
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  'quote.drafted': 'Draft prepared',
  'quote.revised': 'Lines edited',
  'quote.approved': 'Approved by the owner',
  'quote.rejected': 'Rejected by the owner',
  'quote.sent': 'Sent (message drafted with link)',
  'quote.accepted': 'Accepted by the customer',
  'quote.declined': 'Declined by the customer',
  'quote.expired': 'Expired',
  'quote.superseded': 'Superseded by a new version',
  'quote.version_created': 'New version created',
};

function QuoteActivity({ quote }: { quote: Quote }) {
  const [events, setEvents] = useState<
    { id: string; action: string; actorType: string; createdAt: string }[] | null
  >(null);
  useEffect(() => {
    let live = true;
    getQuoteActivity(quote.id)
      .then((result) => live && setEvents(result.auditEvents))
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [quote.id, quote.version]);
  if (!events?.length) return <p className="muted">No activity recorded yet.</p>;
  return (
    <ol className="grid gap-2" data-testid="quote-activity">
      {events.map((event) => (
        <li key={event.id}>
          <strong>{ACTION_LABEL[event.action] ?? event.action}</strong>{' '}
          <span className="muted">
            · {event.actorType === 'customer' ? 'customer' : event.actorType} ·{' '}
            {formatDate(event.createdAt)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function QuoteDetail({ quote }: { quote: Quote }) {
  const { state, customerName, isOwner } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const job = state.jobs.find((entry) => entry.id === quote.jobId);
  const versions = state.quotes
    .filter((entry) => quote.quoteGroupId && entry.quoteGroupId === quote.quoteGroupId)
    .sort((a, b) => (b.revision ?? 1) - (a.revision ?? 1));
  return (
    <div className="stack">
      <PageHeader
        title={job?.title ?? 'Quote'}
        eyebrow={
          quote.quoteNumber
            ? `Quote ${quote.quoteNumber}${(quote.revision ?? 1) > 1 ? ` · version ${quote.revision}` : ''}`
            : 'Quote'
        }
        back={{ href: href('quotes'), label: 'Quotes' }}
      >
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span data-testid="quote-status">
            <QuoteStatusPill status={quote.status} />
          </span>
          <a className="text-link" href={href('customers', quote.customerId)}>
            {customerName(quote.customerId)}
          </a>
          {job && (
            <a className="text-link" href={href('jobs', job.id)}>
              View job
            </a>
          )}
        </div>
      </PageHeader>
      <div className="grid-2">
        <Section
          title="Price"
          action={
            isOwner && quote.status === 'draft' ? (
              <Button icon="edit" onClick={() => setEditing((value) => !value)}>
                {editing ? 'Close editor' : 'Edit lines'}
              </Button>
            ) : undefined
          }
        >
          {editing && quote.status === 'draft' ? (
            <div className="grid gap-4">
              <QuoteEditor key={quote.id} quote={quote} onSaved={() => setEditing(false)} />
              <QuoteLines quote={quote} />
            </div>
          ) : (
            <QuoteLines quote={quote} />
          )}
        </Section>
        <div className="stack">
          <Section title="Check before approving">
            <QuoteChecks quote={quote} />
            {quote.missingInformation.length === 0 && quote.assumptions.length === 0 && (
              <p className="muted">No assumptions or open questions recorded.</p>
            )}
          </Section>
          <section className="card card-pad">
            <QuoteApproval quote={quote} />
          </section>
          {versions.length > 1 && (
            <Section title="Versions" count={versions.length}>
              <ul className="rows" data-testid="quote-versions">
                {versions.map((entry) => (
                  <li key={entry.id}>
                    <a
                      className="row"
                      href={href('quotes', entry.id)}
                      aria-current={entry.id === quote.id ? 'page' : undefined}
                    >
                      <span className="row-main">
                        <span className="row-title">Version {entry.revision ?? 1}</span>
                        <span className="row-sub">
                          <QuoteStatusPill status={entry.status} />
                        </span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section title="Activity">
            <QuoteActivity quote={quote} />
          </Section>
        </div>
      </div>
    </div>
  );
}
