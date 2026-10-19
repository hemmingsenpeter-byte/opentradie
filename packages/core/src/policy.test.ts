import { describe, expect, it, vi } from 'vitest';
import { resolveCustomer } from './customer-match.js';
import {
  decideModelUse,
  embedWithPolicy,
  locationFromEndpoint,
  PolicyDeniedError,
  type EmbeddingProvider,
  type ModelDestination,
} from './model-policy.js';
import { parseWorkProposal } from './proposal.js';
import { hashPassword, openSecret, sealSecret, verifyPassword } from './security.js';

const hosted: ModelDestination = {
  provider: 'openai-compatible:openrouter.ai',
  location: 'hosted',
  attestation: 'endpoint',
};
const local: ModelDestination = {
  provider: 'ollama:nomic-embed-text',
  location: 'local',
  attestation: 'endpoint',
};
const unverified: ModelDestination = {
  provider: 'openclaw:unconfigured',
  location: 'unverified',
  attestation: 'operator',
};
const base = {
  purpose: 'enquiry_interpretation' as const,
  dataCategories: ['enquiry_text' as const],
};

describe('model privacy policy', () => {
  it('LOCAL_ONLY blocks hosted and unverified destinations and allows local', () => {
    expect(decideModelUse({ ...base, mode: 'LOCAL_ONLY', destination: hosted })).toMatchObject({
      allowed: false,
      reason: 'local_only_blocks_hosted',
    });
    expect(decideModelUse({ ...base, mode: 'LOCAL_ONLY', destination: unverified })).toMatchObject({
      allowed: false,
    });
    expect(decideModelUse({ ...base, mode: 'LOCAL_ONLY', destination: local })).toMatchObject({
      allowed: true,
      reason: 'local_inference',
    });
  });

  it('APPROVAL_REQUIRED needs a matching, unexpired, unused approval', () => {
    const now = new Date('2026-10-19T00:00:00Z');
    const approval = {
      id: 'a',
      purpose: 'enquiry_interpretation' as const,
      provider: hosted.provider,
      dataCategories: ['enquiry_text' as const],
      expiresAt: new Date('2026-10-19T00:15:00Z'),
      consumedAt: null,
    };
    expect(
      decideModelUse({ ...base, mode: 'APPROVAL_REQUIRED', destination: hosted, now }),
    ).toMatchObject({ allowed: false, reason: 'approval_required' });
    expect(
      decideModelUse({ ...base, mode: 'APPROVAL_REQUIRED', destination: hosted, approval, now }),
    ).toMatchObject({ allowed: true, reason: 'scoped_approval' });
    expect(
      decideModelUse({
        ...base,
        mode: 'APPROVAL_REQUIRED',
        destination: hosted,
        approval: { ...approval, provider: 'other' },
        now,
      }),
    ).toMatchObject({ allowed: false, reason: 'approval_mismatch' });
    expect(
      decideModelUse({
        ...base,
        mode: 'APPROVAL_REQUIRED',
        destination: hosted,
        dataCategories: ['job_notes'],
        approval,
        now,
      }),
    ).toMatchObject({ reason: 'approval_mismatch' });
    expect(
      decideModelUse({
        ...base,
        mode: 'APPROVAL_REQUIRED',
        destination: hosted,
        approval: { ...approval, consumedAt: now },
        now,
      }),
    ).toMatchObject({ reason: 'approval_expired' });
    expect(
      decideModelUse({
        ...base,
        mode: 'APPROVAL_REQUIRED',
        destination: hosted,
        approval,
        now: new Date('2026-10-19T01:00:00Z'),
      }),
    ).toMatchObject({ reason: 'approval_expired' });
  });

  it('APPROVED_CLOUD allows configured hosted providers and explains destination and data', () => {
    const decision = decideModelUse({
      ...base,
      mode: 'APPROVED_CLOUD',
      destination: hosted,
      dataCategories: ['enquiry_text', 'customer_names'],
    });
    expect(decision).toMatchObject({ allowed: true, reason: 'approved_cloud' });
    expect(decision.explanation).toMatch(/customer names, enquiry text/);
    expect(decision.explanation).toMatch(/outside this installation/);
  });

  it('derives location from the endpoint, not from labels', () => {
    expect(locationFromEndpoint('http://127.0.0.1:11434')).toBe('local');
    expect(locationFromEndpoint('http://localhost:11434')).toBe('local');
    expect(locationFromEndpoint('https://ollama.example.com')).toBe('hosted');
  });

  it('LOCAL_ONLY embedding never calls a hosted provider', async () => {
    const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => new Array(3).fill(0)));
    const provider: EmbeddingProvider = { destination: hosted, dimensions: 3, embed };
    await expect(
      embedWithPolicy({ mode: 'LOCAL_ONLY', dataCategories: ['communication_text'] }, provider, [
        'private message',
      ]),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(embed).not.toHaveBeenCalled();
  });

  it('validates embedding shape', async () => {
    const provider: EmbeddingProvider = {
      destination: local,
      dimensions: 3,
      embed: async () => [[1, 2]],
    };
    await expect(
      embedWithPolicy({ mode: 'LOCAL_ONLY', dataCategories: ['job_notes'] }, provider, ['x']),
    ).rejects.toThrow(/wrong shape/);
  });
});

describe('customer resolution', () => {
  const customers = [
    { id: '1', name: 'Margaret Johnson', preferredName: 'Mrs Johnson' },
    { id: '2', name: 'Helen Johnson', preferredName: 'Mrs Johnson' },
    { id: '3', name: 'Aroha Ngata', preferredName: null },
  ];
  it('resolves exact names, reports ambiguity and unknowns', () => {
    expect(resolveCustomer('Margaret Johnson', customers)).toMatchObject({
      kind: 'resolved',
      basis: 'exact_name',
      customer: { id: '1' },
    });
    expect(resolveCustomer('Mrs Johnson', customers)).toMatchObject({ kind: 'ambiguous' });
    expect(resolveCustomer('johnson', customers)).toMatchObject({ kind: 'ambiguous' });
    expect(resolveCustomer('Ngata', customers)).toMatchObject({
      kind: 'resolved',
      basis: 'surname',
      customer: { id: '3' },
    });
    expect(resolveCustomer('aroha ngata', customers)).toMatchObject({
      kind: 'resolved',
      customer: { id: '3' },
    });
    expect(resolveCustomer('Smith', customers)).toEqual({ kind: 'none' });
    expect(resolveCustomer('', customers)).toEqual({ kind: 'none' });
  });
});

describe('work proposal parsing (agent output is untrusted)', () => {
  const valid = {
    customerQuery: 'Mrs Johnson',
    workSummary: 'Replace',
    lineItems: [{ rateCode: 'power_point_replace', quantity: 2, description: 'Power points' }],
    missingInformation: [],
    assumptions: [],
  };
  it('accepts the strict shape with offered codes only', () => {
    expect(parseWorkProposal(valid, ['power_point_replace']).lineItems[0]!.quantity).toBe(2);
    expect(() => parseWorkProposal(valid, ['labour_hour'])).toThrow();
  });
  it('rejects prices, totals and approval flags from the model', () => {
    expect(() =>
      parseWorkProposal({ ...valid, totalCents: 100 }, ['power_point_replace']),
    ).toThrow();
    expect(() => parseWorkProposal({ ...valid, approve: true }, ['power_point_replace'])).toThrow();
    expect(() =>
      parseWorkProposal({ ...valid, lineItems: [{ ...valid.lineItems[0], unitPriceCents: 100 }] }, [
        'power_point_replace',
      ]),
    ).toThrow();
  });
});

describe('security primitives', () => {
  it('hashes and verifies passwords with scrypt', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('wrong horse battery', stored)).toBe(false);
    await expect(hashPassword('short')).rejects.toThrow();
  });
  it('seals provider credentials and detects tampering or wrong context', () => {
    const key = Buffer.alloc(32, 7);
    const sealed = sealSecret('{"refresh_token":"x"}', key, 'k1', 'tenant-a:xero');
    expect(openSecret(sealed, key, 'tenant-a:xero')).toBe('{"refresh_token":"x"}');
    expect(() => openSecret(sealed, key, 'tenant-b:xero')).toThrow();
    const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
    tampered.ciphertext[tampered.ciphertext.length - 1]! ^= 1;
    expect(() => openSecret(tampered, key, 'tenant-a:xero')).toThrow();
  });
});
