import { describe, expect, it } from 'vitest';
import {
  createKeyring,
  CredentialDecryptionError,
  keyringFromEnv,
  needsReencryption,
  openCredentials,
  sealCredentials,
} from './envelope.js';
import { EncryptedTokenStore, InMemoryConnectionStore } from './stores.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const TENANT = '44444444-4444-4444-8444-444444444444';
const OTHER_TENANT = '55555555-5555-4555-8555-555555555555';
const binding = { tenantId: TENANT, provider: 'xero' };
const secret = JSON.stringify({ accessToken: 'very-secret-access-token' });

describe('credential envelope (AES-256-GCM)', () => {
  const keyring = createKeyring('k1', { k1: KEY_A });

  it('round-trips with a versioned, randomised ciphertext that never contains the plaintext', () => {
    const one = sealCredentials(secret, keyring, binding);
    const two = sealCredentials(secret, keyring, binding);
    expect(one.keyId).toBe('k1');
    expect(one.ciphertext[0]).toBe(1);
    expect(one.ciphertext.equals(two.ciphertext)).toBe(false);
    expect(one.ciphertext.toString('latin1')).not.toContain('very-secret');
    expect(openCredentials(one, keyring, binding)).toBe(secret);
  });

  it('detects tampering anywhere in the envelope', () => {
    const sealed = sealCredentials(secret, keyring, binding);
    for (const index of [1, 14, 30, sealed.ciphertext.length - 1]) {
      const tampered = Buffer.from(sealed.ciphertext);
      tampered[index]! ^= 0x01;
      expect(() => openCredentials({ ...sealed, ciphertext: tampered }, keyring, binding)).toThrow(
        CredentialDecryptionError,
      );
    }
    const truncated = sealed.ciphertext.subarray(0, 20);
    expect(() => openCredentials({ ...sealed, ciphertext: truncated }, keyring, binding)).toThrow(
      CredentialDecryptionError,
    );
    const wrongVersion = Buffer.from(sealed.ciphertext);
    wrongVersion[0] = 2;
    expect(() =>
      openCredentials({ ...sealed, ciphertext: wrongVersion }, keyring, binding),
    ).toThrow(/version/);
  });

  it('rejects a ciphertext moved to another tenant, provider or key id (AAD binding)', () => {
    const sealed = sealCredentials(secret, keyring, binding);
    expect(() =>
      openCredentials(sealed, keyring, { tenantId: OTHER_TENANT, provider: 'xero' }),
    ).toThrow(CredentialDecryptionError);
    expect(() => openCredentials(sealed, keyring, { tenantId: TENANT, provider: 'gmail' })).toThrow(
      CredentialDecryptionError,
    );
    const both = createKeyring('k2', { k1: KEY_A, k2: KEY_A });
    expect(() => openCredentials({ ...sealed, keyId: 'k2' }, both, binding)).toThrow(
      CredentialDecryptionError,
    );
  });

  it('rejects the wrong key and errors never reveal secrets', () => {
    const sealed = sealCredentials(secret, keyring, binding);
    const wrong = createKeyring('k1', { k1: KEY_B });
    let error: unknown;
    try {
      openCredentials(sealed, wrong, binding);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CredentialDecryptionError);
    expect(String((error as Error).message)).not.toMatch(/secret|aaaa|bbbb/);
  });

  it('supports rotation: retired keys decrypt, new writes use the active key', () => {
    const old = sealCredentials(secret, createKeyring('k1', { k1: KEY_A }), binding);
    const rotated = keyringFromEnv({
      CREDENTIAL_ENCRYPTION_KEY: KEY_B,
      CREDENTIAL_ENCRYPTION_KEY_ID: 'k2',
      CREDENTIAL_ENCRYPTION_RETIRED_KEYS: `k1:${KEY_A}`,
    });
    expect(openCredentials(old, rotated, binding)).toBe(secret);
    expect(needsReencryption(old, rotated)).toBe(true);
    expect(sealCredentials(secret, rotated, binding).keyId).toBe('k2');
    expect(() => keyringFromEnv({})).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
    expect(() => keyringFromEnv({ CREDENTIAL_ENCRYPTION_KEY: 'short' })).toThrow();
    expect(keyringFromEnv({ CREDENTIAL_ENCRYPTION_KEY: KEY_A }).activeKeyId).toBe('k1');
  });
});

describe('EncryptedTokenStore', () => {
  const tokens = {
    accessToken: 'at-secret',
    refreshToken: 'rt-secret',
    expiresAt: new Date('2026-10-19T10:00:00Z'),
    scopes: ['offline_access'],
  };

  it('stores sealed tokens in a provider_connections-shaped row and loads them back', async () => {
    const rows = new InMemoryConnectionStore();
    const store = new EncryptedTokenStore(rows, createKeyring('k1', { k1: KEY_A }), {
      newId: () => 'conn-1',
    });
    await store.save(TENANT, 'xero', tokens, { externalAccountId: 'org-1' });
    const row = await rows.get(TENANT, 'xero');
    expect(row).toMatchObject({
      id: 'conn-1',
      status: 'connected',
      encryptionKeyId: 'k1',
      externalAccountId: 'org-1',
    });
    expect(row!.encryptedCredentials!.toString('latin1')).not.toContain('secret');
    expect(await store.load(TENANT, 'xero')).toEqual(tokens);
    expect(await store.load(OTHER_TENANT, 'xero')).toBeNull();
  });

  it('re-encrypts rows sealed with a retired key on read', async () => {
    const rows = new InMemoryConnectionStore();
    await new EncryptedTokenStore(rows, createKeyring('k1', { k1: KEY_A })).save(
      TENANT,
      'xero',
      tokens,
    );
    const rotated = new EncryptedTokenStore(rows, createKeyring('k2', { k1: KEY_A, k2: KEY_B }));
    expect(await rotated.load(TENANT, 'xero')).toEqual(tokens);
    expect((await rows.get(TENANT, 'xero'))!.encryptionKeyId).toBe('k2');
  });

  it('discards credentials when reauthorisation is required', async () => {
    const rows = new InMemoryConnectionStore();
    const store = new EncryptedTokenStore(rows, createKeyring('k1', { k1: KEY_A }));
    await store.save(TENANT, 'xero', tokens);
    await store.markReauthorisationRequired(TENANT, 'xero');
    expect(await rows.get(TENANT, 'xero')).toMatchObject({
      status: 'error',
      encryptedCredentials: null,
      encryptionKeyId: null,
    });
    expect(await store.load(TENANT, 'xero')).toBeNull();
  });
});
