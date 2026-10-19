import type { DraftInvoiceLine, LineAmountMode, TaxCode } from './types.js';

/**
 * MOCK ONLY. Totals arithmetic used by the fake adapter and the fake Xero SDK so contract tests
 * have deterministic expectations: per-line amount and per-line tax, each rounded half-up to the
 * cent with bigint. Real providers calculate tax with their own rules; OPENTRADIE always reads
 * the provider's totals back rather than trusting this function.
 */
export const MOCK_TAX_BASIS_POINTS: Record<TaxCode, number> = {
  standard: 1500,
  zero_rated: 0,
  exempt: 0,
};

function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export function mockLineTotals(
  lines: readonly Pick<DraftInvoiceLine, 'quantityMilli' | 'unitAmountCents' | 'taxCode'>[],
  mode: LineAmountMode,
): { subtotalCents: number; taxCents: number; totalCents: number } {
  let subtotal = 0n;
  let tax = 0n;
  for (const line of lines) {
    const amount = divideHalfUp(BigInt(line.quantityMilli) * BigInt(line.unitAmountCents), 1000n);
    const bp = BigInt(mode === 'no_tax' ? 0 : MOCK_TAX_BASIS_POINTS[line.taxCode]);
    if (mode === 'inclusive') {
      const lineTax = divideHalfUp(amount * bp, 10_000n + bp);
      tax += lineTax;
      subtotal += amount - lineTax;
    } else {
      tax += divideHalfUp(amount * bp, 10_000n);
      subtotal += amount;
    }
  }
  return {
    subtotalCents: Number(subtotal),
    taxCents: Number(tax),
    totalCents: Number(subtotal + tax),
  };
}
