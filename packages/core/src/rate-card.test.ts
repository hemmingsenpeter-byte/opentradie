import { describe, expect, it } from 'vitest';
import {
  centsToPriceText,
  diffRateCard,
  formatRatesCsv,
  parsePriceToCents,
  parseRateCardCsv,
} from './rate-card.js';

const HEADER = 'code,description,unit,price_excl_gst_nzd';

describe('parsePriceToCents', () => {
  it.each([
    ['$1,234.50', 123_450],
    ['85', 8_500],
    ['85.5', 8_550],
    ['85.05', 8_505],
    [' 0 ', 0],
    ['$ 12', 1_200],
    ['10,000,000.00', 1_000_000_000],
    ['0.1', 10],
  ])('%s -> %i cents', (text, cents) => {
    expect(parsePriceToCents(text)).toEqual({ ok: true, cents });
  });

  it.each([
    '-5',
    '$-5',
    '(5.00)',
    '',
    '1.234',
    '1,23',
    '12,34.00',
    'abc',
    '1e3',
    '10,000,000.01',
    '123456789',
  ])('rejects %j', (text) => {
    expect(parsePriceToCents(text).ok).toBe(false);
  });

  it('round-trips through the CSV text form', () => {
    for (const cents of [0, 5, 50, 8_550, 123_450, 1_000_000_000])
      expect(parsePriceToCents(centsToPriceText(cents))).toEqual({ ok: true, cents });
  });
});

describe('parseRateCardCsv', () => {
  it('reads the template format, including quoted descriptions and a BOM', () => {
    const csv = `\uFEFF${HEADER}\r\ncall_out,Call-out fee (per visit),visit,95\r\npower_point_replace,"Replace double power point, ""supply"" and install",each,"$1,234.50"\r\n`;
    const result = parseRateCardCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.priceColumn).toBe('price_excl_gst_nzd');
    expect(result.rates).toEqual([
      { code: 'call_out', label: 'Call-out fee (per visit)', unit: 'visit', unitPriceCents: 9_500 },
      {
        code: 'power_point_replace',
        label: 'Replace double power point, "supply" and install',
        unit: 'each',
        unitPriceCents: 123_450,
      },
    ]);
  });

  it('reports every bad row and returns no rates', () => {
    const csv = [
      HEADER,
      'labour_hour,Labour,hour,110',
      'labour_hour,Labour again,hour,120',
      'Bad Code,Thing,each,10',
      'm2_tile,Tiling,m2,40',
      'neg,Negative,each,-1',
      'huge,Too much,each,"10,000,000.01"',
      'blank,Template row left empty,each,',
    ].join('\n');
    const result = parseRateCardCsv(csv);
    expect(result.rates).toEqual([]);
    const byLine = Object.fromEntries(result.errors.map((e) => [e.line, e.message]));
    expect(byLine[3]).toMatch(/duplicate of line 2/);
    expect(byLine[4]).toMatch(/lower-case/);
    expect(byLine[5]).toMatch(/must be one of: each, hour, visit/);
    expect(byLine[6]).toMatch(/negative/);
    expect(byLine[7]).toMatch(/maximum/);
    expect(byLine[8]).toMatch(/empty/);
  });

  it('rejects a sheet without the template columns', () => {
    expect(parseRateCardCsv('code,label,price\nx1,y,1').errors[0]!.message).toMatch(
      /first row must name/,
    );
    expect(parseRateCardCsv(HEADER).errors[0]!.message).toMatch(/no rates/);
  });

  it('rejects an exclusive sheet for a business that enters prices inclusive', () => {
    const result = parseRateCardCsv(`${HEADER}\ncall_out,Call-out,visit,95`, {
      pricesEntered: 'inclusive',
    });
    expect(result.errors[0]!.message).toMatch(/price_incl_gst_nzd/);
    expect(
      parseRateCardCsv('code,description,unit,price_nzd\ncall_out,Call-out,visit,95', {
        pricesEntered: 'inclusive',
      }).errors,
    ).toEqual([]);
  });

  it('formats rates back to a CSV the parser accepts unchanged', () => {
    const rates = [
      {
        code: 'a_rate',
        label: 'Has, comma and "quotes"',
        unit: 'each' as const,
        unitPriceCents: 1_005,
      },
    ];
    expect(parseRateCardCsv(formatRatesCsv(rates, 'price_excl_gst_nzd')).rates).toEqual(rates);
  });
});

describe('diffRateCard', () => {
  it('classifies creates, updates, unchanged, missing and retired codes; never retires', () => {
    const current = [
      { code: 'keep', label: 'Keep', unit: 'each' as const, unitPriceCents: 100, active: true },
      { code: 'change', label: 'Change', unit: 'each' as const, unitPriceCents: 100, active: true },
      { code: 'gone', label: 'Gone', unit: 'each' as const, unitPriceCents: 100, active: true },
      { code: 'old', label: 'Old', unit: 'hour' as const, unitPriceCents: 100, active: false },
    ];
    const diff = diffRateCard(current, [
      { code: 'keep', label: 'Keep', unit: 'each', unitPriceCents: 100 },
      { code: 'change', label: 'Change', unit: 'each', unitPriceCents: 150 },
      { code: 'old', label: 'Old', unit: 'hour', unitPriceCents: 100 },
      { code: 'new_one', label: 'New', unit: 'visit', unitPriceCents: 9_000 },
    ]);
    expect(diff.create.map((r) => r.code)).toEqual(['new_one']);
    expect(diff.update).toEqual([
      expect.objectContaining({ code: 'change', fields: ['unitPriceCents'] }),
    ]);
    expect(diff.unchanged).toEqual(['keep', 'old']);
    expect(diff.notInFile).toEqual(['gone']);
    expect(diff.retiredInFile).toEqual(['old']);
  });
});
