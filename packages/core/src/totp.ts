import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 4648 base32 and RFC 6238 TOTP (HMAC-SHA-1, 6 digits, 30 second steps), implemented with
 * node:crypto only. Authenticator apps (Google Authenticator, 1Password, Aegis...) use exactly
 * these parameters by default.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) throw new Error('Invalid base32 character.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** RFC 4226 HOTP with dynamic truncation. `digits` up to 8 (the RFC 6238 vectors use 8). */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (unixSeconds: number) => Math.floor(unixSeconds / TOTP_STEP_SECONDS);

export function totp(secret: Buffer, unixSeconds: number, digits = TOTP_DIGITS): string {
  return hotp(secret, totpStep(unixSeconds), digits);
}

/**
 * Returns the matching time step (current ±1 for clock drift) or null. The caller rejects a step
 * that is not newer than the last accepted one, so a code cannot be replayed.
 */
export function verifyTotp(secret: Buffer, code: string, unixSeconds: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(unixSeconds);
  let matched: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    const candidate = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(candidate, Buffer.from(code)) && matched === null) matched = step;
  }
  return matched;
}

export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

export function otpauthUri(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Ten single-use recovery codes, e.g. "k7m2q-x9p4t" (50 random bits each). */
export function newRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const code = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

export const normaliseRecoveryCode = (code: string) =>
  code.trim().toLowerCase().replace(/[\s-]/g, '');

/** Recovery codes are high-entropy random values, so a plain SHA-256 is enough to store them. */
export const hashRecoveryCode = (code: string) =>
  createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');

export const MIN_PASSWORD_LENGTH = 12;

/** A small embedded list of passwords that are long enough but appear in breach top lists. */
const COMMON_PASSWORDS = new Set([
  '123456789012',
  '1234567890123',
  'password1234',
  'password12345',
  'password123!',
  'passwordpassword',
  'qwertyuiopas',
  'qwerty123456',
  '1q2w3e4r5t6y',
  'iloveyou1234',
  'letmein12345',
  'welcome12345',
  'administrator',
  'changeme1234',
  'abc123456789',
  'aaaaaaaaaaaa',
  '111111111111',
  '000000000000',
  'trustno1trustno1',
  'opentradie123',
  'opentradie1234',
  'football1234',
  'baseball1234',
  'sunshine1234',
  'princess1234',
  'monkey123456',
  'dragon123456',
  'master123456',
  'superman1234',
  'correcthorsebatterystaple',
]);

/** Null when acceptable, otherwise a plain-language reason. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH)
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 256) return 'Use at most 256 characters.';
  if (COMMON_PASSWORDS.has(password.toLowerCase()))
    return 'That password is too common. Choose something less predictable.';
  return null;
}
