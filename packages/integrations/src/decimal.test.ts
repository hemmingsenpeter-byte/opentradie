import { describe, expect, it } from 'vitest';
import {
  centsToDecimalString,
  decimalStringToWireNumber,
  decimalToCents,
  milliToDecimalString,
  percentToBasisPoints,
} from './decimal.js';

describe('exact decimal conversion', () => {
  it('formats cents and thousandths exactly', () => {
    expect([0, 5, 10, 199, 12_345, 1_000_000_000_000].map(centsToDecimalString)).toEqual([
      '0.00',
      '0.05',
      '0.10',
      '1.99',
      '123.45',
      '10000000000.00',
    ]);
    expect(() => centsToDecimalString(1.5)).toThrow(RangeError);
    expect(() => centsToDecimalString(-1)).toThrow(RangeError);
    expect([1, 10, 250, 1000, 1500, 123_456].map(milliToDecimalString)).toEqual([
      '0.001',
      '0.01',
      '0.25',
      '1',
      '1.5',
      '123.456',
    ]);
    expect(() => milliToDecimalString(0)).toThrow(RangeError);
  });

  it('only produces wire numbers that serialise back to the same decimal', () => {
    for (let cents = 0; cents < 100_000; cents += 7) {
      const decimal = centsToDecimalString(cents);
      expect(decimalToCents(JSON.stringify(decimalStringToWireNumber(decimal)))).toBe(cents);
    }
    expect(decimalStringToWireNumber('0.10')).toBe(0.1);
    expect(() => decimalStringToWireNumber('12345678901234567.89')).toThrow(RangeError);
  });

  it('parses provider amounts without float maths', () => {
    expect(decimalToCents(196.62)).toBe(19_662);
    expect(decimalToCents(0.3)).toBe(30);
    expect(decimalToCents('19.1300')).toBe(1_913);
    expect(decimalToCents(-4.5)).toBe(-450);
    expect(() => decimalToCents('1.005')).toThrow(/two decimal/);
    expect(() => decimalToCents(1e21)).toThrow(RangeError);
    expect(() => decimalToCents('abc')).toThrow(RangeError);
    expect(percentToBasisPoints(15)).toBe(1500);
    expect(percentToBasisPoints('12.5')).toBe(1250);
  });
});
