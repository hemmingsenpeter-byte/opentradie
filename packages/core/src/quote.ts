import { z } from 'zod';
import { assertCents, multiplyCents, sumCents, taxOnSubtotal } from './money.js';

export const rateCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,63}$/, 'Rate codes are lower-case identifiers.');

export const approvedRateSchema = z.object({
  code: rateCodeSchema,
  label: z.string().min(1).max(200),
  unit: z.enum(['each', 'hour', 'visit']),
  unitPriceCents: z.number().int().nonnegative(),
});
export type ApprovedRate = z.infer<typeof approvedRateSchema>;

/** A requested line: what work, how much. It never carries a price. */
export interface RequestedLine {
  rateCode: string | null;
  quantity: number | null;
  description?: string;
}

export interface QuoteLine {
  rateCode: string;
  description: string;
  unit: ApprovedRate['unit'];
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface QuoteCalculation {
  lines: QuoteLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  taxBasisPoints: number;
  assumptions: string[];
  missingInformation: string[];
}

export interface QuotePolicy {
  taxBasisPoints: number;
  taxLabel: string;
  /** A rate code charged once per visit by business rule, or null. */
  callOutRateCode: string | null;
}

const MAX_QUANTITY = 10_000;

/**
 * Deterministic quote drafting. Prices come only from the approved rate card. Anything the
 * card cannot price becomes missing information; nothing is estimated or invented.
 */
export function calculateQuote(input: {
  requested: readonly RequestedLine[];
  approvedRates: readonly ApprovedRate[];
  policy: QuotePolicy;
  assumptions?: readonly string[];
  missingInformation?: readonly string[];
}): QuoteCalculation {
  const rates = new Map<string, ApprovedRate>();
  for (const rate of input.approvedRates) {
    const parsed = approvedRateSchema.parse(rate);
    assertCents(parsed.unitPriceCents, `rate ${parsed.code}`);
    rates.set(parsed.code, parsed);
  }
  const { taxBasisPoints, taxLabel, callOutRateCode } = input.policy;
  const missing = new Set<string>(input.missingInformation ?? []);
  const assumptions = new Set<string>(input.assumptions ?? []);
  const lines: QuoteLine[] = [];
  const quantities = new Map<string, number>();

  for (const request of input.requested) {
    const what = request.description?.trim() || 'requested work';
    if (request.rateCode === null) {
      missing.add(`No approved rate covers "${what}". Add an approved rate or adjust the scope.`);
      continue;
    }
    const rate = rates.get(request.rateCode);
    if (!rate) {
      missing.add(
        `Rate "${request.rateCode}" is not an approved, active rate. Choose an approved rate.`,
      );
      continue;
    }
    if (
      request.quantity === null ||
      !Number.isSafeInteger(request.quantity) ||
      request.quantity <= 0 ||
      request.quantity > MAX_QUANTITY
    ) {
      missing.add(`Confirm the quantity for "${rate.label}".`);
      continue;
    }
    quantities.set(rate.code, (quantities.get(rate.code) ?? 0) + request.quantity);
  }

  if (callOutRateCode !== null && quantities.size > 0 && !quantities.has(callOutRateCode)) {
    const callOut = rates.get(callOutRateCode);
    if (callOut) {
      quantities.set(callOut.code, 1);
      assumptions.add(`${callOut.label} is charged once for this visit (business rule).`);
    } else {
      missing.add(
        'The business call-out rule names a rate that is not approved. Review the rate card.',
      );
    }
  }

  for (const [code, quantity] of quantities) {
    if (quantity > MAX_QUANTITY) {
      missing.add(`Confirm the quantity for "${rates.get(code)!.label}".`);
      continue;
    }
    const rate = rates.get(code)!;
    lines.push({
      rateCode: rate.code,
      description: rate.label,
      unit: rate.unit,
      quantity,
      unitPriceCents: rate.unitPriceCents,
      lineTotalCents: multiplyCents(rate.unitPriceCents, quantity),
    });
  }
  if (lines.length === 0) missing.add('No priced work yet. Add at least one approved rate line.');

  const subtotalCents = sumCents(lines.map((line) => line.lineTotalCents));
  const taxCents = taxOnSubtotal(subtotalCents, taxBasisPoints);
  assumptions.add(
    'Prices come only from the business-approved rate card and exclude ' + taxLabel + '.',
  );
  assumptions.add(
    `${taxLabel} at ${formatBasisPoints(taxBasisPoints)} is calculated once on the subtotal, rounded half up to the cent.`,
  );
  return {
    lines,
    subtotalCents,
    taxCents,
    totalCents: sumCents([subtotalCents, taxCents]),
    taxBasisPoints,
    assumptions: [...assumptions],
    missingInformation: [...missing],
  };
}

export function formatBasisPoints(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const fraction = basisPoints % 100;
  return fraction === 0
    ? `${whole}%`
    : `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}%`;
}

export type QuoteStatus = 'draft' | 'approved' | 'rejected';

/** Approval is only possible for a complete draft. Authorisation is checked separately. */
export function approvalBlockers(quote: {
  status: QuoteStatus;
  lineCount: number;
  missingInformation: readonly string[];
}): string[] {
  const blockers: string[] = [];
  if (quote.status !== 'draft')
    blockers.push(`Quote is ${quote.status}; only drafts can be approved.`);
  if (quote.lineCount === 0) blockers.push('Quote has no priced lines.');
  if (quote.missingInformation.length > 0) blockers.push('Resolve the missing information first.');
  return blockers;
}
