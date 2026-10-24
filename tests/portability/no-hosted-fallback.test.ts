import {
  decideModelUse,
  embedWithPolicy,
  PolicyDeniedError,
  type EmbeddingProvider,
  type ModelDestination,
  type ModelPurpose,
  type PrivacyMode,
} from '@opentradie/core';
import { FasterWhisperHttpAdapter, transcribeWithPolicy } from '@opentradie/integrations/speech';
import { describe, expect, it } from 'vitest';

/**
 * Provider failover policy: there is no automatic fallback to hosted inference, speech or
 * embeddings. LOCAL_ONLY always refuses a hosted destination; APPROVAL_REQUIRED (the hybrid
 * profile's "hosted denied until the owner approves") refuses without an approval. A refusal is
 * final: no other destination is tried and the hosted provider is never called.
 */
const DENIED_MODES: Array<[label: string, mode: PrivacyMode]> = [
  ['LOCAL_ONLY', 'LOCAL_ONLY'],
  ['HYBRID with hosted denied (APPROVAL_REQUIRED, no approval)', 'APPROVAL_REQUIRED'],
];
const HOSTED: ModelDestination[] = [
  { provider: 'hosted-model', location: 'hosted', attestation: 'endpoint' },
  { provider: 'unverified-gateway', location: 'unverified', attestation: 'operator' },
];

type Attempt = (
  mode: PrivacyMode,
  destination: ModelDestination,
  called: string[],
) => Promise<void>;

/** Each provider kind: runs one request through its policy gate, returns the providers called. */
const PROVIDERS: Array<[name: string, attempt: Attempt]> = [
  ...(
    [
      ['agent (enquiry interpretation)', 'enquiry_interpretation'],
      ['triage (inbound message)', 'message_triage'],
    ] as Array<[string, ModelPurpose]>
  ).map(([name, purpose]): [string, Attempt] => [
    name,
    async (mode, destination, called) => {
      // The agent and triage call sites call the runtime only when this decision allows it.
      const decision = decideModelUse({
        mode,
        purpose,
        destination,
        dataCategories: ['enquiry_text', 'customer_names'],
      });
      if (decision.allowed) {
        called.push(destination.provider);
        return;
      }
      throw new PolicyDeniedError(decision);
    },
  ]),
  [
    'embeddings',
    async (mode, destination, called) => {
      const provider: EmbeddingProvider = {
        destination,
        dimensions: 3,
        embed: async (texts) => {
          called.push(destination.provider);
          return texts.map(() => [0, 0, 0]);
        },
      };
      await embedWithPolicy({ mode, dataCategories: ['job_notes'] }, provider, ['text']);
    },
  ],
  [
    'speech',
    async (mode, destination, called) => {
      const baseUrl =
        destination.location === 'hosted' ? 'https://stt.example.com' : 'http://192.168.1.20:8080';
      const adapter = new FasterWhisperHttpAdapter({
        baseUrl,
        model: 'large-v3',
        apiKey: 'throwaway-test-key',
        fetch: async (url) => {
          called.push(String(url));
          return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
        },
      });
      await transcribeWithPolicy({ mode }, adapter, {
        audio: Buffer.from('RIFF0000WAVE'),
        mediaType: 'audio/wav',
      });
    },
  ],
];

describe('no automatic fallback to hosted providers', () => {
  for (const [name, attempt] of PROVIDERS) {
    for (const [label, mode] of DENIED_MODES) {
      for (const destination of HOSTED) {
        it(`${name}: ${label} refuses ${destination.location} and calls nothing`, async () => {
          const called: string[] = [];
          const error = await attempt(mode, destination, called).then(
            () => null,
            (caught: unknown) => caught,
          );
          expect(error).toBeInstanceOf(PolicyDeniedError);
          expect((error as PolicyDeniedError).code).toMatch(
            /^MODEL_(POLICY_DENIED|APPROVAL_REQUIRED)$/,
          );
          // Refused before any content left the process, and no other provider was tried.
          expect(called).toEqual([]);
          expect((error as PolicyDeniedError).decision.allowed).toBe(false);
        });
      }
    }
  }

  it('the policy has no fallback field and LOCAL_ONLY explains that none is attempted', () => {
    const decision = decideModelUse({
      mode: 'LOCAL_ONLY',
      purpose: 'enquiry_interpretation',
      destination: HOSTED[0]!,
      dataCategories: ['enquiry_text'],
    });
    expect(Object.keys(decision).sort()).toEqual(
      [
        'allowed',
        'dataCategories',
        'destination',
        'explanation',
        'mode',
        'purpose',
        'reason',
      ].sort(),
    );
    expect(decision.explanation).toMatch(/No cloud fallback is attempted/);
  });
});
