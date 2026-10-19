import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  appointmentReminderKey,
  availableSlots,
  DEFAULT_WORKING_HOURS,
  findConflicts,
  instantToLocal,
  intervalsOverlap,
  isValidTimeZone,
  isWithinWorkingHours,
  localTimeToInstant,
  localWeekday,
  parseLocalDate,
  proposeSlots,
  reminderDueAt,
  timeZoneOffsetMinutes,
  workingHoursErrors,
  workingIntervalsForDate,
  type BusyInterval,
} from './scheduling.js';

const NZ = 'Pacific/Auckland';
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();
const busy = (id: string, start: string, end: string): BusyInterval => ({
  id,
  startMs: at(start),
  endMs: at(end),
});
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 0,
  endMinute: 1440,
}));

describe('overlap and conflicts', () => {
  const a = { startMs: at('2026-06-01T00:00:00Z'), endMs: at('2026-06-01T01:00:00Z') };

  it('treats touching intervals as free and any shared time as a clash', () => {
    const touching = { startMs: a.endMs, endMs: a.endMs + 3_600_000 };
    expect(intervalsOverlap(a, touching)).toBe(false);
    expect(intervalsOverlap(a, { startMs: a.endMs - 60_000, endMs: a.endMs + 60_000 })).toBe(true);
    expect(intervalsOverlap(a, { startMs: a.startMs + 1, endMs: a.endMs - 1 })).toBe(true);
  });

  it('applies the buffer on both sides', () => {
    const later = { startMs: a.endMs + 10 * 60_000, endMs: a.endMs + 70 * 60_000 };
    expect(intervalsOverlap(a, later, 10)).toBe(false);
    expect(intervalsOverlap(a, later, 15)).toBe(true);
    expect(intervalsOverlap(later, a, 15)).toBe(true);
  });

  it('returns clashes in start order and can ignore the appointment being moved', () => {
    const items = [
      busy('late', '2026-06-01T00:45:00Z', '2026-06-01T02:00:00Z'),
      busy('early', '2026-05-31T23:30:00Z', '2026-06-01T00:15:00Z'),
      busy('far', '2026-06-01T05:00:00Z', '2026-06-01T06:00:00Z'),
    ];
    expect(findConflicts(a, items).map((item) => item.id)).toEqual(['early', 'late']);
    expect(findConflicts(a, items, { ignoreId: 'early' }).map((item) => item.id)).toEqual(['late']);
    expect(findConflicts(a, items, { bufferMinutes: 241 }).map((item) => item.id)).toEqual([
      'early',
      'late',
      'far',
    ]);
  });
});

describe('local dates and time zones', () => {
  it('parses strict calendar dates', () => {
    expect(parseLocalDate('2026-02-28')).toEqual({ year: 2026, month: 2, day: 28 });
    expect(parseLocalDate('2026-02-29')).toBeNull();
    expect(parseLocalDate('2026-2-1')).toBeNull();
    expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(localWeekday('2026-10-19')).toBe(1);
    expect(isValidTimeZone(NZ)).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });

  it('knows the New Zealand standard and daylight offsets', () => {
    expect(timeZoneOffsetMinutes(at('2026-07-01T00:00:00Z'), NZ)).toBe(720);
    expect(timeZoneOffsetMinutes(at('2026-01-01T00:00:00Z'), NZ)).toBe(780);
  });

  it('converts ordinary local times both ways', () => {
    const instant = localTimeToInstant('2026-07-15', 9 * 60, NZ);
    expect(iso(instant)).toBe('2026-07-14T21:00:00.000Z');
    expect(instantToLocal(instant, NZ)).toEqual({
      date: '2026-07-15',
      minuteOfDay: 540,
      weekday: 3,
    });
    expect(iso(localTimeToInstant('2026-07-15', 1440, NZ))).toBe('2026-07-15T12:00:00.000Z');
  });

  describe('April 2026: daylight saving ends (03:00 NZDT becomes 02:00 NZST on 5 April)', () => {
    it('resolves the repeated hour to its first occurrence', () => {
      expect(iso(localTimeToInstant('2026-04-05', 150, NZ))).toBe('2026-04-04T13:30:00.000Z');
      expect(iso(localTimeToInstant('2026-04-05', 180, NZ))).toBe('2026-04-04T15:00:00.000Z');
      expect(iso(localTimeToInstant('2026-04-05', 9 * 60, NZ))).toBe('2026-04-04T21:00:00.000Z');
      expect(iso(localTimeToInstant('2026-04-04', 9 * 60, NZ))).toBe('2026-04-03T20:00:00.000Z');
    });

    it('makes that local day 25 hours long', () => {
      const [day] = workingIntervalsForDate('2026-04-05', NZ, ALL_DAY);
      expect((day!.endMs - day!.startMs) / 3_600_000).toBe(25);
    });

    it('offers every real half hour, including both 02:00s', () => {
      const slots = availableSlots({
        date: '2026-04-05',
        timeZone: NZ,
        workingHours: [{ weekday: 0, startMinute: 60, endMinute: 240 }],
        busy: [],
        durationMinutes: 30,
        bufferMinutes: 0,
      });
      // 01:00 to 04:00 local spans four real hours on this date.
      expect(slots).toHaveLength(8);
      expect(slots.map((slot) => instantToLocal(slot.startMs, NZ).minuteOfDay)).toEqual([
        60, 90, 120, 150, 120, 150, 180, 210,
      ]);
      expect(slots.map((slot) => timeZoneOffsetMinutes(slot.startMs, NZ))).toEqual([
        780, 780, 780, 780, 720, 720, 720, 720,
      ]);
    });

    it('keeps business-hours slots at the same wall-clock times either side of the change', () => {
      const local = (date: string) =>
        availableSlots({
          date,
          timeZone: NZ,
          workingHours: ALL_DAY.map((rule) => ({ ...rule, startMinute: 420, endMinute: 1020 })),
          busy: [],
          durationMinutes: 60,
          bufferMinutes: 0,
          stepMinutes: 60,
        }).map((slot) => instantToLocal(slot.startMs, NZ).minuteOfDay);
      expect(local('2026-04-04')).toEqual(local('2026-04-06'));
      expect(local('2026-04-05')).toEqual(local('2026-04-06'));
    });
  });

  describe('September 2026: daylight saving starts (02:00 NZST becomes 03:00 NZDT on 27 September)', () => {
    it('moves a skipped wall time forward by the gap', () => {
      expect(iso(localTimeToInstant('2026-09-27', 150, NZ))).toBe('2026-09-26T14:30:00.000Z');
      expect(instantToLocal(localTimeToInstant('2026-09-27', 150, NZ), NZ).minuteOfDay).toBe(210);
      expect(iso(localTimeToInstant('2026-09-27', 9 * 60, NZ))).toBe('2026-09-26T20:00:00.000Z');
      expect(iso(localTimeToInstant('2026-09-26', 9 * 60, NZ))).toBe('2026-09-25T21:00:00.000Z');
    });

    it('makes that local day 23 hours long', () => {
      const [day] = workingIntervalsForDate('2026-09-27', NZ, ALL_DAY);
      expect((day!.endMs - day!.startMs) / 3_600_000).toBe(23);
    });

    it('never offers the skipped hour', () => {
      const slots = availableSlots({
        date: '2026-09-27',
        timeZone: NZ,
        workingHours: [{ weekday: 0, startMinute: 60, endMinute: 240 }],
        busy: [],
        durationMinutes: 30,
        bufferMinutes: 0,
      });
      expect(slots.map((slot) => instantToLocal(slot.startMs, NZ).minuteOfDay)).toEqual([
        60, 90, 180, 210,
      ]);
    });

    it('an appointment spanning the change lasts its real duration', () => {
      const start = localTimeToInstant('2026-09-27', 90, NZ);
      const [slot] = availableSlots({
        date: '2026-09-27',
        timeZone: NZ,
        workingHours: [{ weekday: 0, startMinute: 90, endMinute: 270 }],
        busy: [],
        durationMinutes: 60,
        bufferMinutes: 0,
      });
      expect(slot!.startMs).toBe(start);
      expect(instantToLocal(slot!.endMs, NZ).minuteOfDay).toBe(210);
    });
  });
});

describe('working hours and availability', () => {
  it('validates rules', () => {
    expect(workingHoursErrors(DEFAULT_WORKING_HOURS)).toEqual([]);
    expect(workingHoursErrors([{ weekday: 7, startMinute: 0, endMinute: 60 }])).toHaveLength(1);
    expect(workingHoursErrors([{ weekday: 1, startMinute: 600, endMinute: 600 }])).toHaveLength(1);
    expect(
      workingHoursErrors([
        { weekday: 1, startMinute: 420, endMinute: 720 },
        { weekday: 1, startMinute: 700, endMinute: 1020 },
      ]),
    ).toEqual(['Working-hours ranges on the same day must not overlap.']);
  });

  it('has no slots on a day without working hours', () => {
    expect(
      availableSlots({
        date: '2026-10-18', // Sunday
        timeZone: NZ,
        workingHours: DEFAULT_WORKING_HOURS,
        busy: [],
        durationMinutes: 60,
        bufferMinutes: 0,
      }),
    ).toEqual([]);
  });

  it('removes slots that clash with bookings once the buffer is applied', () => {
    const date = '2026-10-20';
    const nine = localTimeToInstant(date, 540, NZ);
    const booked: BusyInterval = { id: 'a', startMs: nine, endMs: nine + 3_600_000 };
    const starts = (bufferMinutes: number) =>
      availableSlots({
        date,
        timeZone: NZ,
        workingHours: [{ weekday: 2, startMinute: 420, endMinute: 720 }],
        busy: [booked],
        durationMinutes: 60,
        bufferMinutes,
      }).map((slot) => instantToLocal(slot.startMs, NZ).minuteOfDay / 60);
    expect(starts(0)).toEqual([7, 7.5, 8, 10, 10.5, 11]);
    expect(starts(30)).toEqual([7, 7.5, 10.5, 11]);
  });

  it('skips slots before the not-before instant and splits ranges around a lunch break', () => {
    const date = '2026-10-20';
    const slots = availableSlots({
      date,
      timeZone: NZ,
      workingHours: [
        { weekday: 2, startMinute: 480, endMinute: 720 },
        { weekday: 2, startMinute: 780, endMinute: 900 },
      ],
      busy: [],
      durationMinutes: 120,
      bufferMinutes: 0,
      stepMinutes: 60,
      notBeforeMs: localTimeToInstant(date, 540, NZ),
    });
    expect(slots.map((slot) => instantToLocal(slot.startMs, NZ).minuteOfDay / 60)).toEqual([
      9, 10, 13,
    ]);
  });

  it('checks whether an appointment sits inside working hours', () => {
    const start = localTimeToInstant('2026-10-20', 16 * 60, NZ);
    expect(
      isWithinWorkingHours({ startMs: start, endMs: start + 3_600_000 }, NZ, DEFAULT_WORKING_HOURS),
    ).toBe(true);
    expect(
      isWithinWorkingHours(
        { startMs: start, endMs: start + 2 * 3_600_000 },
        NZ,
        DEFAULT_WORKING_HOURS,
      ),
    ).toBe(false);
  });

  it('rejects silly durations', () => {
    const base = {
      date: '2026-10-20',
      timeZone: NZ,
      workingHours: DEFAULT_WORKING_HOURS,
      busy: [],
      bufferMinutes: 0,
    };
    expect(() => availableSlots({ ...base, durationMinutes: 0 })).toThrow(RangeError);
    expect(() => availableSlots({ ...base, durationMinutes: 17 * 60 })).toThrow(RangeError);
  });
});

describe('slot proposals', () => {
  it('proposes the first free slots, moving past full days and weekends', () => {
    // Friday 23 October 2026 is fully booked.
    const friday = '2026-10-23';
    const fullDay: BusyInterval = {
      id: 'full',
      startMs: localTimeToInstant(friday, 420, NZ),
      endMs: localTimeToInstant(friday, 1020, NZ),
    };
    const slots = proposeSlots({
      fromDate: friday,
      days: 7,
      count: 3,
      timeZone: NZ,
      workingHours: DEFAULT_WORKING_HOURS,
      busy: [fullDay],
      durationMinutes: 120,
      bufferMinutes: 15,
      stepMinutes: 60,
    });
    expect(slots.map((slot) => instantToLocal(slot.startMs, NZ))).toEqual([
      { date: '2026-10-26', minuteOfDay: 420, weekday: 1 },
      { date: '2026-10-26', minuteOfDay: 480, weekday: 1 },
      { date: '2026-10-26', minuteOfDay: 540, weekday: 1 },
    ]);
  });

  it('returns fewer slots when the search window runs out', () => {
    expect(
      proposeSlots({
        fromDate: '2026-10-24',
        days: 2,
        count: 3,
        timeZone: NZ,
        workingHours: DEFAULT_WORKING_HOURS,
        busy: [],
        durationMinutes: 60,
        bufferMinutes: 0,
      }),
    ).toEqual([]);
    expect(() =>
      proposeSlots({
        fromDate: '2026-10-24',
        days: 40,
        count: 3,
        timeZone: NZ,
        workingHours: DEFAULT_WORKING_HOURS,
        busy: [],
        durationMinutes: 60,
        bufferMinutes: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe('reminder timing', () => {
  const now = at('2026-10-19T00:00:00Z');
  it('is due 24 hours before by default', () => {
    expect(iso(reminderDueAt(at('2026-10-22T00:00:00Z'), now)!)).toBe('2026-10-21T00:00:00.000Z');
  });
  it('is due now when the lead time has passed but the appointment is not imminent', () => {
    expect(reminderDueAt(at('2026-10-19T05:00:00Z'), now)).toBe(now);
  });
  it('is skipped when the appointment is too close or in the past', () => {
    expect(reminderDueAt(at('2026-10-19T00:30:00Z'), now)).toBeNull();
    expect(reminderDueAt(at('2026-10-18T00:00:00Z'), now)).toBeNull();
  });
  it('builds stable dedupe keys per schedule version', () => {
    expect(appointmentReminderKey('abc', 2)).toBe('appointment:abc:v2:customer_24h');
  });
});
