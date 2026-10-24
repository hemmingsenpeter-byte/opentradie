import { describe, expect, it } from 'vitest';
import {
  addLocalPeriod,
  averageConfidence,
  hoursToQuantityMilli,
  parseStatedAmountCents,
  voiceReminderDueAt,
} from './voice-note.js';

describe('voice note date maths (server-computed, never from the model)', () => {
  it('adds days, weeks, months and years with month-end clamping', () => {
    expect(addLocalPeriod('2026-10-20', 1, 'year')).toBe('2027-10-20');
    expect(addLocalPeriod('2028-02-29', 1, 'year')).toBe('2029-02-28');
    expect(addLocalPeriod('2028-02-29', 4, 'year')).toBe('2032-02-29');
    expect(addLocalPeriod('2026-01-31', 1, 'month')).toBe('2026-02-28');
    expect(addLocalPeriod('2027-12-15', 1, 'month')).toBe('2028-01-15');
    expect(addLocalPeriod('2026-12-28', 1, 'week')).toBe('2027-01-04');
    expect(addLocalPeriod('2026-12-31', 1, 'day')).toBe('2027-01-01');
    expect(() => addLocalPeriod('2026-02-30', 1, 'day')).toThrow(RangeError);
    expect(() => addLocalPeriod('2026-01-01', -1, 'day')).toThrow(RangeError);
  });

  it('"next year" is the same local date a year after recording, at 9:00 am business time', () => {
    // Recorded 20 Oct 2026 14:00 NZDT (UTC+13) → 20 Oct 2027 09:00 NZDT.
    const recorded = Date.parse('2026-10-20T01:00:00Z');
    expect(
      voiceReminderDueAt(recorded, 'Pacific/Auckland', {
        kind: 'relative',
        amount: 1,
        unit: 'year',
      }).toISOString(),
    ).toBe('2027-10-19T20:00:00.000Z');
    // Local date, not UTC date: 29 Feb 2028 08:00 NZDT is still 28 Feb in UTC.
    const leap = Date.parse('2028-02-28T19:00:00Z');
    expect(
      voiceReminderDueAt(leap, 'Pacific/Auckland', {
        kind: 'relative',
        amount: 1,
        unit: 'year',
      }).toISOString(),
    ).toBe('2029-02-27T20:00:00.000Z'); // 28 Feb 2029 09:00 NZDT
    // Winter (NZST, UTC+12).
    expect(
      voiceReminderDueAt(recorded, 'Pacific/Auckland', {
        kind: 'absolute',
        date: '2027-06-01',
      }).toISOString(),
    ).toBe('2027-05-31T21:00:00.000Z');
    expect(() =>
      voiceReminderDueAt(recorded, 'Pacific/Auckland', { kind: 'absolute', date: '2027-02-30' }),
    ).toThrow(RangeError);
  });
});

describe('stated amounts and hours', () => {
  it('parses an amount as stated into integer cents, refusing anything ambiguous', () => {
    expect(parseStatedAmountCents('$185')).toBe(18_500);
    expect(parseStatedAmountCents('185 dollars')).toBe(18_500);
    expect(parseStatedAmountCents('$1,234.5')).toBe(123_450);
    expect(parseStatedAmountCents('NZ$ 99.99')).toBe(9_999);
    for (const bad of ['', 'about $185', '$185-$200', '-$5', '$1.234', 'a hundred', '$0', null])
      expect(parseStatedAmountCents(bad), String(bad)).toBeNull();
  });

  it('converts decimal hours to thousandths of an hour', () => {
    expect(hoursToQuantityMilli(1.5)).toBe(1_500);
    expect(hoursToQuantityMilli(0.25)).toBe(250);
    expect(hoursToQuantityMilli(1.0005)).toBeNull();
    expect(hoursToQuantityMilli(0)).toBeNull();
    expect(hoursToQuantityMilli(25)).toBeNull();
    expect(hoursToQuantityMilli(Number.NaN)).toBeNull();
  });

  it('averages known segment confidences by duration', () => {
    expect(averageConfidence([])).toBeNull();
    expect(
      averageConfidence([{ startMs: 0, endMs: 1000, text: 'a', confidence: null }]),
    ).toBeNull();
    expect(
      averageConfidence([
        { startMs: 0, endMs: 3000, text: 'a', confidence: 0.9 },
        { startMs: 3000, endMs: 4000, text: 'b', confidence: 0.5 },
      ]),
    ).toBe(0.8);
  });
});

describe('parseStatedAmountCents on hostile input', () => {
  it('stays linear on very long runs of whitespace', () => {
    const spaces = ' '.repeat(150_000);
    for (const text of [`5${spaces}x`, `nz${spaces}x`, `$${spaces}x`, `${spaces}x`, `5${spaces}`]) {
      const started = performance.now();
      parseStatedAmountCents(text);
      expect(performance.now() - started).toBeLessThan(1000);
    }
    expect(parseStatedAmountCents(`${spaces}$185${spaces}`)).toBe(18_500);
    expect(parseStatedAmountCents(`5${spaces}x`)).toBeNull();
  });

  it('still parses spoken and written amounts', () => {
    expect(parseStatedAmountCents('$185')).toBe(18_500);
    expect(parseStatedAmountCents('185 dollars')).toBe(18_500);
    expect(parseStatedAmountCents(' $1,234.50 ')).toBe(123_450);
    expect(parseStatedAmountCents('NZ$ 99.9')).toBe(9_990);
    expect(parseStatedAmountCents('nz 20 nzd')).toBe(2_000);
    expect(parseStatedAmountCents('$1.234')).toBeNull();
    expect(parseStatedAmountCents('-5')).toBeNull();
    expect(parseStatedAmountCents('about five')).toBeNull();
  });
});
