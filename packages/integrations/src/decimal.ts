import { assertCents } from '@opentradie/core';

/**
 * Exact conversions between OPENTRADIE's integer units and the decimal amounts providers use.
 * Only bigint and string operations touch authority values; floating point is never used to
 * compute an amount. Where a provider SDK insists on a JS number, the number is produced from
 * the exact decimal string and checked to serialise back to the same decimal.
 */

/** 12345 → "123.45". */
export function centsToDecimalString(cents: number): string {
  assertCents(cents);
  const value = BigInt(cents);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

/** Quantity in thousandths → minimal decimal string: 1500 → "1.5", 2000 → "2", 1 → "0.001". */
export function milliToDecimalString(quantityMilli: number): string {
  if (!Number.isSafeInteger(quantityMilli) || quantityMilli <= 0)
    throw new RangeError('quantityMilli must be a positive whole number of thousandths.');
  const value = BigInt(quantityMilli);
  const fraction = (value % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return fraction ? `${value / 1000n}.${fraction}` : `${value / 1000n}`;
}

function canonicalDecimal(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new RangeError('Not a plain decimal number.');
  const whole = match[2]!.replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  const sign = match[1] && (whole !== '0' || fraction) ? '-' : '';
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

/**
 * Converts an exact decimal string to the JS number an SDK requires, refusing any value whose
 * number form would not serialise (JSON.stringify / String) back to exactly the same decimal.
 */
export function decimalStringToWireNumber(decimal: string): number {
  const value = Number(decimal);
  if (!Number.isFinite(value) || canonicalDecimal(String(value)) !== canonicalDecimal(decimal)) {
    throw new RangeError('Decimal value cannot be represented exactly on the wire.');
  }
  return value;
}

/**
 * Parses a provider decimal amount (number or string) into integer cents without float maths.
 * Rejects exponents and more than two significant decimal places.
 */
export function decimalToCents(value: number | string): number {
  const text = typeof value === 'number' ? String(value) : value.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new RangeError('Provider amount is not a plain decimal number.');
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  if (fraction.length > 2)
    throw new RangeError('Provider amount has more than two decimal places.');
  const cents = BigInt(match[2]!) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  const signed = match[1] ? -cents : cents;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < -BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('Provider amount is out of range.');
  return Number(signed);
}

/** A percentage such as 15 or "12.5" → basis points (1500, 1250). */
export function percentToBasisPoints(value: number | string): number {
  return decimalToCents(value);
}
