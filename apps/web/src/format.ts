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
  cancelled: 'Cancelled',
};

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  draft: 'Awaiting approval',
  approved: 'Approved',
  sent: 'Sent',
  accepted: 'Accepted',
  rejected: 'Rejected',
  expired: 'Expired',
  superseded: 'Superseded',
};

export function jobStatusLabel(status: string): string {
  return JOB_STATUS_LABEL[status as JobStatus] ?? status.replaceAll('_', ' ');
}

export function quoteStatusLabel(status: string): string {
  return QUOTE_STATUS_LABEL[status as QuoteStatus] ?? status;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function initials(name: string): string {
  const parts = name.split(/\s+/).filter((part) => part && !/^(mr|mrs|ms|miss|dr)\.?$/i.test(part));
  return (parts.length ? parts : name.split(/\s+/))
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * Exact decimal parsing for the quote editor: strings are split on the decimal point and
 * combined as integers, so no floating-point value ever becomes a quantity or an amount.
 * Each returns null for anything that is not a plain non-negative decimal within `places`.
 */
function parseScaled(input: string, places: number): number | null {
  const match = /^(\d{1,12})(?:\.(\d*))?$/.exec(input.trim().replace(/^\$/, '').replace(/,/g, ''));
  if (!match) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > places) return null;
  const value = Number(match[1]) * 10 ** places + Number(fraction.padEnd(places, '0') || '0');
  return Number.isSafeInteger(value) ? value : null;
}

/** "1.5" -> 1500 thousandths. */
export const parseQuantityMilli = (input: string) => parseScaled(input, 3);
/** "$12.50" -> 1250 cents. */
export const parseCents = (input: string) => parseScaled(input, 2);
/** "12.5" (%) -> 1250 basis points. */
export const parsePercentBasisPoints = (input: string) => parseScaled(input, 2);

function scaledToText(value: number, places: number, keepZeros: boolean): string {
  const scale = 10 ** places;
  const whole = Math.trunc(value / scale);
  let fraction = String(value % scale).padStart(places, '0');
  if (!keepZeros) fraction = fraction.replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}
export const milliToText = (milli: number) => scaledToText(milli, 3, false);
export const centsToText = (cents: number) => scaledToText(cents, 2, true);
export const basisPointsToText = (bp: number) => scaledToText(bp, 2, false);

/** "49091850" -> "49-091-850". */
export function formatGstNumber(digits: string | null | undefined): string {
  if (!digits || !/^\d{8,9}$/.test(digits)) return digits ?? '';
  return `${digits.slice(0, -6)}-${digits.slice(-6, -3)}-${digits.slice(-3)}`;
}
