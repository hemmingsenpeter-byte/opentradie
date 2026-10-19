import { MAX_AMOUNT_CENTS } from './money.js';

/**
 * Line pricing engine.
 *
 * - Money is integer cents. Quantities are fixed-point thousandths ("milli-units"):
 *   1.5 hours is `quantityMilli: 1500`. Neither ever touches floating point arithmetic;
 *   every product and quotient is computed with BigInt and checked back into the safe range.
 * - Every rounding step uses round-half-away-from-zero to the cent (see
 *   `divideRoundHalfAwayFromZero`). For non-negative values this is ordinary "half up".
 * - Every line records where its price came from (`PriceSource`). Agents never supply prices:
 *   `approved_rate` comes from the owner-approved rate card, `cost_plus_markup` from a recorded
 *   cost and an owner-approved markup, and `owner_entered` only from an authenticated owner edit.
 */

/** Quantity scale: quantities are stored as integer thousandths of a unit. */
export const QUANTITY_SCALE = 1000;
/** Largest quantity accepted on a line: 10,000 units (10,000,000 thousandths). */
export const MAX_QUANTITY_MILLI = 10_000 * QUANTITY_SCALE;
/** Largest markup accepted: 1000% (100,000 basis points). */
export const MAX_MARKUP_BASIS_POINTS = 100_000;

export type LineKind = 'labour' | 'material' | 'fee' | 'discount';
export type PriceSource = 'approved_rate' | 'cost_plus_markup' | 'owner_entered';
/** GST treatment of a line: standard-rated (e.g. 15%), zero-rated (0%) or exempt (not a taxable supply). */
export type TaxCode = 'standard' | 'zero_rated' | 'exempt';
export type LineUnit = 'each' | 'hour' | 'visit' | 'metre' | 'square_metre' | 'litre' | 'kilogram';

export const LINE_KINDS: readonly LineKind[] = ['labour', 'material', 'fee', 'discount'];
export const TAX_CODES: readonly TaxCode[] = ['standard', 'zero_rated', 'exempt'];

export type LinePrice =
  /** Unit price copied from an owner-approved rate record. */
  | { source: 'approved_rate'; rateCode: string; unitPriceCents: number }
  /** Material sell price derived from a recorded cost and an owner-approved markup. */
  | { source: 'cost_plus_markup'; costCents: number; markupBasisPoints: number }
  /**
   * A price typed by the business owner. The API must set `enteredByUserId` from the
   * authenticated owner session only; agent proposals can never produce this source.
   */
  | {
      source: 'owner_entered';
      unitPriceCents: number;
      enteredByRole: 'owner';
      enteredByUserId: string;
    };

export interface LineInput {
  kind: LineKind;
  description: string;
  unit: LineUnit;
  /** Integer thousandths of a unit, 1..MAX_QUANTITY_MILLI. */
  quantityMilli: number;
  price: LinePrice;
  taxCode: TaxCode;
  /** Optional line-level discount in basis points (0..10000). Not allowed on discount lines. */
  lineDiscountBasisPoints?: number;
}

export interface PricedLine {
  kind: LineKind;
  description: string;
  unit: LineUnit;
  quantityMilli: number;
  taxCode: TaxCode;
  priceSource: PriceSource;
  /** Rate code when the price came from the approved rate card. */
  rateCode: string | null;
  /** Unit price in cents; always non-negative (discount lines are negated at the amount). */
  unitPriceCents: number;
  /** quantity × unit price, rounded once half away from zero. Non-negative. */
  grossCents: number;
  lineDiscountBasisPoints: number;
  /** Line discount in cents (non-negative), rounded half away from zero. */
  lineDiscountCents: number;
  /** Signed line amount: gross − line discount, negated for discount lines. */
  amountCents: number;
}

/**
 * Integer division rounding half away from zero: 2.5 → 3, −2.5 → −3, 2.4999 → 2.
 * `denominator` must be positive.
 */
export function divideRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be positive.');
  const quotient = numerator / denominator; // truncates toward zero
  const remainder = numerator % denominator; // carries the sign of the numerator
  const magnitude = remainder < 0n ? -remainder : remainder;
  if (magnitude * 2n >= denominator) return numerator < 0n ? quotient - 1n : quotient + 1n;
  return quotient;
}

/** Convert a BigInt amount back to a number, rejecting anything beyond ±MAX_AMOUNT_CENTS. */
export function toSignedSafeCents(value: bigint, label = 'amount'): number {
  const limit = BigInt(MAX_AMOUNT_CENTS);
  if (value > limit || value < -limit)
    throw new RangeError(`${label} exceeds the supported range.`);
  return Number(value);
}

function assertNonNegativeCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_AMOUNT_CENTS)
    throw new RangeError(`${label} must be a non-negative whole number of cents.`);
}

function assertBasisPoints(value: number, label: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max)
    throw new RangeError(`${label} must be a whole number of basis points between 0 and ${max}.`);
}

export function assertQuantityMilli(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_QUANTITY_MILLI)
    throw new RangeError(
      `quantity must be a positive whole number of thousandths no greater than ${MAX_QUANTITY_MILLI}.`,
    );
  return value;
}

/** Convert a whole-unit quantity to thousandths. */
export function quantityToMilli(quantity: number): number {
  if (!Number.isSafeInteger(quantity)) throw new RangeError('quantity must be a whole number.');
  return assertQuantityMilli(quantity * QUANTITY_SCALE);
}

/** Sell unit price = cost × (10000 + markup) / 10000, rounded half away from zero. */
export function costPlusMarkupCents(costCents: number, markupBasisPoints: number): number {
  assertNonNegativeCents(costCents, 'cost');
  assertBasisPoints(markupBasisPoints, 'markup', MAX_MARKUP_BASIS_POINTS);
  return toSignedSafeCents(
    divideRoundHalfAwayFromZero(BigInt(costCents) * BigInt(10_000 + markupBasisPoints), 10_000n),
    'sell price',
  );
}

/** Line gross = quantityMilli × unitPriceCents / 1000, rounded half away from zero. */
export function extendCents(quantityMilli: number, unitPriceCents: number): number {
  assertQuantityMilli(quantityMilli);
  assertNonNegativeCents(unitPriceCents, 'unit price');
  return toSignedSafeCents(
    divideRoundHalfAwayFromZero(
      BigInt(quantityMilli) * BigInt(unitPriceCents),
      BigInt(QUANTITY_SCALE),
    ),
    'line amount',
  );
}

function resolveUnitPrice(line: LineInput): { unitPriceCents: number; rateCode: string | null } {
  const price = line.price;
  switch (price.source) {
    case 'approved_rate':
      if (typeof price.rateCode !== 'string' || price.rateCode.length === 0)
        throw new RangeError('approved-rate lines must name the rate code.');
      assertNonNegativeCents(price.unitPriceCents, `rate ${price.rateCode}`);
      return { unitPriceCents: price.unitPriceCents, rateCode: price.rateCode };
    case 'cost_plus_markup':
      if (line.kind !== 'material')
        throw new RangeError('cost-plus-markup pricing is only for material lines.');
      return {
        unitPriceCents: costPlusMarkupCents(price.costCents, price.markupBasisPoints),
        rateCode: null,
      };
    case 'owner_entered':
      if (price.enteredByRole !== 'owner' || !price.enteredByUserId)
        throw new RangeError('owner-entered prices need an authenticated owner.');
      assertNonNegativeCents(price.unitPriceCents, 'owner-entered price');
      return { unitPriceCents: price.unitPriceCents, rateCode: null };
    default:
      throw new RangeError('unknown price source.');
  }
}

/** Price one line deterministically. Throws RangeError on any invalid or out-of-range input. */
export function priceLine(line: LineInput): PricedLine {
  if (!LINE_KINDS.includes(line.kind)) throw new RangeError('unknown line kind.');
  if (!TAX_CODES.includes(line.taxCode)) throw new RangeError('unknown tax code.');
  if (typeof line.description !== 'string' || line.description.trim().length === 0)
    throw new RangeError('every line needs a description.');
  assertQuantityMilli(line.quantityMilli);
  const discountBasisPoints = line.lineDiscountBasisPoints ?? 0;
  assertBasisPoints(discountBasisPoints, 'line discount', 10_000);
  if (line.kind === 'discount' && discountBasisPoints !== 0)
    throw new RangeError('a discount line cannot carry its own line discount.');

  const { unitPriceCents, rateCode } = resolveUnitPrice(line);
  const grossCents = extendCents(line.quantityMilli, unitPriceCents);
  const lineDiscountCents = toSignedSafeCents(
    divideRoundHalfAwayFromZero(BigInt(grossCents) * BigInt(discountBasisPoints), 10_000n),
  );
  const net = grossCents - lineDiscountCents;
  return {
    kind: line.kind,
    description: line.description.trim(),
    unit: line.unit,
    quantityMilli: line.quantityMilli,
    taxCode: line.taxCode,
    priceSource: line.price.source,
    rateCode,
    unitPriceCents,
    grossCents,
    lineDiscountBasisPoints: discountBasisPoints,
    lineDiscountCents,
    amountCents: line.kind === 'discount' ? -net : net,
  };
}

/**
 * Check approved-rate lines against the current rate card: the rate must exist and the price
 * on the line must equal the approved price. Returns human-readable problems (empty if fine).
 */
export function approvedRateMismatches(
  lines: readonly LineInput[],
  approvedRates: readonly { code: string; unitPriceCents: number }[],
): string[] {
  const card = new Map(approvedRates.map((rate) => [rate.code, rate.unitPriceCents]));
  const problems: string[] = [];
  for (const line of lines) {
    if (line.price.source !== 'approved_rate') continue;
    const approved = card.get(line.price.rateCode);
    if (approved === undefined)
      problems.push(`Rate "${line.price.rateCode}" is not an approved, active rate.`);
    else if (approved !== line.price.unitPriceCents)
      problems.push(`Rate "${line.price.rateCode}" price differs from the approved rate card.`);
  }
  return problems;
}

/** Format thousandths as a quantity with up to three decimals: 1500 → "1.5", 1000 → "1". */
export function formatQuantityMilli(quantityMilli: number): string {
  if (!Number.isSafeInteger(quantityMilli)) throw new RangeError('quantity must be an integer.');
  const negative = quantityMilli < 0;
  const magnitude = Math.abs(quantityMilli);
  const whole = Math.trunc(magnitude / QUANTITY_SCALE);
  const fraction = String(magnitude % QUANTITY_SCALE)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Signed NZD display ("-$12.50") for document lines; the API itself returns integer cents. */
export function formatSignedCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError('amount must be whole cents.');
  const negative = cents < 0;
  const magnitude = BigInt(Math.abs(cents));
  const whole = new Intl.NumberFormat('en-NZ', { maximumFractionDigits: 0 }).format(
    magnitude / 100n,
  );
  const fraction = (magnitude % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}$${whole}.${fraction}`;
}
