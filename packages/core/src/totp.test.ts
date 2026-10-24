import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  hashRecoveryCode,
  hotp,
  newRecoveryCodes,
  otpauthUri,
  passwordNeedsRehash,
  passwordProblem,
  totp,
  verifyTotp,
} from './index.js';

// RFC 6238 Appendix B, SHA-1 mode: the 20-byte ASCII key "12345678901234567890", 8 digits.
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP (RFC 6238, SHA-1)', () => {
  it.each(RFC_VECTORS)('matches the RFC 6238 vector at T=%i', (time, expected) => {
    expect(totp(RFC_KEY, time, 8)).toBe(expected);
  });

  it('matches the RFC 4226 HOTP vectors (6 digits)', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314'];
    expected.forEach((code, counter) => expect(hotp(RFC_KEY, counter)).toBe(code));
  });

  it('accepts the current step and one either side, and returns the matched step', () => {
    const now = 1_700_000_000;
    const step = Math.floor(now / 30);
    expect(verifyTotp(RFC_KEY, totp(RFC_KEY, now), now)).toBe(step);
    expect(verifyTotp(RFC_KEY, totp(RFC_KEY, now - 30), now)).toBe(step - 1);
    expect(verifyTotp(RFC_KEY, totp(RFC_KEY, now + 30), now)).toBe(step + 1);
    expect(verifyTotp(RFC_KEY, totp(RFC_KEY, now - 60), now)).toBeNull();
    expect(verifyTotp(RFC_KEY, '12345', now)).toBeNull();
    expect(verifyTotp(RFC_KEY, 'abcdef', now)).toBeNull();
  });
});

describe('base32 (RFC 4648)', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('encodes %j as %s (unpadded) and back', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain))).toBe(encoded);
    expect(base32Decode(encoded).toString()).toBe(plain);
  });

  it('decodes lower case, spaces and padding; rejects other characters', () => {
    expect(base32Decode('mzxw 6ytb oi======').toString()).toBe('foobar');
    expect(() => base32Decode('MZXW1')).toThrow();
    expect(base32Encode(RFC_KEY)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });
});

describe('recovery codes, otpauth URI and password rules', () => {
  it('makes ten distinct codes whose hash ignores case, spaces and dashes', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
    expect(hashRecoveryCode(codes[0]!.toUpperCase().replace('-', ' '))).toBe(
      hashRecoveryCode(codes[0]!),
    );
  });

  it('builds an authenticator URI with explicit parameters', () => {
    expect(otpauthUri('ABC', 'owner@example.test', 'OPENTRADIE')).toBe(
      'otpauth://totp/OPENTRADIE%3Aowner%40example.test?secret=ABC&issuer=OPENTRADIE&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('rejects short and common passwords and flags weak scrypt parameters for rehash', () => {
    expect(passwordProblem('short')).toMatch(/12 characters/);
    expect(passwordProblem('Password1234')).toMatch(/too common/);
    expect(passwordProblem('a distinctive phrase here')).toBeNull();
    expect(passwordNeedsRehash('scrypt$1024$8$1$aa$bb')).toBe(true);
    expect(passwordNeedsRehash('scrypt$16384$8$1$aa$bb')).toBe(false);
  });
});
