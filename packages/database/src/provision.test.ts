import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  OWNER_EMAIL_PATTERN,
  validateProvisionOptions,
  type ProvisionOptions,
} from './provision.js';

function options(ownerEmail: string): ProvisionOptions {
  return {
    tenantId: randomUUID(),
    businessName: 'Kauri Electrical',
    trade: 'electrician',
    ownerEmail,
    ownerPassword: 'a-long-enough-password',
    gstRegistered: false,
    gstNumber: null,
    pricesEntered: 'exclusive',
    rates: [],
  };
}

describe('validateProvisionOptions owner email', () => {
  it('accepts ordinary addresses and rejects malformed ones', () => {
    // A missing rate card is a separate check; here only the email must be accepted.
    expect(OWNER_EMAIL_PATTERN.test('owner@kauri.co.nz')).toBe(true);
    expect(() => validateProvisionOptions(options('owner@kauri.co.nz'))).not.toThrow(/email/);
    for (const bad of ['owner', 'owner@', 'owner@kauri', 'owner@kauri.', 'owner@.nz', 'a b@c.nz'])
      expect(() => validateProvisionOptions(options(bad))).toThrow(/not an email address/);
  });

  it('checks a long hostile address in linear time (CodeQL polynomial regex)', () => {
    // The 254-character limit is checked first; the pattern itself must also stay linear.
    const hostile = '!@!.' + '!.'.repeat(100_000) + ' ';
    const started = performance.now();
    expect(OWNER_EMAIL_PATTERN.test(hostile)).toBe(false);
    expect(() => validateProvisionOptions(options(hostile))).toThrow(/not an email address/);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
