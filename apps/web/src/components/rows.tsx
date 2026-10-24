import { TagChips } from './tags';
import { initials, jobStatusLabel } from '../format';
import { href } from '../router';
import type { Customer, Job, Quote } from '../types';
import { useWorkspace } from '../workspace';
import { Icon } from './Icons';
import { QuoteStatusPill } from './quote';
import { Pill } from './ui';

export function JobRow({ job, showCustomer = true }: { job: Job; showCustomer?: boolean }) {
  const { customerName } = useWorkspace();
  return (
    <li>
      <a className="row" href={href('jobs', job.id)}>
        <span className="row-main">
          <span className="row-title">{job.title}</span>
          {showCustomer && <span className="row-sub">{customerName(job.customerId)}</span>}
        </span>
        <Pill
          tone={job.status === 'completed' ? 'approved' : job.status === 'new' ? 'info' : 'neutral'}
        >
          {jobStatusLabel(job.status)}
        </Pill>
        <Icon name="chevron" className="row-chevron" />
      </a>
    </li>
  );
}

export function QuoteRow({ quote, showCustomer = true }: { quote: Quote; showCustomer?: boolean }) {
  const { state, customerName, money } = useWorkspace();
  const job = state.jobs.find((entry) => entry.id === quote.jobId);
  return (
    <li>
      <a className="row" href={href('quotes', quote.id)}>
        <span className="row-main">
          <span className="row-title">{job?.title ?? 'Quote'}</span>
          <span className="row-sub">
            {showCustomer && `${customerName(quote.customerId)} · `}
            <QuoteStatusPill status={quote.status} />
          </span>
        </span>
        <span className="row-amount">{money(quote.totalCents)}</span>
        <Icon name="chevron" className="row-chevron" />
      </a>
    </li>
  );
}

export function CustomerRow({ customer }: { customer: Customer }) {
  const { state } = useWorkspace();
  const jobs = state.jobs.filter((job) => job.customerId === customer.id).length;
  return (
    <li>
      <a className="row" href={href('customers', customer.id)}>
        <span className="avatar" aria-hidden="true">
          {initials(customer.name)}
        </span>
        <span className="row-main">
          <span className="row-title">{customer.name}</span>
          <span className="row-sub">
            {customer.phone || customer.email || 'No contact details'}
          </span>
          <TagChips tags={customer.tags} label={`Tags for ${customer.name}`} />
        </span>
        <span className="row-meta">
          {jobs} {jobs === 1 ? 'job' : 'jobs'}
        </span>
        <Icon name="chevron" className="row-chevron" />
      </a>
    </li>
  );
}
