import { MAX_AMOUNT_CENTS } from './money.js';
import {
  divideRoundHalfAwayFromZero,
  priceLine,
  toSignedSafeCents,
  type LineInput,
  type PricedLine,
  type TaxCode,
} from './pricing.js';

/**
 * Document-level GST.
 *
 * Rounding rule (stated on documents, tested in tax.test.ts):
 *   1. Each line amount is rounded to the cent first (see pricing.ts).
 *   2. Line amounts are summed per tax code. GST is then calculated ONCE per tax-code group,
 *      never per line, and rounded half away from zero to the cent:
 *        - prices entered exclusive of GST: groupTax = round(groupNet × rate / 10000)
 *        - prices entered inclusive of GST: groupTax = round(groupGross × rate / (10000 + rate))
 *          (the "tax fraction": 3/23 at 15%), and groupNet = groupGross − groupTax.
 *      Zero-rated and exempt groups carry no GST.
 *   3. totalTax = Σ groupTax; totalIncl = subtotalExcl + totalTax. This invariant is asserted.
 *
 * Exclusive and inclusive entry round on different bases. At 15% every exclusive amount x
 * round-trips exactly (x + GST entered inclusive yields the same GST; tested over a wide range),
 * but an inclusive amount that no exclusive amount produces can carry one cent more GST than its
 * net would attract if entered exclusive: $0.04 inclusive → GST 1c, net 3c (3c exclusive → 0c).
 *
 * A business that is not GST-registered charges no GST at all: every amount is the final
 * amount, no tax breakdown is produced, and documents must not show GST or "Tax invoice".
 */

export interface TaxSettings {
  gstRegistered: boolean;
  /** Whether line prices are entered exclusive or inclusive of GST. Ignored when not registered. */
  pricesEntered: 'exclusive' | 'inclusive';
  /** Standard GST rate in basis points (NZ: 1500 = 15%). Configurable; 0..10000. */
  standardRateBasisPoints: number;
}

export const NZ_GST_STANDARD_RATE_BASIS_POINTS = 1500;

export interface TaxGroup {
  taxCode: TaxCode;
  rateBasisPoints: number;
  /** Sum of this group's amounts, excluding GST. */
  netCents: number;
  taxCents: number;
  /** netCents + taxCents. */
  grossCents: number;
}

export interface DocumentTotals {
  gstRegistered: boolean;
  pricesEntered: 'exclusive' | 'inclusive';
  lines: PricedLine[];
  /** Groups in fixed order standard, zero_rated, exempt; only codes used by a line. Empty when not registered. */
  taxByCode: TaxGroup[];
  subtotalExclCents: number;
  totalTaxCents: number;
  totalInclCents: number;
}

function rateFor(code: TaxCode, settings: TaxSettings): number {
  return code === 'standard' ? settings.standardRateBasisPoints : 0;
}

/** GST contained in a GST-inclusive amount: round(amount × rate / (10000 + rate)). */
export function taxFractionOfInclusive(inclusiveCents: number, rateBasisPoints: number): number {
  return toSignedSafeCents(
    divideRoundHalfAwayFromZero(
      BigInt(inclusiveCents) * BigInt(rateBasisPoints),
      BigInt(10_000 + rateBasisPoints),
    ),
  );
}

/** GST on a GST-exclusive amount: round(amount × rate / 10000). */
export function taxOnExclusive(exclusiveCents: number, rateBasisPoints: number): number {
  return toSignedSafeCents(
    divideRoundHalfAwayFromZero(BigInt(exclusiveCents) * BigInt(rateBasisPoints), 10_000n),
  );
}

function assertTotal(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_AMOUNT_CENTS)
    throw new RangeError(`${label} must be between $0 and the supported maximum.`);
}

/** Price every line and compute document totals. Pure and deterministic. */
export function computeDocumentTotals(
  inputs: readonly LineInput[],
  settings: TaxSettings,
): DocumentTotals {
  if (
    !Number.isSafeInteger(settings.standardRateBasisPoints) ||
    settings.standardRateBasisPoints < 0 ||
    settings.standardRateBasisPoints > 10_000
  )
    throw new RangeError('tax rate must be between 0 and 10000 basis points.');
  if (settings.pricesEntered !== 'exclusive' && settings.pricesEntered !== 'inclusive')
    throw new RangeError('pricesEntered must be exclusive or inclusive.');

  const lines = inputs.map(priceLine);
  const sums = new Map<TaxCode, bigint>();
  for (const line of lines)
    sums.set(line.taxCode, (sums.get(line.taxCode) ?? 0n) + BigInt(line.amountCents));

  if (!settings.gstRegistered) {
    const total = toSignedSafeCents(
      [...sums.values()].reduce((sum, value) => sum + value, 0n),
      'total',
    );
    assertTotal(total, 'document total');
    return {
      gstRegistered: false,
      pricesEntered: settings.pricesEntered,
      lines,
      taxByCode: [],
      subtotalExclCents: total,
      totalTaxCents: 0,
      totalInclCents: total,
    };
  }

  const taxByCode: TaxGroup[] = [];
  for (const code of ['standard', 'zero_rated', 'exempt'] as const) {
    const sum = sums.get(code);
    if (sum === undefined) continue;
    const entered = toSignedSafeCents(sum, `${code} total`);
    // A group cannot go negative: discounts may not exceed the charges they discount.
    assertTotal(entered, `${code.replace('_', '-')} total after discounts`);
    const rate = rateFor(code, settings);
    let netCents: number;
    let taxCents: number;
    if (settings.pricesEntered === 'exclusive') {
      netCents = entered;
      taxCents = taxOnExclusive(entered, rate);
    } else {
      taxCents = taxFractionOfInclusive(entered, rate);
      netCents = entered - taxCents;
    }
    const grossCents = toSignedSafeCents(BigInt(netCents) + BigInt(taxCents), `${code} total`);
    taxByCode.push({ taxCode: code, rateBasisPoints: rate, netCents, taxCents, grossCents });
  }

  const subtotal = taxByCode.reduce((sum, group) => sum + BigInt(group.netCents), 0n);
  const tax = taxByCode.reduce((sum, group) => sum + BigInt(group.taxCents), 0n);
  const totals: DocumentTotals = {
    gstRegistered: true,
    pricesEntered: settings.pricesEntered,
    lines,
    taxByCode,
    subtotalExclCents: toSignedSafeCents(subtotal, 'subtotal'),
    totalTaxCents: toSignedSafeCents(tax, 'GST'),
    totalInclCents: toSignedSafeCents(subtotal + tax, 'total'),
  };
  assertTotal(totals.totalInclCents, 'document total');
  assertTotalsInvariant(totals);
  return totals;
}

/** total = subtotal + tax, and the per-code groups add up. Throws if violated. */
export function assertTotalsInvariant(totals: DocumentTotals): void {
  const groupNet = totals.taxByCode.reduce((sum, group) => sum + group.netCents, 0);
  const groupTax = totals.taxByCode.reduce((sum, group) => sum + group.taxCents, 0);
  const ok =
    totals.totalInclCents === totals.subtotalExclCents + totals.totalTaxCents &&
    (!totals.gstRegistered ||
      (groupNet === totals.subtotalExclCents && groupTax === totals.totalTaxCents)) &&
    (totals.gstRegistered || totals.totalTaxCents === 0);
  if (!ok) throw new Error('Document totals invariant violated.');
}
