import type { LineInput } from './pricing.js';

/**
 * Versioned quote documents and their lifecycle. Pure: no clock, no I/O. Callers pass `now`.
 *
 *   draft ──► sent ──► accepted | rejected | expired | superseded
 *     └────► superseded
 *
 * accepted, rejected, expired and superseded are terminal. A revision of a draft or sent quote
 * is a new version (n + 1) in draft; the previous version becomes superseded. Old versions are
 * never edited, so what the customer saw stays reproducible.
 */

export type QuoteDocumentStatus =
  'draft' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'superseded';

export const QUOTE_TRANSITIONS: Readonly<
  Record<QuoteDocumentStatus, readonly QuoteDocumentStatus[]>
> = {
  draft: ['sent', 'superseded'],
  sent: ['accepted', 'rejected', 'expired', 'superseded'],
  accepted: [],
  rejected: [],
  expired: [],
  superseded: [],
};

export function isTerminalQuoteStatus(status: QuoteDocumentStatus): boolean {
  return QUOTE_TRANSITIONS[status].length === 0;
}

export function canTransitionQuote(from: QuoteDocumentStatus, to: QuoteDocumentStatus): boolean {
  return QUOTE_TRANSITIONS[from]?.includes(to) ?? false;
}

export class QuoteTransitionError extends Error {
  constructor(
    readonly code: 'INVALID_TRANSITION' | 'QUOTE_EXPIRED' | 'QUOTE_INCOMPLETE' | 'INVALID_DATE',
    message: string,
  ) {
    super(message);
    this.name = 'QuoteTransitionError';
  }
}

export interface QuoteVersion {
  /** Business-facing quote number, stable across versions (e.g. "Q-0042"). */
  quoteNumber: string;
  /** 1-based version number. */
  version: number;
  status: QuoteDocumentStatus;
  /** Calendar dates (YYYY-MM-DD) in the business's time zone. */
  issueDate: string;
  validUntil: string;
  lines: LineInput[];
  terms: string;
  sentAt: string | null;
  decidedAt: string | null;
  supersededByVersion: number | null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validate a YYYY-MM-DD calendar date (rejects 2026-02-30). */
export function assertIsoDate(value: string, label = 'date'): string {
  const match = ISO_DATE.exec(value);
  if (match) {
    const [, y, m, d] = match.map(Number) as [number, number, number, number];
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d)
      return value;
  }
  throw new QuoteTransitionError('INVALID_DATE', `${label} must be a YYYY-MM-DD calendar date.`);
}

/** The calendar date of `now` in `timeZone` as YYYY-MM-DD. */
export function localDate(now: Date, timeZone = 'Pacific/Auckland'): string {
  if (Number.isNaN(now.getTime())) throw new QuoteTransitionError('INVALID_DATE', 'Invalid now.');
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Add whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  assertIsoDate(date);
  if (!Number.isSafeInteger(days)) throw new RangeError('days must be a whole number.');
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * A quote is valid through the whole of its `validUntil` day in the business time zone and
 * lapses at the start of the next local day.
 */
export function isQuoteValidityLapsed(
  validUntil: string,
  now: Date,
  timeZone = 'Pacific/Auckland',
): boolean {
  assertIsoDate(validUntil, 'validUntil');
  return localDate(now, timeZone) > validUntil;
}

export function createQuoteDraft(input: {
  quoteNumber: string;
  lines: LineInput[];
  issueDate: string;
  validityDays?: number;
  terms?: string;
}): QuoteVersion {
  if (!input.quoteNumber.trim()) throw new RangeError('quote number is required.');
  const validityDays = input.validityDays ?? 30;
  if (!Number.isSafeInteger(validityDays) || validityDays < 0 || validityDays > 365)
    throw new RangeError('validity must be between 0 and 365 days.');
  assertIsoDate(input.issueDate, 'issueDate');
  return {
    quoteNumber: input.quoteNumber.trim(),
    version: 1,
    status: 'draft',
    issueDate: input.issueDate,
    validUntil: addDays(input.issueDate, validityDays),
    lines: [...input.lines],
    terms: input.terms ?? '',
    sentAt: null,
    decidedAt: null,
    supersededByVersion: null,
  };
}

/**
 * Move a quote to a new status. Sending needs at least one line; accepting needs the quote to
 * still be within its validity. Returns a new object; the input is not mutated.
 */
export function transitionQuote(
  quote: QuoteVersion,
  to: Exclude<QuoteDocumentStatus, 'superseded' | 'draft'>,
  now: Date,
  timeZone = 'Pacific/Auckland',
): QuoteVersion {
  if (!canTransitionQuote(quote.status, to))
    throw new QuoteTransitionError(
      'INVALID_TRANSITION',
      `A ${quote.status} quote cannot become ${to}.`,
    );
  const at = now.toISOString();
  if (to === 'sent') {
    if (quote.lines.length === 0)
      throw new QuoteTransitionError('QUOTE_INCOMPLETE', 'A quote needs at least one line.');
    if (isQuoteValidityLapsed(quote.validUntil, now, timeZone))
      throw new QuoteTransitionError('QUOTE_EXPIRED', 'The validity date has already passed.');
    return { ...quote, status: 'sent', sentAt: at };
  }
  if (to === 'accepted' && isQuoteValidityLapsed(quote.validUntil, now, timeZone))
    throw new QuoteTransitionError('QUOTE_EXPIRED', 'This quote has expired.');
  if (to === 'expired' && !isQuoteValidityLapsed(quote.validUntil, now, timeZone))
    throw new QuoteTransitionError('INVALID_TRANSITION', 'This quote is still within validity.');
  return { ...quote, status: to, decidedAt: at };
}

/** For a sweep: return the expired version if a sent quote has lapsed, otherwise null. */
export function expireIfLapsed(
  quote: QuoteVersion,
  now: Date,
  timeZone = 'Pacific/Auckland',
): QuoteVersion | null {
  if (quote.status !== 'sent' || !isQuoteValidityLapsed(quote.validUntil, now, timeZone))
    return null;
  return transitionQuote(quote, 'expired', now, timeZone);
}

/**
 * Revise a draft or sent quote. Returns the superseded previous version and the new draft
 * version n + 1 with the changed fields. A new validity window starts at `issueDate`.
 */
export function reviseQuote(
  current: QuoteVersion,
  changes: { lines?: LineInput[]; terms?: string; issueDate: string; validityDays?: number },
): { superseded: QuoteVersion; next: QuoteVersion } {
  if (!canTransitionQuote(current.status, 'superseded'))
    throw new QuoteTransitionError(
      'INVALID_TRANSITION',
      `A ${current.status} quote cannot be revised.`,
    );
  const next = createQuoteDraft({
    quoteNumber: current.quoteNumber,
    lines: changes.lines ?? current.lines,
    issueDate: changes.issueDate,
    validityDays: changes.validityDays,
    terms: changes.terms ?? current.terms,
  });
  next.version = current.version + 1;
  return {
    superseded: { ...current, status: 'superseded', supersededByVersion: next.version },
    next,
  };
}
