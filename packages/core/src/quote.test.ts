import { describe, expect, it } from 'vitest';
import { formatCents, multiplyCents, sumCents, taxOnSubtotal } from './money.js';
import { approvalBlockers, calculateQuote, formatBasisPoints, type ApprovedRate } from './quote.js';

const rates: ApprovedRate[] = [
  { code: 'call_out', label: 'Call-out', unit: 'visit', unitPriceCents: 9_500 },
  { code: 'labour_hour', label: 'Labour', unit: 'hour', unitPriceCents: 11_000 },
  {
    code: 'power_point_replace',
    label: 'Replace power point',
    unit: 'each',
    unitPriceCents: 8_900,
  },
];
const gst = { taxBasisPoints: 1500, taxLabel: 'GST', callOutRateCode: 'call_out' };

describe('money', () => {
  it('rounds tax half up once on the subtotal', () => {
    expect(taxOnSubtotal(27_300, 1500)).toBe(4_095);
    expect(taxOnSubtotal(1, 1500)).toBe(0); // 0.15c
    expect(taxOnSubtotal(3, 1500)).toBe(0); // 0.45c
    expect(taxOnSubtotal(4, 1500)).toBe(1); // 0.6c
    expect(taxOnSubtotal(10, 1250)).toBe(1); // 1.25c
    expect(taxOnSubtotal(100, 1250)).toBe(13); // 12.5c rounds half up
    expect(taxOnSubtotal(12_345, 0)).toBe(0);
  });
  it('rejects fractional cents and overflow instead of drifting', () => {
    expect(() => multiplyCents(10.5, 2)).toThrow();
    expect(() => multiplyCents(100, 1.5)).toThrow();
    expect(() => multiplyCents(1_000_000_000_000, 2)).toThrow();
    expect(() => sumCents([-1])).toThrow();
    expect(() => taxOnSubtotal(100, 10_001)).toThrow();
  });
  it('formats NZD for documents', () => {
    expect(formatCents(31_395)).toBe('$313.95');
    expect(formatCents(123_456_789)).toBe('$1,234,567.89');
    expect(formatBasisPoints(1500)).toBe('15%');
    expect(formatBasisPoints(1250)).toBe('12.5%');
  });
});

describe('calculateQuote', () => {
  it('prices the canonical demo deterministically, adding the call-out rule once', () => {
    const quote = calculateQuote({
      requested: [{ rateCode: 'power_point_replace', quantity: 2 }],
      approvedRates: rates,
      policy: gst,
    });
    expect(quote.lines.map((line) => [line.rateCode, line.quantity, line.lineTotalCents])).toEqual([
      ['power_point_replace', 2, 17_800],
      ['call_out', 1, 9_500],
    ]);
    expect([quote.subtotalCents, quote.taxCents, quote.totalCents]).toEqual([
      27_300, 4_095, 31_395,
    ]);
    expect(quote.missingInformation).toEqual([]);
    expect(
      quote.assumptions.some((assumption) => assumption.includes('Call-out is charged once')),
    ).toBe(true);
  });

  it('merges repeated rates and keeps arithmetic integer', () => {
    const quote = calculateQuote({
      requested: [
        { rateCode: 'labour_hour', quantity: 1 },
        { rateCode: 'labour_hour', quantity: 2 },
        { rateCode: 'call_out', quantity: 1 },
      ],
      approvedRates: rates,
      policy: gst,
    });
    expect(quote.lines).toHaveLength(2);
    expect(quote.subtotalCents).toBe(42_500);
    expect(quote.totalCents).toBe(48_875);
    expect(Number.isInteger(quote.taxCents)).toBe(true);
  });

  it('never invents a price: missing rate or quantity becomes missing information', () => {
    const quote = calculateQuote({
      requested: [
        { rateCode: null, quantity: 1, description: 'Heat pump service' },
        { rateCode: 'power_point_replace', quantity: null },
        { rateCode: 'invented_rate', quantity: 1 },
      ],
      approvedRates: rates,
      policy: gst,
    });
    expect(quote.lines).toEqual([]);
    expect(quote.totalCents).toBe(0);
    expect(quote.missingInformation.join('\n')).toMatch(
      /No approved rate covers "Heat pump service"/,
    );
    expect(quote.missingInformation.join('\n')).toMatch(
      /Confirm the quantity for "Replace power point"/,
    );
    expect(quote.missingInformation.join('\n')).toMatch(/"invented_rate" is not an approved/);
    expect(quote.missingInformation.join('\n')).toMatch(/No priced work yet/);
  });

  it('flags a call-out rule that points at an unapproved rate', () => {
    const quote = calculateQuote({
      requested: [{ rateCode: 'labour_hour', quantity: 1 }],
      approvedRates: rates.filter((rate) => rate.code !== 'call_out'),
      policy: gst,
    });
    expect(quote.missingInformation.join(' ')).toMatch(/call-out rule/);
  });

  it('supports a configurable tax rate (locale/tax are business settings)', () => {
    const quote = calculateQuote({
      requested: [{ rateCode: 'labour_hour', quantity: 1 }],
      approvedRates: rates,
      policy: { taxBasisPoints: 1250, taxLabel: 'VAT', callOutRateCode: null },
    });
    expect(quote.taxCents).toBe(1_375);
    expect(quote.assumptions.join(' ')).toMatch(/VAT at 12.5%/);
  });

  it('rejects malformed rate cards', () => {
    expect(() =>
      calculateQuote({
        requested: [],
        approvedRates: [{ ...rates[0]!, unitPriceCents: 1.5 }],
        policy: gst,
      }),
    ).toThrow();
  });
});

describe('approval blockers', () => {
  it('only complete drafts can be approved', () => {
    expect(approvalBlockers({ status: 'draft', lineCount: 2, missingInformation: [] })).toEqual([]);
    expect(approvalBlockers({ status: 'draft', lineCount: 0, missingInformation: [] })).not.toEqual(
      [],
    );
    expect(
      approvalBlockers({ status: 'draft', lineCount: 1, missingInformation: ['x'] }),
    ).not.toEqual([]);
    expect(
      approvalBlockers({ status: 'approved', lineCount: 1, missingInformation: [] }),
    ).not.toEqual([]);
  });
});
