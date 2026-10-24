/**
 * New Zealand GST registration numbers.
 *
 * A GST number is the business's IRD number. Validation follows Inland Revenue's published
 * IRD number check-digit algorithm (the "IRD number validation" section of the IR payroll and
 * RWT/NRWT software specifications):
 *
 *   1. The number is 8 or 9 digits and lies between 10,000,000 and 150,000,000 (exclusive).
 *   2. Remove the trailing check digit and left-pad the remaining base number to 8 digits.
 *   3. Multiply each digit by the primary weights 3,2,7,6,5,4,3,2 and sum the products.
 *      remainder = sum mod 11. If remainder is 0 the check digit is 0, else 11 − remainder.
 *   4. If that result is 10, repeat with the secondary weights 7,4,3,2,5,2,7,6; a second
 *      result of 10 means the number is invalid.
 *   5. The calculated check digit must equal the trailing digit.
 *
 * Numbers are stored as plain digits and displayed as NN-NNN-NNN or NNN-NNN-NNN.
 */

const PRIMARY_WEIGHTS = [3, 2, 7, 6, 5, 4, 3, 2] as const;
const SECONDARY_WEIGHTS = [7, 4, 3, 2, 5, 2, 7, 6] as const;

function checkDigit(base: string, weights: readonly number[]): number {
  const sum = [...base].reduce((total, digit, index) => total + Number(digit) * weights[index]!, 0);
  const remainder = sum % 11;
  return remainder === 0 ? 0 : 11 - remainder;
}

/** Strip spaces and hyphens. Returns null unless what remains is 8 or 9 digits. */
export function normaliseGstNumber(value: string): string | null {
  const digits = value.replace(/[\s-]/g, '');
  return /^\d{8,9}$/.test(digits) ? digits : null;
}

/** True when `value` (with or without separators) is a valid IRD/GST number. */
export function isValidNzGstNumber(value: string): boolean {
  const digits = normaliseGstNumber(value);
  if (!digits) return false;
  const number = Number(digits);
  if (number <= 10_000_000 || number >= 150_000_000) return false;
  const base = digits.slice(0, -1).padStart(8, '0');
  const expected = Number(digits.at(-1));
  let calculated = checkDigit(base, PRIMARY_WEIGHTS);
  if (calculated === 10) calculated = checkDigit(base, SECONDARY_WEIGHTS);
  return calculated !== 10 && calculated === expected;
}

/** "49091850" → "49-091-850"; "136410132" → "136-410-132". Input must be normalised digits. */
export function formatNzGstNumber(digits: string): string {
  if (!/^\d{8,9}$/.test(digits)) throw new RangeError('GST number must be 8 or 9 digits.');
  return `${digits.slice(0, -6)}-${digits.slice(-6, -3)}-${digits.slice(-3)}`;
}
