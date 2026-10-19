import { z } from 'zod';

export const privacyModes = ['LOCAL_ONLY', 'APPROVAL_REQUIRED', 'APPROVED_CLOUD'] as const;
export type PrivacyMode = (typeof privacyModes)[number];
export type ModelLocation = 'local' | 'hosted';

export class PolicyDeniedError extends Error {
  readonly code = 'MODEL_POLICY_DENIED';
}

/** All inference and embedding adapters must pass this gate before receiving content. */
export function enforceModelPolicy(mode: PrivacyMode, location: ModelLocation): void {
  if (location === 'hosted' && mode !== 'APPROVED_CLOUD') {
    throw new PolicyDeniedError(
      mode === 'LOCAL_ONLY'
        ? 'Local-only privacy blocks hosted inference and embeddings.'
        : 'Hosted inference requires a scoped approval. Scoped approvals are not enabled in this release.',
    );
  }
}

export interface EmbeddingProvider {
  readonly location: ModelLocation;
  embed(text: string): Promise<readonly number[]>;
}

export async function embedWithPolicy(
  mode: PrivacyMode,
  provider: EmbeddingProvider,
  text: string,
): Promise<readonly number[]> {
  enforceModelPolicy(mode, provider.location);
  return provider.embed(text);
}

const cents = z.number().int().nonnegative().max(1_000_000_000);
const quantitySchema = z.number().int().positive().max(10_000);
const rateSchema = z.object({ code: z.string().min(1), label: z.string().min(1), unitPriceCents: cents });
export type ApprovedRate = z.infer<typeof rateSchema>;
export interface QuoteLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}
export interface QuoteCalculation {
  lines: QuoteLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  assumptions: string[];
  missingInformation: string[];
}

/** Model output selects a rate identifier; prices and arithmetic stay authoritative. */
export function calculateQuote(input: {
  rateCode: string | null;
  quantity: number | null;
  approvedRates: ApprovedRate[];
  taxBasisPoints: number;
  missingInformation?: string[];
}): QuoteCalculation {
  const taxBasisPoints = z.number().int().min(0).max(10_000).parse(input.taxBasisPoints);
  const approvedRates = z.array(rateSchema).parse(input.approvedRates);
  const missing = new Set(input.missingInformation ?? []);
  const rate = approvedRates.find((candidate) => candidate.code === input.rateCode);
  const quantity = quantitySchema.safeParse(input.quantity);
  if (!rate) missing.add('Select an approved business rate.');
  if (!quantity.success) missing.add('Confirm the number of units required.');
  const lines: QuoteLine[] = [];
  if (rate && quantity.success) {
    lines.push({
      description: rate.label,
      quantity: quantity.data,
      unitPriceCents: rate.unitPriceCents,
      lineTotalCents: rate.unitPriceCents * quantity.data,
    });
  }
  const subtotal = lines.reduce((sum, line) => sum + BigInt(line.lineTotalCents), 0n);
  // Positive amounts: round half up once on the subtotal, using integer arithmetic.
  const tax = (subtotal * BigInt(taxBasisPoints) + 5_000n) / 10_000n;
  const total = subtotal + tax;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Quote exceeds the supported amount.');
  return {
    lines,
    subtotalCents: Number(subtotal),
    taxCents: Number(tax),
    totalCents: Number(total),
    assumptions: ['Prices use the business-approved rate card.', 'Scope and site conditions require owner review.'],
    missingInformation: [...missing],
  };
}

export function canApproveQuote(quote: {
  status: string;
  lines: readonly unknown[];
  missingInformation: readonly string[];
}): boolean {
  return quote.status === 'draft' && quote.lines.length > 0 && quote.missingInformation.length === 0;
}

