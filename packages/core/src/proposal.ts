import { z } from 'zod';
import { rateCodeSchema } from './quote.js';

/**
 * The only shape accepted from an agent. It is a suggestion, never a record: it carries no
 * prices, totals, tax, approval flags or identifiers that the server would trust. Unknown keys
 * are rejected, so a model that "sets the price to $1" produces an invalid proposal.
 */
export const workProposalSchema = z
  .object({
    customerQuery: z.string().trim().max(200),
    workSummary: z.string().trim().min(1).max(500),
    lineItems: z
      .array(
        z
          .object({
            rateCode: rateCodeSchema.nullable(),
            quantity: z.number().int().positive().max(1000).nullable(),
            description: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .max(20),
    missingInformation: z.array(z.string().trim().min(1).max(300)).max(20),
    assumptions: z.array(z.string().trim().min(1).max(300)).max(20),
  })
  .strict();
export type WorkProposal = z.infer<typeof workProposalSchema>;

/** Validate untrusted agent output against the rate codes the agent was actually offered. */
export function parseWorkProposal(value: unknown, offeredRateCodes: readonly string[]): WorkProposal {
  const proposal = workProposalSchema.parse(value);
  for (const item of proposal.lineItems) {
    if (item.rateCode !== null && !offeredRateCodes.includes(item.rateCode)) {
      throw new z.ZodError([
        { code: 'custom', path: ['lineItems'], message: 'Proposal used a rate code it was not offered.', input: item.rateCode },
      ]);
    }
  }
  return proposal;
}
