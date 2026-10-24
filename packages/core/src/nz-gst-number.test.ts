import { describe, expect, it } from 'vitest';
import { formatNzGstNumber, isValidNzGstNumber, normaliseGstNumber } from './nz-gst-number.js';

describe('NZ GST (IRD) number validation', () => {
  it('accepts the valid examples from the Inland Revenue specification', () => {
    // 49091850 and 35901981 use the primary weights; 49098576 too; 136410132 needs the
    // secondary weights (primary check digit would be 10).
    for (const valid of ['49091850', '35901981', '49098576', '136410132', '49-091-850'])
      expect(isValidNzGstNumber(valid), valid).toBe(true);
  });

  it('rejects the invalid examples and malformed input', () => {
    for (const invalid of [
      '136410133', // wrong check digit
      '9125568', // too short (7 digits)
      '10000000', // not above the lower bound
      '150000000', // not below the upper bound
      '49091851',
      '4909185O',
      '',
      '49 091 85',
    ])
      expect(isValidNzGstNumber(invalid), invalid).toBe(false);
  });

  it('rejects a number whose secondary check digit is also 10', () => {
    // Exhaustively find bases where both weightings give 10 and confirm none validates.
    let found = 0;
    for (let base = 1_000_000; base < 1_100_000 && found < 3; base += 1) {
      const digits = Array.from({ length: 10 }, (_, d) => `${base}${d}`);
      if (digits.every((candidate) => !isValidNzGstNumber(candidate))) found += 1;
    }
    expect(found).toBeGreaterThan(0);
  });

  it('normalises and formats', () => {
    expect(normaliseGstNumber(' 49-091-850 ')).toBe('49091850');
    expect(normaliseGstNumber('49-091-85')).toBeNull();
    expect(formatNzGstNumber('49091850')).toBe('49-091-850');
    expect(formatNzGstNumber('136410132')).toBe('136-410-132');
    expect(() => formatNzGstNumber('123')).toThrow(RangeError);
  });
});
