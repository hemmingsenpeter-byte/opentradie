/** Money is always an integer number of cents. Floating point never touches an amount. */
export const MAX_AMOUNT_CENTS = 1_000_000_000_000; // NZD 10 billion; far above any sole-trader quote.

export function assertCents(value: number, label = 'amount'): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_AMOUNT_CENTS) {
    throw new RangeError(`${label} must be a non-negative whole number of cents.`);
  }
  return value;
}

/** Multiply cents by an integer quantity using bigint so overflow is impossible to miss. */
export function multiplyCents(unitPriceCents: number, quantity: number): number {
  assertCents(unitPriceCents, 'unit price');
  if (!Number.isSafeInteger(quantity) || quantity <= 0)
    throw new RangeError('quantity must be a positive whole number.');
  return toSafeCents(BigInt(unitPriceCents) * BigInt(quantity));
}

export function sumCents(values: readonly number[]): number {
  return toSafeCents(values.reduce((sum, value) => sum + BigInt(assertCents(value)), 0n));
}

/**
 * Tax in basis points (1500 = 15%), rounded half-up once on the tax-exclusive subtotal.
 * The rounding rule is a stated business assumption, shown on every quote.
 */
export function taxOnSubtotal(subtotalCents: number, taxBasisPoints: number): number {
  assertCents(subtotalCents, 'subtotal');
  if (!Number.isInteger(taxBasisPoints) || taxBasisPoints < 0 || taxBasisPoints > 10_000) {
    throw new RangeError('tax rate must be between 0 and 10000 basis points.');
  }
  return toSafeCents((BigInt(subtotalCents) * BigInt(taxBasisPoints) + 5_000n) / 10_000n);
}

function toSafeCents(value: bigint): number {
  if (value < 0n || value > BigInt(MAX_AMOUNT_CENTS))
    throw new RangeError('Amount exceeds the supported range.');
  return Number(value);
}

/** Display helper for logs and documents; the API always returns integer cents. */
export function formatCents(cents: number, currency = 'NZD', locale = 'en-NZ'): string {
  assertCents(cents);
  const whole = BigInt(cents) / 100n;
  const fraction = BigInt(cents) % 100n;
  const grouped = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(whole);
  const symbol = currency === 'NZD' ? '$' : `${currency} `;
  return `${symbol}${grouped}.${fraction.toString().padStart(2, '0')}`;
}
