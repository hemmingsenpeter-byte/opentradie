/**
 * Pure scheduling rules: appointment overlap with buffers, working-hours availability in the
 * business time zone (DST-safe), slot suggestions and reminder timing.
 *
 * Instants are epoch milliseconds (UTC). Local wall times are a calendar date (`YYYY-MM-DD`)
 * plus minutes after local midnight. Conversions use `Intl.DateTimeFormat` only, so the same
 * code runs in Node and the browser without a Temporal polyfill.
 */

export const APPOINTMENT_STATUSES = ['proposed', 'confirmed', 'cancelled', 'completed'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Statuses that occupy time. Cancelled and completed appointments never block a slot. */
export const BLOCKING_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'proposed',
  'confirmed',
];

export const MINUTE_MS = 60_000;
export const DAY_MINUTES = 1440;
/** Longest appointment the API accepts (multi-day jobs are several appointments). */
export const MAX_APPOINTMENT_MINUTES = 16 * 60;
export const MAX_BUFFER_MINUTES = 240;

export interface Interval {
  startMs: number;
  endMs: number;
}

export interface BusyInterval extends Interval {
  id: string;
}

/** True when the intervals overlap once each is padded by `bufferMinutes` (touching is fine). */
export function intervalsOverlap(a: Interval, b: Interval, bufferMinutes = 0): boolean {
  const buffer = bufferMinutes * MINUTE_MS;
  return a.startMs < b.endMs + buffer && b.startMs < a.endMs + buffer;
}

/** Busy intervals that clash with the candidate, in start order. */
export function findConflicts<T extends BusyInterval>(
  candidate: Interval,
  busy: readonly T[],
  options: { bufferMinutes?: number; ignoreId?: string } = {},
): T[] {
  return busy
    .filter((item) => item.id !== options.ignoreId)
    .filter((item) => intervalsOverlap(candidate, item, options.bufferMinutes ?? 0))
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
}

// ---------- time zones ----------

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(instantMs: number, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs)))
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour === 24 ? 0 : parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** Offset of local time from UTC at an instant, in minutes (Pacific/Auckland: 720 or 780). */
export function timeZoneOffsetMinutes(instantMs: number, timeZone: string): number {
  const wall = wallClock(instantMs, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const truncated = Math.floor(instantMs / 1000) * 1000;
  return Math.round((asUtc - truncated) / MINUTE_MS);
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

/** Parses a strict `YYYY-MM-DD` calendar date; returns null for impossible dates. */
export function parseLocalDate(value: string): LocalDateParts | null {
  const match = LOCAL_DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    return null;
  return { year, month, day };
}

function requireDate(value: string): LocalDateParts {
  const parsed = parseLocalDate(value);
  if (!parsed) throw new RangeError(`Invalid local date: ${value}`);
  return parsed;
}

const pad = (value: number, size = 2) => String(value).padStart(size, '0');
const formatDate = (date: Date) =>
  `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

export function addLocalDays(date: string, days: number): string {
  const { year, month, day } = requireDate(date);
  return formatDate(new Date(Date.UTC(year, month - 1, day + days)));
}

/** 0 = Sunday ... 6 = Saturday, like `Date#getDay`. */
export function localWeekday(date: string): number {
  const { year, month, day } = requireDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * The instant at which a local wall time occurs. `minuteOfDay` may be 0..1440 (1440 is the
 * next midnight). In a DST gap (time skipped forward) the result moves forward by the gap; in a
 * DST overlap (time repeated) the earlier occurrence is used. This matches Temporal's
 * 'compatible' disambiguation.
 */
export function localTimeToInstant(date: string, minuteOfDay: number, timeZone: string): number {
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > DAY_MINUTES)
    throw new RangeError('minuteOfDay must be an integer from 0 to 1440.');
  const { year, month, day } = requireDate(date);
  const wall = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  const offsets = [
    timeZoneOffsetMinutes(wall - 86_400_000, timeZone),
    timeZoneOffsetMinutes(wall + 86_400_000, timeZone),
  ];
  const valid = offsets
    .map((offset) => ({ offset, instant: wall - offset * MINUTE_MS }))
    .filter(({ offset, instant }) => timeZoneOffsetMinutes(instant, timeZone) === offset)
    .map(({ instant }) => instant);
  if (valid.length) return Math.min(...valid);
  // Gap: the wall time does not exist; shift forward by the gap length.
  return wall - Math.min(...offsets) * MINUTE_MS;
}

export interface LocalDateTime {
  date: string;
  minuteOfDay: number;
  weekday: number;
}

export function instantToLocal(instantMs: number, timeZone: string): LocalDateTime {
  const wall = wallClock(instantMs, timeZone);
  const date = `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
  return { date, minuteOfDay: wall.hour * 60 + wall.minute, weekday: localWeekday(date) };
}

// ---------- working hours ----------

export interface WorkingHoursRule {
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  /** Minutes after local midnight, 0..1439. */
  startMinute: number;
  /** Minutes after local midnight, 1..1440; greater than startMinute. */
  endMinute: number;
}

/** Used until the owner saves their own hours: Monday to Friday, 7:00 to 17:00. */
export const DEFAULT_WORKING_HOURS: readonly WorkingHoursRule[] = [1, 2, 3, 4, 5].map(
  (weekday) => ({ weekday, startMinute: 7 * 60, endMinute: 17 * 60 }),
);

/** Problems with a set of working-hours rules; empty when valid. */
export function workingHoursErrors(rules: readonly WorkingHoursRule[]): string[] {
  const errors: string[] = [];
  for (const rule of rules) {
    if (!Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6)
      errors.push('weekday must be 0 (Sunday) to 6 (Saturday).');
    if (
      !Number.isInteger(rule.startMinute) ||
      !Number.isInteger(rule.endMinute) ||
      rule.startMinute < 0 ||
      rule.endMinute > DAY_MINUTES ||
      rule.startMinute >= rule.endMinute
    )
      errors.push('Each range needs a start before its end, within one day.');
  }
  for (let weekday = 0; weekday <= 6; weekday += 1) {
    const day = rules
      .filter((rule) => rule.weekday === weekday)
      .sort((a, b) => a.startMinute - b.startMinute);
    for (let index = 1; index < day.length; index += 1)
      if (day[index]!.startMinute < day[index - 1]!.endMinute)
        errors.push('Working-hours ranges on the same day must not overlap.');
  }
  return [...new Set(errors)];
}

/** The working ranges of one local date as instants (DST-aware: a range may be 23 or 25 hours). */
export function workingIntervalsForDate(
  date: string,
  timeZone: string,
  rules: readonly WorkingHoursRule[],
): Interval[] {
  const weekday = localWeekday(date);
  return rules
    .filter((rule) => rule.weekday === weekday)
    .sort((a, b) => a.startMinute - b.startMinute)
    .map((rule) => ({
      startMs: localTimeToInstant(date, rule.startMinute, timeZone),
      endMs: localTimeToInstant(date, rule.endMinute, timeZone),
    }))
    .filter((interval) => interval.endMs > interval.startMs);
}

/** True when the whole interval falls inside one working range of the day it starts on. */
export function isWithinWorkingHours(
  interval: Interval,
  timeZone: string,
  rules: readonly WorkingHoursRule[],
): boolean {
  const { date } = instantToLocal(interval.startMs, timeZone);
  return workingIntervalsForDate(date, timeZone, rules).some(
    (range) => range.startMs <= interval.startMs && interval.endMs <= range.endMs,
  );
}

export interface AvailabilityInput {
  /** Local calendar date in the business time zone. */
  date: string;
  timeZone: string;
  workingHours: readonly WorkingHoursRule[];
  busy: readonly BusyInterval[];
  durationMinutes: number;
  bufferMinutes: number;
  /** Spacing between candidate start times; defaults to 30 minutes. */
  stepMinutes?: number;
  /** Slots starting before this instant are not offered (e.g. now plus minimum notice). */
  notBeforeMs?: number;
}

function assertDuration(minutes: number) {
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > MAX_APPOINTMENT_MINUTES)
    throw new RangeError(
      `durationMinutes must be an integer from 5 to ${MAX_APPOINTMENT_MINUTES}.`,
    );
}

/**
 * Free slots of `durationMinutes` on one local date. Candidates step through each working range
 * in elapsed time from the range start, so a DST change inside the range neither skips nor
 * double-counts real time. A slot is free when it fits inside the range and does not overlap
 * any busy interval once the buffer is applied on both sides.
 */
export function availableSlots(input: AvailabilityInput): Interval[] {
  assertDuration(input.durationMinutes);
  const step = (input.stepMinutes ?? 30) * MINUTE_MS;
  if (step <= 0) throw new RangeError('stepMinutes must be positive.');
  const duration = input.durationMinutes * MINUTE_MS;
  const slots: Interval[] = [];
  for (const range of workingIntervalsForDate(input.date, input.timeZone, input.workingHours)) {
    for (let start = range.startMs; start + duration <= range.endMs; start += step) {
      if (input.notBeforeMs !== undefined && start < input.notBeforeMs) continue;
      const slot = { startMs: start, endMs: start + duration };
      if (findConflicts(slot, input.busy, { bufferMinutes: input.bufferMinutes }).length) continue;
      slots.push(slot);
    }
  }
  return slots;
}

export interface SlotProposalInput extends Omit<AvailabilityInput, 'date'> {
  fromDate: string;
  /** How many local dates to search, starting at fromDate (1..31). */
  days: number;
  /** Maximum slots to return. */
  count: number;
}

/** The first `count` free slots from `fromDate` onwards, searching at most `days` dates. */
export function proposeSlots(input: SlotProposalInput): Interval[] {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 31)
    throw new RangeError('days must be 1 to 31.');
  const slots: Interval[] = [];
  for (let offset = 0; offset < input.days && slots.length < input.count; offset += 1) {
    const date = addLocalDays(input.fromDate, offset);
    for (const slot of availableSlots({ ...input, date })) {
      slots.push(slot);
      if (slots.length >= input.count) break;
    }
  }
  return slots;
}

// ---------- reminders ----------

export interface ReminderTiming {
  /** How long before the appointment the reminder is due (default 24 hours). */
  leadMinutes?: number;
  /** No reminder when the appointment starts sooner than this from now (default 60 minutes). */
  minimumNoticeMinutes?: number;
}

/**
 * When an appointment reminder is due. If the normal lead time has already passed but the
 * appointment is still far enough away, the reminder is due now; if it is too close (or past),
 * no reminder is scheduled.
 */
export function reminderDueAt(
  startsAtMs: number,
  nowMs: number,
  timing: ReminderTiming = {},
): number | null {
  const lead = (timing.leadMinutes ?? DAY_MINUTES) * MINUTE_MS;
  const notice = (timing.minimumNoticeMinutes ?? 60) * MINUTE_MS;
  if (startsAtMs - nowMs < notice) return null;
  return Math.max(startsAtMs - lead, nowMs);
}

/** Stable dedupe key: one reminder per appointment, schedule version and kind. */
export function appointmentReminderKey(
  appointmentId: string,
  version: number,
  kind = 'customer_24h',
): string {
  return `appointment:${appointmentId}:v${version}:${kind}`;
}
