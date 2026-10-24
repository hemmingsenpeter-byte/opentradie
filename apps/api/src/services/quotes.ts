import { randomUUID } from 'node:crypto';
import {
  computeDocumentTotals,
  formatBasisPoints,
  type ApprovedRate,
  type DocumentTotals,
  type LineInput,
  type LineKind,
  type LineUnit,
  type PriceSource,
  type TaxCode,
  type TaxSettings,
} from '@opentradie/core';
import type { Queryable } from '@opentradie/database';
import { HttpError, type UserContext } from '../http.js';
import type { QuoteLineInput } from '../schemas.js';
import type { Business } from './records.js';

/** The business's current GST settings as the core engine expects them. */
export function taxSettingsFor(business: Business): TaxSettings {
  return {
    gstRegistered: business.gstRegistered,
    pricesEntered: business.pricesEntered,
    standardRateBasisPoints: business.taxBasisPoints,
  };
}

export function formatQuoteNumber(sequence: number): string {
  return `Q-${sequence < 10_000 ? String(sequence).padStart(4, '0') : String(sequence)}`;
}

/** Next per-business quote number. The row lock serialises concurrent allocations. */
export async function allocateQuoteNumber(client: Queryable, tenantId: string): Promise<string> {
  const result = await client.query<{ n: number }>(
    'UPDATE businesses SET next_quote_number=next_quote_number+1 WHERE id=$1 RETURNING next_quote_number-1 AS n',
    [tenantId],
  );
  if (!result.rows[0]) throw new HttpError(503, 'BUSINESS_UNAVAILABLE', 'Business not set up.');
  return formatQuoteNumber(result.rows[0].n);
}

const GENERATED_ASSUMPTION = /^(Prices come only from |The business is not registered for GST)/;

/** Stated pricing and GST assumptions for the business's current settings. */
export function pricingAssumptions(business: Business): string[] {
  const label = business.taxLabel;
  if (!business.gstRegistered)
    return [
      'Prices come only from the business-approved rate card, recorded material costs with markup, or prices the owner entered.',
      `The business is not registered for GST; no ${label} is charged.`,
    ];
  const rate = formatBasisPoints(business.taxBasisPoints);
  return business.pricesEntered === 'inclusive'
    ? [
        `Prices come only from the business-approved rate card, recorded material costs with markup, or prices the owner entered, and include ${label}.`,
        `${label} at ${rate} is included in the prices and calculated once per tax code on the total, rounded half away from zero to the cent.`,
      ]
    : [
        `Prices come only from the business-approved rate card, recorded material costs with markup, or prices the owner entered, and exclude ${label}.`,
        `${label} at ${rate} is calculated once per tax code on the subtotal, rounded half away from zero to the cent.`,
      ];
}

/** Replace previously generated pricing assumptions with the current ones; keep the rest. */
export function withPricingAssumptions(existing: readonly string[], business: Business): string[] {
  const taxStatement = new RegExp(`^(${business.taxLabel}|GST) at \\d`);
  const kept = existing.filter(
    (item) => !GENERATED_ASSUMPTION.test(item) && !taxStatement.test(item),
  );
  return [...kept, ...pricingAssumptions(business)];
}

/**
 * Turn request lines into engine inputs. Approved-rate lines take their price from the
 * current rate card only; owner-entered prices are stamped with the authenticated owner.
 */
export function linesFromRequest(
  requested: readonly QuoteLineInput[],
  context: { rates: readonly ApprovedRate[]; business: Business; user: UserContext },
): LineInput[] {
  const card = new Map(context.rates.map((rate) => [rate.code, rate]));
  const unknown = requested
    .filter((line) => 'rateCode' in line && !card.has(line.rateCode))
    .map((line) => (line as { rateCode: string }).rateCode);
  if (unknown.length)
    throw new HttpError(
      422,
      'UNKNOWN_RATE',
      `Not an approved, active rate: ${[...new Set(unknown)].join(', ')}. Quotes can only use approved rates.`,
    );
  return requested.map((line): LineInput => {
    if (!('source' in line) || line.source === 'approved_rate') {
      const rate = card.get(line.rateCode)!;
      const legacy = !('source' in line);
      return {
        kind: legacy
          ? rate.unit === 'hour'
            ? 'labour'
            : 'fee'
          : (line.kind ?? (rate.unit === 'hour' ? 'labour' : 'fee')),
        description: legacy ? rate.label : (line.description ?? rate.label),
        unit: rate.unit,
        quantityMilli: legacy ? line.quantity * 1000 : line.quantityMilli,
        price: {
          source: 'approved_rate',
          rateCode: rate.code,
          unitPriceCents: rate.unitPriceCents,
        },
        taxCode: legacy ? 'standard' : line.taxCode,
        lineDiscountBasisPoints: legacy ? 0 : (line.discountBasisPoints ?? 0),
      };
    }
    if (line.source === 'cost_plus_markup')
      return {
        kind: 'material',
        description: line.description,
        unit: line.unit,
        quantityMilli: line.quantityMilli,
        price: {
          source: 'cost_plus_markup',
          costCents: line.costCents,
          markupBasisPoints:
            line.markupBasisPoints ?? context.business.defaultMaterialMarkupBasisPoints,
        },
        taxCode: line.taxCode,
        lineDiscountBasisPoints: line.discountBasisPoints ?? 0,
      };
    // Defence in depth: routes accepting this shape are owner-only already.
    if (context.user.role !== 'owner')
      throw new HttpError(403, 'OWNER_REQUIRED', 'Only the business owner can enter a price.');
    return {
      kind: line.kind,
      description: line.description,
      unit: line.unit,
      quantityMilli: line.quantityMilli,
      price: {
        source: 'owner_entered',
        unitPriceCents: line.unitPriceCents,
        enteredByRole: 'owner',
        enteredByUserId: context.user.id,
      },
      taxCode: line.taxCode,
      lineDiscountBasisPoints: line.discountBasisPoints ?? 0,
    };
  });
}

interface StoredLine {
  kind: LineKind;
  description: string;
  unit: LineUnit;
  quantityMilli: number;
  taxCode: TaxCode;
  priceSource: PriceSource;
  rateCode: string | null;
  unitPriceCents: number;
  costCents: number | null;
  markupBp: number | null;
  discountBp: number;
  enteredBy: string | null;
}

/** Read a quote's stored lines back as engine inputs (for revisions and documents). */
export async function loadLineInputs(
  client: Queryable,
  tenantId: string,
  quoteId: string,
): Promise<LineInput[]> {
  const result = await client.query<StoredLine>(
    `SELECT kind,description,unit,quantity_milli AS "quantityMilli",tax_code AS "taxCode",price_source AS "priceSource",
       rate_code AS "rateCode",unit_price_cents AS "unitPriceCents",cost_cents AS "costCents",markup_bp AS "markupBp",
       discount_bp AS "discountBp",entered_by AS "enteredBy"
     FROM quote_line_items WHERE tenant_id=$1 AND quote_id=$2 ORDER BY position`,
    [tenantId, quoteId],
  );
  return result.rows.map((row) => ({
    kind: row.kind,
    description: row.description,
    unit: row.unit,
    quantityMilli: row.quantityMilli,
    taxCode: row.taxCode,
    lineDiscountBasisPoints: row.discountBp,
    price:
      row.priceSource === 'approved_rate'
        ? { source: 'approved_rate', rateCode: row.rateCode!, unitPriceCents: row.unitPriceCents }
        : row.priceSource === 'cost_plus_markup'
          ? {
              source: 'cost_plus_markup',
              costCents: row.costCents!,
              markupBasisPoints: row.markupBp!,
            }
          : {
              source: 'owner_entered',
              unitPriceCents: row.unitPriceCents,
              enteredByRole: 'owner',
              enteredByUserId: row.enteredBy!,
            },
  }));
}

export function computeTotalsOrReject(
  lines: readonly LineInput[],
  settings: TaxSettings,
): DocumentTotals {
  try {
    return computeDocumentTotals(lines, settings);
  } catch (error) {
    if (error instanceof RangeError)
      throw new HttpError(422, 'INVALID_QUOTE_LINES', `Check the quote lines: ${error.message}`);
    throw error;
  }
}

/**
 * Price lines with the core engine and persist lines and totals together. The client never
 * supplies totals; every write path (assistant draft, owner edit, revision) goes through here.
 */
export async function writeQuotePricing(
  client: Queryable,
  input: {
    tenantId: string;
    quoteId: string;
    lines: readonly LineInput[];
    business: Business;
    assumptions: readonly string[];
    missingInformation: readonly string[];
  },
): Promise<DocumentTotals> {
  const settings = taxSettingsFor(input.business);
  const totals = computeTotalsOrReject(input.lines, settings);
  await client.query('DELETE FROM quote_line_items WHERE tenant_id=$1 AND quote_id=$2', [
    input.tenantId,
    input.quoteId,
  ]);
  for (const [position, line] of totals.lines.entries()) {
    const source = input.lines[position]!.price;
    await client.query(
      `INSERT INTO quote_line_items(id,tenant_id,quote_id,position,rate_code,description,unit,quantity,quantity_milli,kind,tax_code,
         price_source,unit_price_cents,cost_cents,markup_bp,discount_bp,gross_cents,discount_cents,line_total_cents,entered_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        randomUUID(),
        input.tenantId,
        input.quoteId,
        position,
        line.rateCode,
        line.description,
        line.unit,
        line.quantityMilli % 1000 === 0 ? line.quantityMilli / 1000 : null,
        line.quantityMilli,
        line.kind,
        line.taxCode,
        line.priceSource,
        line.unitPriceCents,
        source.source === 'cost_plus_markup' ? source.costCents : null,
        source.source === 'cost_plus_markup' ? source.markupBasisPoints : null,
        line.lineDiscountBasisPoints,
        line.grossCents,
        line.lineDiscountCents,
        line.amountCents,
        source.source === 'owner_entered' ? source.enteredByUserId : null,
      ],
    );
  }
  await client.query(
    `UPDATE quotes SET subtotal_cents=$3,tax_cents=$4,total_cents=$5,tax_breakdown=$6,gst_registered=$7,prices_entered=$8,
       tax_basis_points=$9,assumptions=$10,missing_information=$11,updated_at=now()
     WHERE tenant_id=$1 AND id=$2`,
    [
      input.tenantId,
      input.quoteId,
      totals.subtotalExclCents,
      totals.totalTaxCents,
      totals.totalInclCents,
      JSON.stringify(totals.taxByCode),
      settings.gstRegistered,
      settings.pricesEntered,
      settings.standardRateBasisPoints,
      JSON.stringify(input.assumptions),
      JSON.stringify(input.missingInformation),
    ],
  );
  return totals;
}
