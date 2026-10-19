import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (password: string, salt: string, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const SCRYPT = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error('Passwords must contain at least 12 characters.');
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, n, r, p, salt, digest] = stored.split('$');
  if (algorithm !== 'scrypt' || !salt || !digest || !/^[a-f0-9]{128}$/.test(digest)) return false;
  const params = { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem };
  if (![params.N, params.r, params.p].every(Number.isSafeInteger)) return false;
  const actual = await scrypt(password, salt, 64, params);
  return timingSafeEqual(actual, Buffer.from(digest, 'hex'));
}

/** AES-256-GCM envelope for provider credentials. The key id is stored beside the ciphertext. */
export interface SealedSecret {
  keyId: string;
  ciphertext: Buffer;
}

export function parseEncryptionKey(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 bytes of hex.');
  return Buffer.from(hex, 'hex');
}

export function sealSecret(plaintext: string, key: Buffer, keyId: string, associatedData: string): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(associatedData));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { keyId, ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]) };
}

export function openSecret(sealed: SealedSecret, key: Buffer, associatedData: string): string {
  const iv = sealed.ciphertext.subarray(0, 12);
  const tag = sealed.ciphertext.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(associatedData));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.ciphertext.subarray(28)), decipher.final()]).toString('utf8');
}

/** Paths redacted from every structured log line. Message bodies and prompts are never logged. */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'token',
  '*.token',
  'text',
  '*.text',
  'prompt',
  '*.prompt',
  'body',
  'req.body',
  'credentials',
  '*.credentials',
];
