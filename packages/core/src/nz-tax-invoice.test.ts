import { describe, expect, it } from 'vitest';
import {
  documentTitle,
  isPlausibleGstNumber,
  taxableSupplyInformationRequirements,
  taxableSupplyTier,
  type TaxableSupplyDocument,
} from './nz-tax-invoice.js';

const complete: TaxableSupplyDocument = {
  gstRegistered: true,
  title: 'Tax invoice',
  supplierName: 'Kowhai Electrical Ltd',
  supplierGstNumber: '123-456-789',
  date: '2026-10-19',
  recipient: { name: 'Aroha Smith', address: '12 Example Street, Wellington' },
  lines: [{ description: 'Replace power point', quantityMilli: 2_000 }],
  totalInclCents: 150_000,
  showsGstAmount: true,
  statesTotalIncludesGst: true,
  showsExclusiveTotal: true,
};
const bare: TaxableSupplyDocument = {
  gstRegistered: true,
  title: 'Tax invoice',
  lines: [{}],
  totalInclCents: 0,
  showsGstAmount: false,
  statesTotalIncludesGst: false,
};

describe('document titles', () => {
  it('only GST-registered invoices are tax invoices; quotes never are', () => {
    expect(documentTitle('invoice', true)).toBe('Tax invoice');
    expect(documentTitle('invoice', false)).toBe('Invoice');
    expect(documentTitle('quote', true)).toBe('Quote');
    expect(documentTitle('quote', false)).toBe('Quote');
  });
});

describe('TSI thresholds (GST-inclusive)', () => {
  it.each([
    [0, 'none'],
    [20_000, 'none'], // exactly $200.00
    [20_001, 'up_to_1000'], // $200.01
    [100_000, 'up_to_1000'], // exactly $1,000.00
    [100_001, 'over_1000'], // $1,000.01
  ])('%i cents → %s', (cents, tier) => {
    expect(taxableSupplyTier(cents, true)).toBe(tier);
    expect(taxableSupplyTier(cents, false)).toBe('not_registered');
  });
  it('rejects invalid totals', () => {
    expect(() => taxableSupplyTier(-1, true)).toThrow();
    expect(() => taxableSupplyTier(1.5, true)).toThrow();
  });

  it('$200.00 needs no taxable supply information', () => {
    expect(taxableSupplyInformationRequirements({ ...bare, totalInclCents: 20_000 })).toEqual({
      tier: 'none',
      missing: [],
      problems: [],
    });
  });
  it('$200.01 needs supplier, GST number, date, description, and GST amount or statement', () => {
    expect(
      taxableSupplyInformationRequirements({ ...bare, totalInclCents: 20_001 }).missing,
    ).toEqual([
      'supplier name',
      'supplier GST number',
      'date of invoice or time of supply',
      'description of the goods and services',
      'GST amount or a statement that the total includes GST',
    ]);
  });
  it('$1,000.00 is satisfied by a statement instead of the GST amount', () => {
    const check = taxableSupplyInformationRequirements({
      ...complete,
      recipient: null,
      lines: [{ description: 'Labour' }],
      totalInclCents: 100_000,
      showsGstAmount: false,
      statesTotalIncludesGst: true,
    });
    expect(check).toEqual({ tier: 'up_to_1000', missing: [], problems: [] });
  });
  it('$1,000.01 additionally needs recipient, identifier, quantity and the GST amount', () => {
    expect(
      taxableSupplyInformationRequirements({ ...bare, totalInclCents: 100_001 }).missing,
    ).toEqual([
      'supplier name',
      'supplier GST number',
      'date of invoice or time of supply',
      'description of the goods and services',
      'recipient name',
      'recipient identifier (address, phone, email, NZBN, trading name or website)',
      'quantity or volume of the goods and services',
      'GST amount',
      'GST-exclusive total, or a statement that the total includes GST',
    ]);
    expect(taxableSupplyInformationRequirements({ ...complete, totalInclCents: 100_001 })).toEqual({
      tier: 'over_1000',
      missing: [],
      problems: [],
    });
  });
  it('accepts any one recipient identifier and either GST presentation over $1,000', () => {
    for (const identifier of ['phone', 'email', 'nzbn', 'tradingName', 'website'])
      expect(
        taxableSupplyInformationRequirements({
          ...complete,
          recipient: { name: 'Aroha Smith', [identifier]: 'x' },
        }).missing,
      ).toEqual([]);
    expect(
      taxableSupplyInformationRequirements({ ...complete, statesTotalIncludesGst: false }).missing,
    ).toEqual([]);
    expect(
      taxableSupplyInformationRequirements({
        ...complete,
        statesTotalIncludesGst: false,
        showsExclusiveTotal: false,
      }).missing,
    ).toEqual(['GST-exclusive total, or a statement that the total includes GST']);
    expect(
      taxableSupplyInformationRequirements({ ...complete, showsGstAmount: false }).missing,
    ).toEqual(['GST amount']);
  });
  it('flags blank descriptions and missing quantities on any line', () => {
    const check = taxableSupplyInformationRequirements({
      ...complete,
      lines: [
        { description: 'Labour', quantityMilli: 1_000 },
        { description: ' ', quantityMilli: null },
      ],
    });
    expect(check.missing).toEqual([
      'description of the goods and services',
      'quantity or volume of the goods and services',
    ]);
  });
});

describe('not GST-registered', () => {
  it('requires nothing but forbids GST, GST numbers and the tax invoice title', () => {
    expect(
      taxableSupplyInformationRequirements({
        ...bare,
        gstRegistered: false,
        title: 'Invoice',
        totalInclCents: 500_000,
      }),
    ).toEqual({ tier: 'not_registered', missing: [], problems: [] });
    expect(
      taxableSupplyInformationRequirements({ ...complete, gstRegistered: false }).problems,
    ).toHaveLength(3);
  });
  it('flags an implausible GST number', () => {
    expect(isPlausibleGstNumber('123-456-789')).toBe(true);
    expect(isPlausibleGstNumber('12345678')).toBe(true);
    expect(isPlausibleGstNumber('1234')).toBe(false);
    expect(
      taxableSupplyInformationRequirements({ ...complete, supplierGstNumber: 'GST123' }).problems,
    ).toEqual(['Supplier GST number is not 8 or 9 digits.']);
  });
});
