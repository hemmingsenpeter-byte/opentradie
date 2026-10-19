import { describe, expect, it } from 'vitest';
import { MAX_AMOUNT_CENTS } from './money.js';
import {
  approvedRateMismatches,
  costPlusMarkupCents,
  divideRoundHalfAwayFromZero,
  extendCents,
  formatQuantityMilli,
  formatSignedCents,
  MAX_QUANTITY_MILLI,
  priceLine,
  quantityToMilli,
  type LineInput,
} from './pricing.js';

const labour = (quantityMilli: number, unitPriceCents = 11_000): LineInput => ({
  kind: 'labour',
  description: 'Labour',
  unit: 'hour',
  quantityMilli,
  price: { source: 'approved_rate', rateCode: 'labour_hour', unitPriceCents },
  taxCode: 'standard',
});

describe('divideRoundHalfAwayFromZero', () => {
  it.each([
    [5n, 2n, 3n],
    [-5n, 2n, -3n],
    [4n, 2n, 2n],
    [7n, 3n, 2n],
    [8n, 3n, 3n],
    [-7n, 3n, -2n],
    [-8n, 3n, -3n],
    [0n, 5n, 0n],
    [1n, 2n, 1n],
    [-1n, 2n, -1n],
    [2_499n, 1_000n, 2n],
    [2_500n, 1_000n, 3n],
    [-2_500n, 1_000n, -3n],
    [-2_499n, 1_000n, -2n],
  ])('%s / %s = %s', (n, d, expected) => {
    expect(divideRoundHalfAwayFromZero(n, d)).toBe(expected);
  });
  it('rejects non-positive denominators', () => {
    expect(() => divideRoundHalfAwayFromZero(1n, 0n)).toThrow(RangeError);
    expect(() => divideRoundHalfAwayFromZero(1n, -1n)).toThrow(RangeError);
  });
});

describe('fractional quantities', () => {
  it('extends quantity thousandths × cents with one half-away rounding', () => {
    expect(extendCents(1_500, 11_000)).toBe(16_500); // 1.5 h × $110
    expect(extendCents(333, 100)).toBe(33); // 0.333 × $1 = 33.3c
    expect(extendCents(500, 1)).toBe(1); // 0.5c → 1c
    expect(extendCents(1_500, 3)).toBe(5); // 4.5c → 5c
    expect(extendCents(2_500, 1)).toBe(3); // 2.5c → 3c
    expect(extendCents(1, 500)).toBe(1); // 0.5c → 1c
    expect(extendCents(1, 499)).toBe(0); // 0.499c → 0c
    expect(extendCents(1, 1)).toBe(0);
    expect(extendCents(250, 8_950)).toBe(2_238); // 2237.5c → 2238c
  });
  it('converts whole quantities and validates thousandths', () => {
    expect(quantityToMilli(3)).toBe(3_000);
    expect(() => quantityToMilli(1.5)).toThrow(RangeError);
    for (const bad of [0, -1, 1.5, Number.NaN, MAX_QUANTITY_MILLI + 1])
      expect(() => extendCents(bad, 100)).toThrow(RangeError);
    expect(extendCents(MAX_QUANTITY_MILLI, 1)).toBe(10_000);
  });
  it('rejects overflow instead of losing precision', () => {
    expect(extendCents(1_000, MAX_AMOUNT_CENTS)).toBe(MAX_AMOUNT_CENTS);
    expect(() => extendCents(1_001, MAX_AMOUNT_CENTS)).toThrow(RangeError);
    expect(() => extendCents(MAX_QUANTITY_MILLI, MAX_AMOUNT_CENTS)).toThrow(RangeError);
    expect(() => extendCents(1_000, MAX_AMOUNT_CENTS + 1)).toThrow(RangeError);
    expect(() => extendCents(1_000, -1)).toThrow(RangeError);
    expect(() => extendCents(1_000, 10.5)).toThrow(RangeError);
  });
});

describe('cost plus markup', () => {
  it('computes sell price deterministically, rounding half away from zero', () => {
    expect(costPlusMarkupCents(1_000, 2_500)).toBe(1_250);
    expect(costPlusMarkupCents(999, 2_500)).toBe(1_249); // 1248.75
    expect(costPlusMarkupCents(1, 5_000)).toBe(2); // 1.5
    expect(costPlusMarkupCents(3, 5_000)).toBe(5); // 4.5
    expect(costPlusMarkupCents(10, 1_500)).toBe(12); // 11.5
    expect(costPlusMarkupCents(333, 1_500)).toBe(383); // 382.95
    expect(costPlusMarkupCents(1_234, 0)).toBe(1_234);
    expect(costPlusMarkupCents(100, 100_000)).toBe(1_100); // 1000% markup
  });
  it('rejects negative, fractional or excessive markup and cost', () => {
    expect(() => costPlusMarkupCents(100, -1)).toThrow(RangeError);
    expect(() => costPlusMarkupCents(100, 100_001)).toThrow(RangeError);
    expect(() => costPlusMarkupCents(100, 12.5)).toThrow(RangeError);
    expect(() => costPlusMarkupCents(-1, 0)).toThrow(RangeError);
    expect(() => costPlusMarkupCents(MAX_AMOUNT_CENTS, 1)).toThrow(RangeError);
  });
  it('prices a material line from cost and markup and records the source', () => {
    const line = priceLine({
      kind: 'material',
      description: 'TPS cable',
      unit: 'metre',
      quantityMilli: 12_500,
      price: { source: 'cost_plus_markup', costCents: 199, markupBasisPoints: 3_000 },
      taxCode: 'standard',
    });
    // 199 × 1.3 = 258.7 → 259c; 12.5 m × 259c = 3237.5 → 3238c
    expect(line).toMatchObject({
      priceSource: 'cost_plus_markup',
      rateCode: null,
      unitPriceCents: 259,
      grossCents: 3_238,
      amountCents: 3_238,
    });
  });
  it('only material lines may be priced from cost', () => {
    expect(() =>
      priceLine({
        ...labour(1_000),
        price: { source: 'cost_plus_markup', costCents: 100, markupBasisPoints: 0 },
      }),
    ).toThrow(/material/);
  });
});

describe('discounts', () => {
  it('applies a line discount in basis points after extension', () => {
    expect(priceLine({ ...labour(1_500), lineDiscountBasisPoints: 1_000 })).toMatchObject({
      grossCents: 16_500,
      lineDiscountCents: 1_650,
      amountCents: 14_850,
    });
    expect(priceLine({ ...labour(1_000, 1_000), lineDiscountBasisPoints: 333 }).amountCents).toBe(
      967,
    ); // 33.3c discount → 33c
    expect(priceLine({ ...labour(1_000, 100), lineDiscountBasisPoints: 50 }).amountCents).toBe(99); // 0.5c → 1c
    expect(priceLine({ ...labour(1_000, 100), lineDiscountBasisPoints: 10_000 }).amountCents).toBe(
      0,
    );
  });
  it('discount lines are explicit and negative', () => {
    const line = priceLine({
      kind: 'discount',
      description: 'Loyal customer discount',
      unit: 'each',
      quantityMilli: 1_000,
      price: {
        source: 'owner_entered',
        unitPriceCents: 5_000,
        enteredByRole: 'owner',
        enteredByUserId: 'user-1',
      },
      taxCode: 'standard',
    });
    expect(line.amountCents).toBe(-5_000);
    expect(line.unitPriceCents).toBe(5_000);
  });
  it('rejects invalid discounts', () => {
    expect(() => priceLine({ ...labour(1_000), lineDiscountBasisPoints: 10_001 })).toThrow();
    expect(() => priceLine({ ...labour(1_000), lineDiscountBasisPoints: -1 })).toThrow();
    expect(() =>
      priceLine({ ...labour(1_000), kind: 'discount', lineDiscountBasisPoints: 100 }),
    ).toThrow(/discount line/);
  });
});

describe('price sources and guards', () => {
  it('records the approved rate code', () => {
    expect(priceLine(labour(1_000))).toMatchObject({
      priceSource: 'approved_rate',
      rateCode: 'labour_hour',
      amountCents: 11_000,
    });
  });
  it('owner-entered prices need an owner identity', () => {
    const base = labour(1_000);
    expect(() =>
      priceLine({
        ...base,
        price: {
          source: 'owner_entered',
          unitPriceCents: 1,
          enteredByRole: 'agent' as 'owner',
          enteredByUserId: 'x',
        },
      }),
    ).toThrow(/owner/);
    expect(() =>
      priceLine({
        ...base,
        price: {
          source: 'owner_entered',
          unitPriceCents: 1,
          enteredByRole: 'owner',
          enteredByUserId: '',
        },
      }),
    ).toThrow(/owner/);
  });
  it('rejects negative prices, unknown kinds, codes and blank descriptions', () => {
    expect(() => priceLine(labour(1_000, -100))).toThrow(RangeError);
    expect(() => priceLine({ ...labour(1_000), kind: 'refund' as 'fee' })).toThrow();
    expect(() => priceLine({ ...labour(1_000), taxCode: 'reduced' as 'standard' })).toThrow();
    expect(() => priceLine({ ...labour(1_000), description: '   ' })).toThrow();
    expect(() =>
      priceLine({ ...labour(1_000), price: { source: 'guess' } as unknown as LineInput['price'] }),
    ).toThrow();
  });
  it('checks approved-rate lines against the rate card', () => {
    const card = [{ code: 'labour_hour', unitPriceCents: 11_000 }];
    expect(approvedRateMismatches([labour(1_000)], card)).toEqual([]);
    expect(approvedRateMismatches([labour(1_000, 9_000)], card)[0]).toMatch(/differs/);
    expect(
      approvedRateMismatches(
        [
          {
            ...labour(1_000),
            price: { source: 'approved_rate', rateCode: 'made_up', unitPriceCents: 1 },
          },
        ],
        card,
      )[0],
    ).toMatch(/not an approved/);
  });
});

describe('formatting', () => {
  it('formats quantities with up to three decimals', () => {
    expect(formatQuantityMilli(1_500)).toBe('1.5');
    expect(formatQuantityMilli(1_000)).toBe('1');
    expect(formatQuantityMilli(1)).toBe('0.001');
    expect(formatQuantityMilli(1_250)).toBe('1.25');
    expect(formatQuantityMilli(120)).toBe('0.12');
    expect(formatQuantityMilli(10_000_000)).toBe('10000');
  });
  it('formats signed cents', () => {
    expect(formatSignedCents(-1_250)).toBe('-$12.50');
    expect(formatSignedCents(0)).toBe('$0.00');
    expect(formatSignedCents(123_456_789)).toBe('$1,234,567.89');
  });
});
