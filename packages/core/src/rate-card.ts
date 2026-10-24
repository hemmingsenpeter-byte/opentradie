import { approvedRateSchema, rateCodeSchema, type ApprovedRate } from './quote.js';

/**
 * Rate-card CSV: the owner's price list as a spreadsheet (docs/customer-install/rates-template.csv).
 * Shared by `pnpm provision:tenant` and POST /api/rates/import so both accept exactly the same
 * files. Prices are parsed from their decimal text into integer cents with string arithmetic only;
 * no floating-point value ever represents money.
 */

export const RATE_UNITS = approvedRateSchema.shape.unit.options;
export type RateUnit = (typeof RATE_UNITS)[number];

/** approved_rates.unit_price_cents CHECK upper bound ($10,000,000.00). */
export const MAX_RATE_PRICE_CENTS = 1_000_000_000;
export const MAX_RATE_LABEL_LENGTH = 200;
export const MAX_RATE_CARD_ROWS = 500;

/** Price columns: the template's exclusive column, its inclusive twin, or a neutral one. */
export const RATE_PRICE_COLUMNS = {
  price_excl_gst_nzd: 'exclusive',
  price_incl_gst_nzd: 'inclusive',
  price_nzd: 'any',
} as const;
export type RatePriceColumn = keyof typeof RATE_PRICE_COLUMNS;
export const RATE_CSV_COLUMNS = ['code', 'description', 'unit'] as const;

/**
 * Parse a price typed by a person ("$1,234.50", "85", "85.5") into integer cents.
 * Returns an error message instead of guessing: negative, more than two decimals, malformed
 * thousands separators and amounts above the database bound are all rejected.
 */
export function parsePriceToCents(
  input: string,
): { ok: true; cents: number } | { ok: false; error: string } {
  const text = input.trim();
  if (!text) return { ok: false, error: 'Price is empty. Fill in your price or delete the row.' };
  if (/^-|^\$\s*-|^\(/.test(text)) return { ok: false, error: 'Price cannot be negative.' };
  const match = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match)
    return {
      ok: false,
      error: `"${text.slice(0, 40)}" is not a price. Use dollars and cents, e.g. 85 or 1,234.50.`,
    };
  const whole = match[1]!.replaceAll(',', '').replace(/^0+(?=\d)/, '');
  if (whole.length > 8) return { ok: false, error: 'Price is above the $10,000,000.00 maximum.' };
  const cents = Number(whole) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (cents > MAX_RATE_PRICE_CENTS)
    return { ok: false, error: 'Price is above the $10,000,000.00 maximum.' };
  return { ok: true, cents };
}

/** Integer cents to the plain decimal text the CSV uses (no currency symbol, no separators). */
export function centsToPriceText(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF, optional UTF-8 BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new Error('The file ends inside a quoted field.');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

const csvField = (value: string) =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

export function formatRatesCsv(
  rates: readonly (ApprovedRate & { active?: boolean })[],
  priceColumn: RatePriceColumn,
): string {
  const lines = [[...RATE_CSV_COLUMNS, priceColumn].join(',')];
  for (const rate of rates)
    lines.push(
      [rate.code, rate.label, rate.unit, centsToPriceText(rate.unitPriceCents)]
        .map(csvField)
        .join(','),
    );
  return `${lines.join('\r\n')}\r\n`;
}

export interface RateCardError {
  /** 1-based line in the file (the header is line 1); 0 for file-level problems. */
  line: number;
  message: string;
}

export interface RateCardParseResult {
  rates: ApprovedRate[];
  priceColumn: RatePriceColumn | null;
  errors: RateCardError[];
}

/**
 * Validate a rate-card CSV. Every row is checked and every problem reported, so the owner can
 * fix the whole sheet in one pass. Nothing is returned as usable unless the whole file is valid.
 */
export function parseRateCardCsv(
  text: string,
  options: { pricesEntered?: 'exclusive' | 'inclusive' } = {},
): RateCardParseResult {
  const errors: RateCardError[] = [];
  let rows: string[][];
  try {
    rows = parseCsv(text);
  } catch (error) {
    return {
      rates: [],
      priceColumn: null,
      errors: [{ line: 0, message: (error as Error).message }],
    };
  }
  const header = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase());
  const priceColumns = header.filter((h): h is RatePriceColumn => h in RATE_PRICE_COLUMNS);
  const missing = RATE_CSV_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length || priceColumns.length !== 1) {
    errors.push({
      line: 1,
      message: `The first row must name the columns code, description, unit and one price column (${Object.keys(RATE_PRICE_COLUMNS).join(', ')}).${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}`,
    });
    return { rates: [], priceColumn: null, errors };
  }
  const unknown = header.filter(
    (h) => !(RATE_CSV_COLUMNS as readonly string[]).includes(h) && !(h in RATE_PRICE_COLUMNS),
  );
  if (unknown.length)
    errors.push({ line: 1, message: `Unknown column(s): ${unknown.join(', ')}.` });
  const priceColumn = priceColumns[0]!;
  const basis = RATE_PRICE_COLUMNS[priceColumn];
  if (options.pricesEntered && basis !== 'any' && basis !== options.pricesEntered)
    errors.push({
      line: 1,
      message: `The sheet's prices are ${basis} of GST but the business enters prices ${options.pricesEntered} of GST. Use the ${options.pricesEntered === 'exclusive' ? 'price_excl_gst_nzd' : 'price_incl_gst_nzd'} column.`,
    });
  if (rows.length - 1 > MAX_RATE_CARD_ROWS)
    errors.push({ line: 0, message: `At most ${MAX_RATE_CARD_ROWS} rates per file.` });
  const index = (name: string) => header.indexOf(name);
  const seen = new Map<string, number>();
  const rates: ApprovedRate[] = [];
  rows.slice(1, MAX_RATE_CARD_ROWS + 1).forEach((cells, offset) => {
    const line = offset + 2;
    const cell = (name: string) => (cells[index(name)] ?? '').trim();
    const code = cell('code');
    const label = cell('description');
    const unit = cell('unit').toLowerCase();
    const before = errors.length;
    if (!rateCodeSchema.safeParse(code).success)
      errors.push({
        line,
        message: `Code "${code.slice(0, 64)}" must be 2-64 lower-case letters, digits or _, starting with a letter.`,
      });
    else if (seen.has(code))
      errors.push({ line, message: `Code "${code}" is a duplicate of line ${seen.get(code)}.` });
    else seen.set(code, line);
    if (!label) errors.push({ line, message: 'Description is empty.' });
    else if (label.length > MAX_RATE_LABEL_LENGTH)
      errors.push({
        line,
        message: `Description is longer than ${MAX_RATE_LABEL_LENGTH} characters.`,
      });
    if (!(RATE_UNITS as readonly string[]).includes(unit))
      errors.push({
        line,
        message: `Unit "${unit.slice(0, 20)}" must be one of: ${RATE_UNITS.join(', ')}.`,
      });
    const price = parsePriceToCents(cell(priceColumn));
    if (!price.ok) errors.push({ line, message: price.error });
    if (errors.length === before && price.ok)
      rates.push({ code, label, unit: unit as RateUnit, unitPriceCents: price.cents });
  });
  if (rows.length < 2 && !errors.length)
    errors.push({ line: 0, message: 'The file has no rates.' });
  return { rates: errors.length ? [] : rates, priceColumn, errors };
}

export interface RateCardDiff {
  create: ApprovedRate[];
  update: { code: string; before: ApprovedRate; after: ApprovedRate; fields: string[] }[];
  unchanged: string[];
  /** Active rates missing from the file. Import never retires them; the owner does that explicitly. */
  notInFile: string[];
  /** Retired rates present in the file: import updates their values but leaves them retired. */
  retiredInFile: string[];
}

export function diffRateCard(
  current: readonly (ApprovedRate & { active: boolean })[],
  incoming: readonly ApprovedRate[],
): RateCardDiff {
  const byCode = new Map(current.map((rate) => [rate.code, rate]));
  const diff: RateCardDiff = {
    create: [],
    update: [],
    unchanged: [],
    notInFile: [],
    retiredInFile: [],
  };
  const inFile = new Set<string>();
  for (const rate of incoming) {
    inFile.add(rate.code);
    const existing = byCode.get(rate.code);
    if (!existing) {
      diff.create.push(rate);
      continue;
    }
    if (!existing.active) diff.retiredInFile.push(rate.code);
    const fields = (['label', 'unit', 'unitPriceCents'] as const).filter(
      (field) => existing[field] !== rate[field],
    );
    const before: ApprovedRate = {
      code: existing.code,
      label: existing.label,
      unit: existing.unit,
      unitPriceCents: existing.unitPriceCents,
    };
    if (fields.length) diff.update.push({ code: rate.code, before, after: rate, fields });
    else diff.unchanged.push(rate.code);
  }
  for (const rate of current)
    if (rate.active && !inFile.has(rate.code)) diff.notInFile.push(rate.code);
  return diff;
}
