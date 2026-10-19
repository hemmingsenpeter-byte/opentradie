import { QuoteApproval, QuoteChecks, QuoteLines, QuoteStatusPill } from '../components/quote';
import { QuoteRow } from '../components/rows';
import { Empty, LinkButton, PageHeader, Section } from '../components/ui';
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
    { title: 'Rejected', quotes: state.quotes.filter((quote) => quote.status === 'rejected') },
  ];
  return (
    <div className="stack">
      <PageHeader title="Quotes" eyebrow="Priced from your approved rates" />
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
          .filter((group) => group.quotes.length > 0 || group.title !== 'Rejected')
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

function QuoteDetail({ quote }: { quote: Quote }) {
  const { state, customerName } = useWorkspace();
  const job = state.jobs.find((entry) => entry.id === quote.jobId);
  return (
    <div className="stack">
      <PageHeader
        title={job?.title ?? 'Quote'}
        eyebrow="Quote"
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
        <Section title="Price">
          <QuoteLines quote={quote} />
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
        </div>
      </div>
    </div>
  );
}
