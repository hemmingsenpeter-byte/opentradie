import { MAX_TIME_ENTRY_MILLI } from './agent-tools.js';
import { MAX_AMOUNT_CENTS } from './money.js';
import { instantToLocal, localTimeToInstant, parseLocalDate } from './scheduling.js';

/**
 * Deterministic helpers for voice notes (ADR 0024). The model only labels what was said ("next
 * year", "$185", "one and a half hours"); the server turns those labels into dates, integer
 * cents and thousandths of an hour here, so no authoritative number comes from model output.
 */

export const VOICE_NOTE_STATUSES = [
  'uploaded',
  'transcribing',
  'transcribed',
  'interpreting',
  'proposed',
  'needs_clarification',
  'failed',
] as const;
export type VoiceNoteStatus = (typeof VOICE_NOTE_STATUSES)[number];

/** Confidence below this is highlighted for the owner to check. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

export type RelativeUnit = 'day' | 'week' | 'month' | 'year';

/**
 * Adds a calendar period to a local date. Months and years clamp to the last day of the target
 * month, so 29 Feb + 1 year is 28 Feb and 31 Jan + 1 month is 28/29 Feb.
 */
export function addLocalPeriod(date: string, amount: number, unit: RelativeUnit): string {
  const parsed = parseLocalDate(date);
  if (!parsed) throw new RangeError(`Invalid local date: ${date}`);
  if (!Number.isInteger(amount) || amount < 0 || amount > 1000)
    throw new RangeError('amount must be an integer from 0 to 1000.');
  const { year, month, day } = parsed;
  let result: Date;
  if (unit === 'day' || unit === 'week') {
    result = new Date(Date.UTC(year, month - 1, day + amount * (unit === 'week' ? 7 : 1)));
  } else {
    const months = month - 1 + amount * (unit === 'year' ? 12 : 1);
    const targetYear = year + Math.floor(months / 12);
    const targetMonth = months % 12;
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    result = new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)));
  }
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${pad(result.getUTCFullYear(), 4)}-${pad(result.getUTCMonth() + 1)}-${pad(result.getUTCDate())}`;
}

export type ReminderDue =
  { kind: 'relative'; amount: number; unit: RelativeUnit } | { kind: 'absolute'; date: string };

/** Reminders fall due at 9:00 am business time. */
export const REMINDER_MINUTE_OF_DAY = 9 * 60;

/**
 * The instant a spoken reminder falls due, computed from the moment the voice note was recorded
 * (not from "now", so re-interpreting the same note gives the same date): the local recording
 * date plus the period, at 9:00 am in the business time zone.
 */
export function voiceReminderDueAt(recordedAtMs: number, timeZone: string, due: ReminderDue): Date {
  const localDate =
    due.kind === 'absolute'
      ? due.date
      : addLocalPeriod(instantToLocal(recordedAtMs, timeZone).date, due.amount, due.unit);
  if (!parseLocalDate(localDate)) throw new RangeError(`Invalid local date: ${localDate}`);
  return new Date(localTimeToInstant(localDate, REMINDER_MINUTE_OF_DAY, timeZone));
}

/**
 * Parses an amount as spoken or written ("$185", "185 dollars", "$1,234.50", "NZ$ 99.9") into
 * integer cents. Anything else (ranges, words, negative numbers, more than 2 decimals) is null:
 * the owner enters the cost instead of the server guessing.
 */
export function parseStatedAmountCents(text: string | null | undefined): number | null {
  if (!text) return null;
  // Whitespace is collapsed to single spaces and trimmed first, so the pattern has no adjacent
  // or nested whitespace quantifiers (`\s*` next to `\s*` is quadratic on a long run of spaces).
  const match =
    /^(?:nz ?)?\$? ?(\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.(\d{1,2}))? ?(?:dollars?|bucks|nzd)?$/i.exec(
      text.replace(/\s+/g, ' ').trim(),
    );
  if (!match) return null;
  const whole = Number(match[1]!.replace(/,/g, ''));
  const fraction = match[2] ? Number(match[2].padEnd(2, '0')) : 0;
  const cents = whole * 100 + fraction;
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_AMOUNT_CENTS ? cents : null;
}

/** Decimal hours (at most 3 decimal places) to thousandths of an hour; null when out of range. */
export function hoursToQuantityMilli(hours: number): number | null {
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const milli = Math.round(hours * 1000);
  if (Math.abs(milli - hours * 1000) > 1e-6) return null;
  return milli >= 1 && milli <= MAX_TIME_ENTRY_MILLI ? milli : null;
}

export interface TranscriptSegmentLike {
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
}

/** Mean of the known segment confidences, weighted by duration; null when none is known. */
export function averageConfidence(segments: readonly TranscriptSegmentLike[]): number | null {
  const known = segments.filter((segment) => segment.confidence !== null);
  if (!known.length) return null;
  const weight = (segment: TranscriptSegmentLike) => Math.max(1, segment.endMs - segment.startMs);
  const total = known.reduce((sum, segment) => sum + weight(segment), 0);
  const value = known.reduce((sum, segment) => sum + weight(segment) * segment.confidence!, 0);
  return Math.round((value / total) * 1000) / 1000;
}
