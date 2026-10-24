import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { parseEncryptionKey } from '@opentradie/core';

/**
 * Versioned AES-256-GCM envelope for provider credentials stored in
 * provider_connections.encrypted_credentials (bytea), with the key id in encryption_key_id.
 *
 * Layout (version 1): [0x01][12-byte IV][16-byte GCM tag][ciphertext]
 * Additional authenticated data binds the ciphertext to its row: tenant id, provider and key id.
 * Copying a ciphertext to another tenant or provider, or relabelling its key id, fails to open.
 */
export const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

export interface CredentialKeyring {
  /** Key used for every new encryption. */
  readonly activeKeyId: string;
  /** All keys that may still decrypt existing rows (active and retired). */
  readonly keys: ReadonlyMap<string, Buffer>;
}

export interface CredentialBinding {
  tenantId: string;
  provider: string;
}

export interface SealedCredentials {
  keyId: string;
  ciphertext: Buffer;
}

export class CredentialDecryptionError extends Error {
  constructor(message = 'Stored provider credentials could not be decrypted.') {
    super(message);
    this.name = 'CredentialDecryptionError';
  }
}

const KEY_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export function createKeyring(
  activeKeyId: string,
  keys: Record<string, string>,
): CredentialKeyring {
  const map = new Map<string, Buffer>();
  for (const [id, hex] of Object.entries(keys)) {
    if (!KEY_ID.test(id))
      throw new Error('Credential key ids must be 1-64 characters of [A-Za-z0-9_.-].');
    map.set(id, parseEncryptionKey(hex));
  }
  if (!map.has(activeKeyId)) throw new Error('The active credential key id has no key.');
  return { activeKeyId, keys: map };
}

/**
 * Builds the keyring from the environment:
 * - CREDENTIAL_ENCRYPTION_KEY: 64 hex chars, the active key (required).
 * - CREDENTIAL_ENCRYPTION_KEY_ID: its id (default "k1").
 * - CREDENTIAL_ENCRYPTION_RETIRED_KEYS: optional "id:hex,id:hex" list kept only to decrypt
 *   rows written before a rotation.
 */
export function keyringFromEnv(env: NodeJS.ProcessEnv = process.env): CredentialKeyring {
  const active = env.CREDENTIAL_ENCRYPTION_KEY;
  if (!active)
    throw new Error('CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials.');
  const activeId = env.CREDENTIAL_ENCRYPTION_KEY_ID || 'k1';
  const keys: Record<string, string> = {};
  for (const entry of (env.CREDENTIAL_ENCRYPTION_RETIRED_KEYS ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [id, hex] = trimmed.split(':');
    if (!id || !hex) throw new Error('CREDENTIAL_ENCRYPTION_RETIRED_KEYS must be "id:hex" pairs.');
    keys[id] = hex;
  }
  keys[activeId] = active;
  return createKeyring(activeId, keys);
}

function associatedData(binding: CredentialBinding, keyId: string): Buffer {
  if (!binding.tenantId || !binding.provider) throw new Error('Credential binding is incomplete.');
  return Buffer.from(
    `opentradie.credentials.v${ENVELOPE_VERSION}\u0000${binding.tenantId.toLowerCase()}\u0000${binding.provider}\u0000${keyId}`,
    'utf8',
  );
}

export function sealCredentials(
  plaintext: string,
  keyring: CredentialKeyring,
  binding: CredentialBinding,
): SealedCredentials {
  const keyId = keyring.activeKeyId;
  const key = keyring.keys.get(keyId);
  if (!key) throw new Error('The active credential key id has no key.');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(associatedData(binding, keyId));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    keyId,
    ciphertext: Buffer.concat([Buffer.from([ENVELOPE_VERSION]), iv, cipher.getAuthTag(), body]),
  };
}

export function openCredentials(
  sealed: SealedCredentials,
  keyring: CredentialKeyring,
  binding: CredentialBinding,
): string {
  const key = keyring.keys.get(sealed.keyId);
  if (!key) throw new CredentialDecryptionError('No key is configured for this credential key id.');
  const data = sealed.ciphertext;
  if (data.length < HEADER_BYTES || data[0] !== ENVELOPE_VERSION)
    throw new CredentialDecryptionError('Unsupported credential envelope version.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(1, 1 + IV_BYTES));
    decipher.setAAD(associatedData(binding, sealed.keyId));
    decipher.setAuthTag(data.subarray(1 + IV_BYTES, HEADER_BYTES));
    return Buffer.concat([decipher.update(data.subarray(HEADER_BYTES)), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    // Never include the ciphertext, key or binding detail in the error.
    throw new CredentialDecryptionError();
  }
}

/** True when a row was sealed with a retired key and should be re-encrypted with the active key. */
export function needsReencryption(sealed: { keyId: string }, keyring: CredentialKeyring): boolean {
  return sealed.keyId !== keyring.activeKeyId;
}
