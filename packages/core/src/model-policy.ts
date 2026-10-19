export const privacyModes = ['LOCAL_ONLY', 'APPROVAL_REQUIRED', 'APPROVED_CLOUD'] as const;
export type PrivacyMode = (typeof privacyModes)[number];

/** 'unverified' is treated exactly like 'hosted': the policy fails closed. */
export type ModelLocation = 'local' | 'hosted' | 'unverified';
export type ModelPurpose = 'enquiry_interpretation' | 'knowledge_embedding';
export const dataCategories = [
  'enquiry_text',
  'customer_names',
  'rate_labels',
  'job_notes',
  'communication_text',
] as const;
export type DataCategory = (typeof dataCategories)[number];

export interface ModelDestination {
  /** Stable provider label, e.g. "mock", "openclaw:ollama", "openai-compatible:api.openrouter.ai". */
  provider: string;
  location: ModelLocation;
  /** How the location is known: by the runtime itself, by operator configuration, or from the endpoint URL. */
  attestation: 'runtime' | 'operator' | 'endpoint';
}

export interface ModelUseApproval {
  id: string;
  purpose: ModelPurpose;
  provider: string;
  dataCategories: readonly DataCategory[];
  expiresAt: Date;
  consumedAt: Date | null;
}

export type PolicyReason =
  | 'local_inference'
  | 'approved_cloud'
  | 'scoped_approval'
  | 'local_only_blocks_hosted'
  | 'approval_required'
  | 'approval_mismatch'
  | 'approval_expired';

export interface PolicyDecision {
  allowed: boolean;
  mode: PrivacyMode;
  purpose: ModelPurpose;
  destination: ModelDestination;
  dataCategories: DataCategory[];
  reason: PolicyReason;
  explanation: string;
}

export class PolicyDeniedError extends Error {
  readonly code: 'MODEL_POLICY_DENIED' | 'MODEL_APPROVAL_REQUIRED';
  constructor(readonly decision: PolicyDecision) {
    super(decision.explanation);
    this.name = 'PolicyDeniedError';
    this.code =
      decision.reason === 'local_only_blocks_hosted'
        ? 'MODEL_POLICY_DENIED'
        : 'MODEL_APPROVAL_REQUIRED';
  }
}

/**
 * Server-side model privacy policy. Every inference and embedding request passes through this
 * single decision before any business content leaves the process. There is no fallback path:
 * a denied request is not retried against another provider.
 */
export function decideModelUse(input: {
  mode: PrivacyMode;
  purpose: ModelPurpose;
  destination: ModelDestination;
  dataCategories: readonly DataCategory[];
  approval?: ModelUseApproval | null;
  now?: Date;
}): PolicyDecision {
  const base = {
    mode: input.mode,
    purpose: input.purpose,
    destination: input.destination,
    dataCategories: [...new Set(input.dataCategories)].sort(),
  };
  const where = `${input.destination.provider} (${input.destination.location === 'local' ? 'on this installation' : 'outside this installation'})`;
  const what = base.dataCategories.join(', ').replace(/_/g, ' ');
  if (input.destination.location === 'local') {
    return {
      ...base,
      allowed: true,
      reason: 'local_inference',
      explanation: `Processed locally by ${input.destination.provider}.`,
    };
  }
  if (input.mode === 'LOCAL_ONLY') {
    return {
      ...base,
      allowed: false,
      reason: 'local_only_blocks_hosted',
      explanation: `Local-only privacy blocks sending ${what} to ${where}. No cloud fallback is attempted.`,
    };
  }
  if (input.mode === 'APPROVED_CLOUD') {
    return {
      ...base,
      allowed: true,
      reason: 'approved_cloud',
      explanation: `Approved cloud processing: ${what} sent to ${where}.`,
    };
  }
  const approval = input.approval;
  if (!approval) {
    return {
      ...base,
      allowed: false,
      reason: 'approval_required',
      explanation: `Owner approval is required before sending ${what} to ${where}.`,
    };
  }
  const now = input.now ?? new Date();
  if (approval.consumedAt !== null || approval.expiresAt.getTime() <= now.getTime()) {
    return {
      ...base,
      allowed: false,
      reason: 'approval_expired',
      explanation: 'The model-use approval has expired or was already used.',
    };
  }
  const covers = base.dataCategories.every((category) =>
    approval.dataCategories.includes(category),
  );
  if (
    approval.purpose !== input.purpose ||
    approval.provider !== input.destination.provider ||
    !covers
  ) {
    return {
      ...base,
      allowed: false,
      reason: 'approval_mismatch',
      explanation: 'The model-use approval does not cover this purpose, destination or data.',
    };
  }
  return {
    ...base,
    allowed: true,
    reason: 'scoped_approval',
    explanation: `Owner-approved, single use: ${what} sent to ${where}.`,
  };
}

export function assertModelUse(input: Parameters<typeof decideModelUse>[0]): PolicyDecision {
  const decision = decideModelUse(input);
  if (!decision.allowed) throw new PolicyDeniedError(decision);
  return decision;
}

export interface EmbeddingProvider {
  readonly destination: ModelDestination;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** The only supported way to embed business content. */
export async function embedWithPolicy(
  context: {
    mode: PrivacyMode;
    dataCategories: readonly DataCategory[];
    approval?: ModelUseApproval | null;
  },
  provider: EmbeddingProvider,
  texts: readonly string[],
): Promise<{ vectors: number[][]; decision: PolicyDecision }> {
  const decision = assertModelUse({
    mode: context.mode,
    purpose: 'knowledge_embedding',
    destination: provider.destination,
    dataCategories: context.dataCategories,
    approval: context.approval ?? null,
  });
  const vectors = await provider.embed(texts);
  if (
    vectors.length !== texts.length ||
    vectors.some(
      (vector) => vector.length !== provider.dimensions || vector.some((n) => !Number.isFinite(n)),
    )
  ) {
    throw new Error('Embedding provider returned vectors of the wrong shape.');
  }
  return { vectors, decision };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** A model endpoint is local only when it is reached over loopback; configuration labels cannot override this. */
export function locationFromEndpoint(url: string): ModelLocation {
  const parsed = new URL(url);
  return LOOPBACK.has(parsed.hostname) ? 'local' : 'hosted';
}
