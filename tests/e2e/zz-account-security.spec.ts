import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';

/**
 * Account security journey (ADR 0031): a viewer turns on TOTP two-factor in Settings › Security,
 * signs out, and signs back in with a code computed here from the shown secret (RFC 6238).
 * The viewer account is used so other journeys keep signing the owner in with a password; the
 * test turns two-factor off again at the end with a recovery code.
 */
const viewer = {
  email: process.env.VIEWER_EMAIL ?? 'viewer@demo.opentradie.test',
  password: process.env.VIEWER_PASSWORD ?? '',
};

function base32(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret: Buffer, unixSeconds: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(unixSeconds / 30)));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

test.describe.configure({ timeout: 240_000 });

test('a user turns on two-factor sign-in, signs out, and signs in with a code', async ({
  page,
}) => {
  test.skip(!viewer.password, 'Set VIEWER_PASSWORD (pnpm setup:dev writes it to .env).');
  // The login route allows 10 attempts a minute across the whole suite: wait out a 429.
  const signInWithPassword = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.getByLabel('Email').fill(viewer.email);
      await page.getByLabel('Password').fill(viewer.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      const limited = page.getByText('Too many requests');
      const outcome = await Promise.race([
        limited
          .waitFor()
          .then(() => 'limited')
          .catch(() => 'none'),
        page
          .getByRole('navigation', { name: 'Main' })
          .waitFor()
          .then(() => 'in')
          .catch(() => 'none'),
        page
          .getByRole('heading', { name: 'Two-factor code' })
          .waitFor()
          .then(() => 'mfa')
          .catch(() => 'none'),
      ]);
      if (outcome !== 'limited') return;
      await page.waitForTimeout(61_000);
    }
    throw new Error('sign-in kept being rate limited');
  };
  await page.goto('/');
  await signInWithPassword();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  await page.goto('/#/settings');
  await page.getByRole('link', { name: 'Security' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
  await page.getByRole('button', { name: 'Set up two-factor' }).click();
  const secret = base32((await page.getByTestId('totp-secret').textContent())!.trim());
  // The previous step's code (accepted for clock drift) keeps the current one free for sign-in.
  await page.getByLabel('6-digit code from the app').fill(totp(secret, Date.now() / 1000 - 30));
  await page.getByRole('button', { name: 'Turn on two-factor' }).click();
  const codes = page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem');
  await expect(codes).toHaveCount(10);
  const recovery = (await codes.first().textContent())!.trim();
  await page.getByRole('button', { name: 'I have saved them' }).click();
  await expect(page.getByText(/Two-factor sign-in is on\. 10 unused/)).toBeVisible();

  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signInWithPassword();
  await expect(page.getByRole('heading', { name: 'Two-factor code' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await page.getByLabel(/Code from your authenticator app/).fill(totp(secret, Date.now() / 1000));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  // Leave the shared demo account as it was: turn two-factor off with a recovery code.
  await page.goto('/#/settings/security');
  const off = page.getByRole('form', { name: 'Turn off two-factor' });
  await off.getByLabel('Password').fill(viewer.password);
  await off.getByLabel(/recovery code/).fill(recovery);
  await off.getByRole('button', { name: 'Turn off two-factor' }).click();
  await expect(page.getByText('Two-factor sign-in is off.')).toBeVisible();
});
