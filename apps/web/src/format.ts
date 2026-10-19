import type { JobStatus, QuoteStatus } from './types';

/**
 * Display formatting only. Amounts arrive as server-calculated integer cents; the client
 * never adds, multiplies or taxes them.
 */
export function formatMoney(cents: number, currency = 'NZD'): string {
  return new Intl.NumberFormat('en-NZ', { style: 'currency', currency }).format(cents / 100);
}

/** Tax rate label from server basis points, e.g. 1500 -> "15%". */
export function formatRate(basisPoints: number): string {
  return `${new Intl.NumberFormat('en-NZ', { maximumFractionDigits: 2 }).format(basisPoints / 100)}%`;
}

export function formatDate(iso: string, timeZone = 'Pacific/Auckland'): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-NZ', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(date);
}

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  new: 'New',
  quoted: 'Quoted',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
};

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  draft: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

export function jobStatusLabel(status: string): string {
  return JOB_STATUS_LABEL[status as JobStatus] ?? status.replaceAll('_', ' ');
}

export function quoteStatusLabel(status: string): string {
  return QUOTE_STATUS_LABEL[status as QuoteStatus] ?? status;
}

export function initials(name: string): string {
  const parts = name.split(/\s+/).filter((part) => part && !/^(mr|mrs|ms|miss|dr)\.?$/i.test(part));
  return (parts.length ? parts : name.split(/\s+/))
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
