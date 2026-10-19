import { formatDate } from '../format';
import { href } from '../router';
import { AssistantComposer } from './Assistant';
import { JobRow, QuoteRow } from '../components/rows';
import { Empty, LinkButton, Section } from '../components/ui';
import { useWorkspace } from '../workspace';

function greeting(timeZone: string): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-NZ', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(
      new Date(),
    ),
  );
  return hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
}

export function HomeScreen() {
  const { state, customerName } = useWorkspace();
  const pending = state.quotes.filter((quote) => quote.status === 'draft');
  const current = state.jobs.filter(
    (job) => job.status !== 'completed' && job.status !== 'cancelled',
  );
  const enquiries = state.communications.slice(0, 5);

  return (
    <div className="stack">
      <header className="page-header">
        <p className="eyebrow">{state.business.name}</p>
        <h1 className="page-title">{greeting(state.business.timeZone)}. What’s on?</h1>
      </header>

      <section className="card card-hivis" aria-labelledby="home-assistant">
        <h2 id="home-assistant" className="section-title">
          Ask the assistant
        </h2>
        <AssistantComposer compact goToAssistant />
      </section>

      <div className="grid-2">
        <Section
          title="Awaiting your approval"
          count={pending.length}
          action={
            <a className="text-link" href={href('approvals')}>
              Approval inbox
            </a>
          }
        >
          {pending.length ? (
            <ul className="rows">
              {pending.slice(0, 5).map((quote) => (
                <QuoteRow key={quote.id} quote={quote} />
              ))}
            </ul>
          ) : (
            <Empty icon="check" title="Nothing waiting">
              Draft quotes the assistant prepares will show up here for you to check.
            </Empty>
          )}
        </Section>

        <Section
          title="Current jobs"
          count={current.length}
          action={
            <a className="text-link" href={href('jobs')}>
              All jobs
            </a>
          }
        >
          {current.length ? (
            <ul className="rows">
              {current.slice(0, 6).map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </ul>
          ) : (
            <Empty
              icon="jobs"
              title="No open jobs"
              action={
                <LinkButton href={href('jobs', 'new')} icon="plus">
                  New job
                </LinkButton>
              }
            />
          )}
        </Section>
      </div>

      <Section title="Recent enquiries" count={enquiries.length}>
        {enquiries.length ? (
          <ul className="rows">
            {enquiries.map((entry) => (
              <li key={entry.id} className="enquiry">
                <p className="row-sub">
                  {entry.customerId ? (
                    <a className="text-link" href={href('customers', entry.customerId)}>
                      {customerName(entry.customerId)}
                    </a>
                  ) : (
                    <span>Customer not matched</span>
                  )}
                  {' · '}
                  <time dateTime={entry.createdAt}>
                    {formatDate(entry.createdAt, state.business.timeZone)}
                  </time>
                </p>
                <p className="enquiry-text">{entry.text}</p>
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon="mail" title="No enquiries yet">
            Enquiries you give the assistant are kept here, linked to the customer.
          </Empty>
        )}
      </Section>
    </div>
  );
}
