import { describe, expect, it } from 'vitest';
import { MAX_AMOUNT_CENTS } from './money.js';
import { divideRoundHalfAwayFromZero, type LineInput, type TaxCode } from './pricing.js';
import { computeDocumentTotals, type TaxSettings } from './tax.js';

const registered: TaxSettings = {
  gstRegistered: true,
  pricesEntered: 'exclusive',
  standardRateBasisPoints: 1500,
};
const inclusive: TaxSettings = { ...registered, pricesEntered: 'inclusive' };
const unregistered: TaxSettings = { ...registered, gstRegistered: false };

function line(
  unitPriceCents: number,
  taxCode: TaxCode = 'standard',
  quantityMilli = 1_000,
  kind: LineInput['kind'] = 'fee',
): LineInput {
  return {
    kind,
    description: `${kind} ${unitPriceCents}`,
    unit: 'each',
    quantityMilli,
    price: { source: 'approved_rate', rateCode: 'rate', unitPriceCents },
    taxCode,
  };
}

describe('GST-exclusive pricing', () => {
  it('prices a mixed labour and material quote', () => {
    const totals = computeDocumentTotals(
      [
        line(11_000, 'standard', 1_500, 'labour'),
        {
          kind: 'material',
          description: 'Switch',
          unit: 'each',
          quantityMilli: 10_000,
          price: { source: 'cost_plus_markup', costCents: 1_000, markupBasisPoints: 2_500 },
          taxCode: 'standard',
        },
      ],
      registered,
    );
    expect(totals.lines.map((l) => l.amountCents)).toEqual([16_500, 12_500]);
    expect(totals).toMatchObject({
      subtotalExclCents: 29_000,
      totalTaxCents: 4_350,
      totalInclCents: 33_350,
    });
  });
  it('taxes once per tax-code group, not per line', () => {
    // Per line: 0.45c → 0c each. Per group: 6c × 15% = 0.9c → 1c.
    const totals = computeDocumentTotals([line(3), line(3)], registered);
    expect(totals.totalTaxCents).toBe(1);
    expect(totals.totalInclCents).toBe(7);
  });
  it('rounds .5 cent of GST half away from zero', () => {
    expect(computeDocumentTotals([line(10)], registered).totalTaxCents).toBe(2); // 1.5c
    expect(computeDocumentTotals([line(30)], registered).totalTaxCents).toBe(5); // 4.5c
    expect(computeDocumentTotals([line(3)], registered).totalTaxCents).toBe(0); // 0.45c
    expect(
      computeDocumentTotals([line(100)], { ...registered, standardRateBasisPoints: 1250 })
        .totalTaxCents,
    ).toBe(13); // 12.5c
  });
  it('mixes standard, zero-rated and exempt lines', () => {
    const totals = computeDocumentTotals(
      [line(2_000, 'exempt'), line(10_000), line(5_000, 'zero_rated')],
      registered,
    );
    expect(totals.taxByCode).toEqual([
      {
        taxCode: 'standard',
        rateBasisPoints: 1500,
        netCents: 10_000,
        taxCents: 1_500,
        grossCents: 11_500,
      },
      {
        taxCode: 'zero_rated',
        rateBasisPoints: 0,
        netCents: 5_000,
        taxCents: 0,
        grossCents: 5_000,
      },
      { taxCode: 'exempt', rateBasisPoints: 0, netCents: 2_000, taxCents: 0, grossCents: 2_000 },
    ]);
    expect(totals).toMatchObject({
      subtotalExclCents: 17_000,
      totalTaxCents: 1_500,
      totalInclCents: 18_500,
    });
  });
  it('applies discount lines before GST within their group', () => {
    const totals = computeDocumentTotals(
      [line(10_000), { ...line(2_000), kind: 'discount' }],
      registered,
    );
    expect(totals).toMatchObject({ subtotalExclCents: 8_000, totalTaxCents: 1_200 });
  });
  it('rejects discounts larger than the group they discount', () => {
    expect(() =>
      computeDocumentTotals([line(1_000), { ...line(2_000), kind: 'discount' }], registered),
    ).toThrow(/after discounts/);
    expect(() =>
      computeDocumentTotals(
        [line(10_000), { ...line(2_000, 'zero_rated'), kind: 'discount' }],
        registered,
      ),
    ).toThrow(/zero-rated/);
  });
  it('supports a configurable or zero standard rate and rejects invalid ones', () => {
    expect(
      computeDocumentTotals([line(10_000)], { ...registered, standardRateBasisPoints: 0 })
        .totalTaxCents,
    ).toBe(0);
    for (const bad of [-1, 10_001, 15.5])
      expect(() =>
        computeDocumentTotals([line(1)], { ...registered, standardRateBasisPoints: bad }),
      ).toThrow(RangeError);
  });
  it('allows an empty document', () => {
    expect(computeDocumentTotals([], registered)).toMatchObject({
      taxByCode: [],
      subtotalExclCents: 0,
      totalTaxCents: 0,
      totalInclCents: 0,
    });
  });
});

describe('GST-inclusive pricing', () => {
  it('extracts GST with the tax fraction rate / (10000 + rate)', () => {
    const totals = computeDocumentTotals([line(11_500)], inclusive);
    expect(totals).toMatchObject({
      subtotalExclCents: 10_000,
      totalTaxCents: 1_500,
      totalInclCents: 11_500,
    });
  });
  it('rounds the extracted GST half away from zero', () => {
    // 4c × 3/23 = 0.52c → 1c GST, net 3c.
    expect(computeDocumentTotals([line(4)], inclusive)).toMatchObject({
      subtotalExclCents: 3,
      totalTaxCents: 1,
    });
    // 3c × 3/23 = 0.39c → 0c.
    expect(computeDocumentTotals([line(3)], inclusive).totalTaxCents).toBe(0);
    // $1,000.00 inclusive: 100000 × 1500 / 11500 = 13043.478 → 13043.
    expect(computeDocumentTotals([line(100_000)], inclusive)).toMatchObject({
      subtotalExclCents: 86_957,
      totalTaxCents: 13_043,
    });
    // 46c × 3/23 = 6.0c exactly; 23c × 3/23 = 3c; 50c × 3/23 = 6.52c → 7c.
    expect(computeDocumentTotals([line(46)], inclusive).totalTaxCents).toBe(6);
    expect(computeDocumentTotals([line(50)], inclusive).totalTaxCents).toBe(7);
  });
  it('round-trips exactly with exclusive entry at 15%', () => {
    for (let net = 0; net <= 20_000; net += 7) {
      const exclusive = computeDocumentTotals(net ? [line(net)] : [], registered);
      const back = computeDocumentTotals(
        exclusive.totalInclCents ? [line(exclusive.totalInclCents)] : [],
        inclusive,
      );
      expect([back.subtotalExclCents, back.totalTaxCents]).toEqual([
        exclusive.subtotalExclCents,
        exclusive.totalTaxCents,
      ]);
    }
  });
  it('is equivalent across a mixed zero-rated / exempt document', () => {
    const exclusive = computeDocumentTotals(
      [line(10_000), line(5_000, 'zero_rated'), line(2_000, 'exempt')],
      registered,
    );
    const incl = computeDocumentTotals(
      [line(11_500), line(5_000, 'zero_rated'), line(2_000, 'exempt')],
      inclusive,
    );
    expect(incl.taxByCode).toEqual(exclusive.taxByCode);
    expect(incl.totalInclCents).toBe(exclusive.totalInclCents);
  });
});

describe('not GST-registered', () => {
  it('charges no GST and produces no tax breakdown', () => {
    for (const settings of [
      unregistered,
      { ...unregistered, pricesEntered: 'inclusive' as const },
    ]) {
      const totals = computeDocumentTotals([line(10_000), line(5_000, 'exempt')], settings);
      expect(totals).toMatchObject({
        gstRegistered: false,
        taxByCode: [],
        subtotalExclCents: 15_000,
        totalTaxCents: 0,
        totalInclCents: 15_000,
      });
    }
  });
  it('still rejects a negative total', () => {
    expect(() =>
      computeDocumentTotals([line(1), { ...line(2), kind: 'discount' }], unregistered),
    ).toThrow(RangeError);
  });
});

describe('range guards', () => {
  it('rejects totals beyond the supported maximum', () => {
    expect(() =>
      computeDocumentTotals([line(MAX_AMOUNT_CENTS), line(MAX_AMOUNT_CENTS)], registered),
    ).toThrow(RangeError);
    expect(() => computeDocumentTotals([line(MAX_AMOUNT_CENTS)], registered)).toThrow(RangeError); // GST pushes the total over
    expect(computeDocumentTotals([line(MAX_AMOUNT_CENTS)], inclusive).totalInclCents).toBe(
      MAX_AMOUNT_CENTS,
    );
  });
});

describe('invariants (deterministic pseudo-random inputs)', () => {
  // Park–Miller LCG: reproducible without a dependency.
  function random(seed: number) {
    let state = seed;
    return (max: number) => {
      state = (state * 48_271) % 2_147_483_647;
      return state % max;
    };
  }
  const codes: TaxCode[] = ['standard', 'zero_rated', 'exempt'];

  it('holds total = subtotal + tax and per-group rounding for 1000 documents', () => {
    const next = random(20_261_019);
    for (let i = 0; i < 1_000; i++) {
      const lines: LineInput[] = [];
      const count = 1 + next(8);
      for (let j = 0; j < count; j++) {
        const kind = (['labour', 'material', 'fee'] as const)[next(3)]!;
        lines.push({
          kind,
          description: `line ${j}`,
          unit: 'each',
          quantityMilli: 1 + next(50_000),
          price:
            kind === 'material' && next(2) === 0
              ? {
                  source: 'cost_plus_markup',
                  costCents: next(100_000),
                  markupBasisPoints: next(10_000),
                }
              : { source: 'approved_rate', rateCode: 'r', unitPriceCents: next(500_000) },
          taxCode: codes[next(3)]!,
          lineDiscountBasisPoints: next(4) === 0 ? next(10_001) : 0,
        });
      }
      const settings: TaxSettings = {
        gstRegistered: next(5) !== 0,
        pricesEntered: next(2) === 0 ? 'exclusive' : 'inclusive',
        standardRateBasisPoints: next(3) === 0 ? next(3_001) : 1500,
      };
      const totals = computeDocumentTotals(lines, settings);
      const values = [totals.subtotalExclCents, totals.totalTaxCents, totals.totalInclCents];
      for (const value of values) {
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
      expect(totals.totalInclCents).toBe(totals.subtotalExclCents + totals.totalTaxCents);
      const entered = totals.lines.reduce((sum, l) => sum + l.amountCents, 0);
      if (!settings.gstRegistered) {
        expect(totals.totalTaxCents).toBe(0);
        expect(totals.totalInclCents).toBe(entered);
        continue;
      }
      expect(
        settings.pricesEntered === 'exclusive' ? totals.subtotalExclCents : totals.totalInclCents,
      ).toBe(entered);
      for (const group of totals.taxByCode) {
        const rate = BigInt(group.rateBasisPoints);
        if (group.taxCode !== 'standard') expect(group.taxCents).toBe(0);
        if (settings.pricesEntered === 'exclusive') {
          expect(BigInt(group.taxCents)).toBe(
            divideRoundHalfAwayFromZero(BigInt(group.netCents) * rate, 10_000n),
          );
        } else {
          // GST is within one cent of the net × rate.
          const error = BigInt(group.taxCents) * 10_000n - BigInt(group.netCents) * rate;
          expect(error < 10_000n && error > -10_000n).toBe(true);
        }
      }
    }
  });
});
