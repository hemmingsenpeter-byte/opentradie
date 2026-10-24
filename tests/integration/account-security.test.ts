import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { base32Decode, totp } from '@opentradie/core';
import { FakeMailAdapter, fakeMailConnections } from '@opentradie/integrations/mail';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER, TENANT_A, VIEWER, type TestContext } from '../helpers/app.js';

const run = promisify(execFile);
const KEY_ENV = {
  CREDENTIAL_ENCRYPTION_KEY: '0000000000000000000000000000000000000000000000000000000000000002',
};
const NEW_PASSWORD = 'a much better passphrase 42';

let address = 0;
/** Each call comes from its own address so per-route rate limits only bite where tested. */
const from = () => `10.1.${Math.floor(++address / 250)}.${address % 250}`;

async function inject(
  ctx: TestContext,
  method: 'POST' | 'GET' | 'DELETE',
  url: string,
  payload?: object,
  cookie?: string,
  remoteAddress = from(),
) {
  const response = await ctx.app.inject({
    method,
    url,
    remoteAddress,
    headers: { origin: ctx.config.appOrigin, ...(cookie ? { cookie } : {}) },
    ...(payload ? { payload } : {}),
  });
  const session = response.cookies.find((c) => c.name === 'opentradie_session');
  return {
    status: response.statusCode,
    body: response.body ? JSON.parse(response.body) : null,
    cookie: session?.value ? `opentradie_session=${session.value}` : null,
  };
}

const login = (ctx: TestContext, email: string, password: string) =>
  inject(ctx, 'POST', '/api/auth/login', { email, password });

const audits = async (ctx: TestContext, action: string) =>
  (
    await ctx.db.pool.query<{ metadata: Record<string, unknown>; actorType: string }>(
      `SELECT metadata,actor_type AS "actorType" FROM audit_events WHERE tenant_id=$1 AND action=$2 ORDER BY created_at`,
      [TENANT_A, action],
    )
  ).rows;

/** Waits for the deferred reset email (the request returns 202 before it is sent). */
async function nextEmail(adapter: FakeMailAdapter, count: number) {
  for (let i = 0; i < 100 && adapter.sent.length < count; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 20));
  return adapter.sent[count - 1];
}

describe('account security: password change, reset, TOTP and sessions', () => {
  let ctx: TestContext;
  const adapter = new FakeMailAdapter();
  let password = OWNER.password;

  beforeAll(async () => {
    ctx = await createTestContext({ env: KEY_ENV, mail: fakeMailConnections(adapter) });
  });
  afterAll(async () => ctx?.close());

  it('changes the password: wrong current, weak, common and unchanged are refused; other sessions end', async () => {
    const a = (await login(ctx, OWNER.email, password)).cookie!;
    const b = (await login(ctx, OWNER.email, password)).cookie!;
    const change = (body: object) => inject(ctx, 'POST', '/api/auth/password', body, a);
    expect(
      (await change({ currentPassword: 'wrong-password-123', newPassword: NEW_PASSWORD })).body
        .error,
    ).toBe('INVALID_CURRENT_PASSWORD');
    expect((await change({ currentPassword: password, newPassword: 'short' })).body.error).toBe(
      'WEAK_PASSWORD',
    );
    expect(
      (await change({ currentPassword: password, newPassword: 'password1234' })).body.error,
    ).toBe('WEAK_PASSWORD');
    expect((await change({ currentPassword: password, newPassword: password })).body.error).toBe(
      'PASSWORD_UNCHANGED',
    );
    const changed = await change({ currentPassword: password, newPassword: NEW_PASSWORD });
    expect(changed.status).toBe(200);
    expect(changed.body.otherSessionsRevoked).toBeGreaterThanOrEqual(1);
    password = NEW_PASSWORD;
    expect((await inject(ctx, 'GET', '/api/me', undefined, a)).status).toBe(200);
    expect((await inject(ctx, 'GET', '/api/me', undefined, b)).status).toBe(401);
    expect((await login(ctx, OWNER.email, OWNER.password)).status).toBe(401);
    expect((await login(ctx, OWNER.email, password)).status).toBe(200);
    const [audit] = await audits(ctx, 'auth.password_changed');
    expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
  });

  it('lists only my sessions (family, no IP) and revokes one; others are 404', async () => {
    const mine = (await login(ctx, OWNER.email, password)).cookie!;
    const listed = await inject(ctx, 'GET', '/api/auth/sessions', undefined, mine);
    expect(listed.status).toBe(200);
    const current = listed.body.sessions.find((s: { current: boolean }) => s.current);
    expect(current).toMatchObject({ userAgentFamily: expect.any(String), mfaVerified: false });
    expect(JSON.stringify(listed.body)).not.toMatch(/10\.1\.|127\.0\.0\.1/);
    const other = listed.body.sessions.find((s: { current: boolean }) => !s.current);

    const viewer = (await login(ctx, VIEWER.email, VIEWER.password)).cookie!;
    const viewerSessions = await inject(ctx, 'GET', '/api/auth/sessions', undefined, viewer);
    expect(viewerSessions.body.sessions.map((s: { id: string }) => s.id)).not.toContain(current.id);
    // A viewer manages their own account but cannot revoke the owner's sessions.
    expect(
      (await inject(ctx, 'DELETE', `/api/auth/sessions/${current.id}`, undefined, viewer)).status,
    ).toBe(404);
    expect(
      (await inject(ctx, 'DELETE', `/api/auth/sessions/${other.id}`, undefined, mine)).status,
    ).toBe(200);
    expect(
      (await inject(ctx, 'DELETE', `/api/auth/sessions/${current.id}`, undefined, mine)).status,
    ).toBe(200);
    expect((await inject(ctx, 'GET', '/api/me', undefined, mine)).status).toBe(401);
  });

  it('a viewer can change their own password', async () => {
    const viewer = (await login(ctx, VIEWER.email, VIEWER.password)).cookie!;
    const changed = await inject(
      ctx,
      'POST',
      '/api/auth/password',
      { currentPassword: VIEWER.password, newPassword: 'viewer passphrase changed 7' },
      viewer,
    );
    expect(changed.status).toBe(200);
    expect((await login(ctx, VIEWER.email, 'viewer passphrase changed 7')).status).toBe(200);
  });

  it('emailed reset: same 202 for unknown emails, single use, expiry, token never stored raw', async () => {
    const unknown = await inject(ctx, 'POST', '/api/auth/password-reset/request', {
      email: 'nobody@example.test',
    });
    const known = await inject(ctx, 'POST', '/api/auth/password-reset/request', {
      email: OWNER.email.toUpperCase(),
    });
    expect(unknown).toEqual({ ...known });
    expect(known.status).toBe(202);
    const email = await nextEmail(adapter, 1);
    expect(adapter.sent).toHaveLength(1);
    expect(email!.to[0]!.address).toBe(OWNER.email);
    const token = /token=([A-Za-z0-9_-]+)/.exec(email!.text)![1]!;
    const stored = await ctx.db.pool.query(
      "SELECT token_hash FROM auth_tokens WHERE purpose='password_reset'",
    );
    expect(JSON.stringify(stored.rows)).not.toContain(token);
    expect(ctx.logs.join('')).not.toContain(token);

    const session = (await login(ctx, OWNER.email, password)).cookie!;
    const confirm = (t: string, newPassword = 'reset passphrase number 1') =>
      inject(ctx, 'POST', '/api/auth/password-reset/confirm', { token: t, newPassword });
    expect((await confirm(token, 'short')).body.error).toBe('WEAK_PASSWORD');
    expect((await confirm(token)).status).toBe(200);
    password = 'reset passphrase number 1';
    expect((await confirm(token, 'another passphrase 22')).body.error).toBe('INVALID_RESET_TOKEN');
    expect((await inject(ctx, 'GET', '/api/me', undefined, session)).status).toBe(401);
    expect((await login(ctx, OWNER.email, password)).status).toBe(200);

    // Expired links are refused.
    await inject(ctx, 'POST', '/api/auth/password-reset/request', { email: OWNER.email });
    const second = await nextEmail(adapter, 2);
    const expired = /token=([A-Za-z0-9_-]+)/.exec(second!.text)![1]!;
    await ctx.db.pool.query(
      "UPDATE auth_tokens SET expires_at=now()-interval '1 second' WHERE purpose='password_reset' AND used_at IS NULL",
    );
    expect((await confirm(expired)).body.error).toBe('INVALID_RESET_TOKEN');
    expect((await audits(ctx, 'auth.password_reset_requested')).map((a) => a.actorType)).toEqual([
      'system',
      'system',
    ]);
  });

  it('rate limits reset requests', async () => {
    const ip = '10.9.9.9';
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1)
      statuses.push(
        (
          await inject(
            ctx,
            'POST',
            '/api/auth/password-reset/request',
            { email: 'nobody@example.test' },
            undefined,
            ip,
          )
        ).status,
      );
    expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(statuses.at(-1)).toBe(429);
  });

  it('TOTP: enrol, two-step login, replay refused, recovery code single use, disable', async () => {
    const session = (await login(ctx, OWNER.email, password)).cookie!;
    const setup = await inject(ctx, 'POST', '/api/auth/mfa/totp/setup', {}, session);
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/OPENTRADIE%3A.*secret=/);
    const secret = base32Decode(setup.body.secret);
    const stored = await ctx.db.pool.query<{ c: Buffer }>(
      'SELECT secret_ciphertext AS c FROM user_mfa',
    );
    expect(stored.rows[0]!.c.includes(secret)).toBe(false);
    const now = () => Date.now() / 1000;
    expect(
      (await inject(ctx, 'POST', '/api/auth/mfa/totp/confirm', { code: '000000' }, session)).body
        .error,
    ).toBe('INVALID_CODE');
    // Use the previous step so the next login can use the current one (replay protection).
    const confirmed = await inject(
      ctx,
      'POST',
      '/api/auth/mfa/totp/confirm',
      { code: totp(secret, now() - 30) },
      session,
    );
    expect(confirmed.status).toBe(200);
    const recovery: string[] = confirmed.body.recoveryCodes;
    expect(recovery).toHaveLength(10);
    expect((await inject(ctx, 'POST', '/api/auth/mfa/totp/setup', {}, session)).body.error).toBe(
      'MFA_ALREADY_ENABLED',
    );
    const hashes = await ctx.db.pool.query('SELECT code_hash FROM user_recovery_codes');
    expect(JSON.stringify(hashes.rows)).not.toContain(recovery[0]);

    // Password alone no longer signs in.
    const first = await login(ctx, OWNER.email, password);
    expect(first.status).toBe(202);
    expect(first.cookie).toBeNull();
    const verify = (mfaToken: string, code: string) =>
      inject(ctx, 'POST', '/api/auth/mfa/verify', { mfaToken, code });
    expect((await verify(first.body.mfaToken, '123456')).body.error).toBe('INVALID_CODE');
    const code = totp(secret, now());
    const signedIn = await verify(first.body.mfaToken, code);
    expect(signedIn.status).toBe(200);
    expect(signedIn.cookie).not.toBeNull();
    const sessions = await inject(ctx, 'GET', '/api/auth/sessions', undefined, signedIn.cookie!);
    expect(sessions.body.sessions.find((s: { current: boolean }) => s.current).mfaVerified).toBe(
      true,
    );
    // The pending token is single use, and the same code cannot be replayed in its step.
    expect((await verify(first.body.mfaToken, code)).body.error).toBe('MFA_TOKEN_EXPIRED');
    const again = await login(ctx, OWNER.email, password);
    expect((await verify(again.body.mfaToken, code)).body.error).toBe('INVALID_CODE');

    // Recovery codes work once.
    expect(
      (await verify(again.body.mfaToken, recovery[0]!.toUpperCase())).body.usedRecoveryCode,
    ).toBe(true);
    const third = await login(ctx, OWNER.email, password);
    expect((await verify(third.body.mfaToken, recovery[0]!)).body.error).toBe('INVALID_CODE');

    // Too many wrong codes end the pending token; expired tokens are refused.
    for (let i = 0; i < 4; i += 1) await verify(third.body.mfaToken, '000000');
    expect((await verify(third.body.mfaToken, recovery[1]!)).body.error).toBe('MFA_TOKEN_EXPIRED');
    const fourth = await login(ctx, OWNER.email, password);
    await ctx.db.pool.query(
      "UPDATE auth_tokens SET expires_at=now()-interval '1 second' WHERE purpose='mfa_login' AND used_at IS NULL",
    );
    expect((await verify(fourth.body.mfaToken, recovery[1]!)).body.error).toBe('MFA_TOKEN_EXPIRED');

    // Disabling needs the password and a code.
    const disable = (body: object) =>
      inject(ctx, 'POST', '/api/auth/mfa/disable', body, signedIn.cookie!);
    expect((await disable({ password: 'wrong password 123', code: recovery[2]! })).status).toBe(
      400,
    );
    expect((await disable({ password, code: '000000' })).status).toBe(400);
    expect((await disable({ password, code: recovery[2]! })).status).toBe(200);
    expect((await login(ctx, OWNER.email, password)).status).toBe(200);
    const actions = (
      await ctx.db.pool.query(
        "SELECT action FROM audit_events WHERE action LIKE 'auth.mfa%' ORDER BY created_at",
      )
    ).rows.map((r) => r.action);
    expect(actions).toEqual(['auth.mfa_setup_started', 'auth.mfa_enabled', 'auth.mfa_disabled']);
  });

  it('rate limits the MFA verify step', async () => {
    const ip = '10.8.8.8';
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1)
      statuses.push(
        (
          await inject(
            ctx,
            'POST',
            '/api/auth/mfa/verify',
            { mfaToken: 'x'.repeat(43), code: '000000' },
            undefined,
            ip,
          )
        ).status,
      );
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('pnpm owner:reset-password resets from a file, revokes sessions, and keeps MFA unless asked', async () => {
    const session = (await login(ctx, OWNER.email, password)).cookie!;
    const setup = await inject(ctx, 'POST', '/api/auth/mfa/totp/setup', {}, session);
    const secret = base32Decode(setup.body.secret);
    await inject(
      ctx,
      'POST',
      '/api/auth/mfa/totp/confirm',
      { code: totp(secret, Date.now() / 1000 - 30) },
      session,
    );
    const dir = await mkdtemp(join(tmpdir(), 'opentradie-reset-'));
    const file = join(dir, 'password');
    await writeFile(file, 'operator reset passphrase 9\n');
    const env = {
      ...process.env,
      DATABASE_URL: ctx.url,
      TENANT_ID: TENANT_A,
      NEW_PASSWORD_FILE: file,
    };
    await expect(
      run(
        'npx',
        ['tsx', 'scripts/owner-reset-password.ts', '--email', OWNER.email, '--password', 'x'],
        { env },
      ),
    ).rejects.toMatchObject({ code: 2 });
    const reset = await run(
      'npx',
      ['tsx', 'scripts/owner-reset-password.ts', '--email', OWNER.email],
      { env },
    );
    expect(reset.stdout).toMatch(/Two-factor sign-in unchanged/);
    expect((await inject(ctx, 'GET', '/api/me', undefined, session)).status).toBe(401);
    expect((await login(ctx, OWNER.email, 'operator reset passphrase 9')).status).toBe(202);
    const off = await run(
      'npx',
      ['tsx', 'scripts/owner-reset-password.ts', '--email', OWNER.email, '--disable-mfa'],
      { env },
    );
    expect(off.stdout).toMatch(/turned off/);
    expect((await login(ctx, OWNER.email, 'operator reset passphrase 9')).status).toBe(200);
    const audit = await audits(ctx, 'auth.password_reset_by_operator');
    expect(audit.map((a) => [a.actorType, a.metadata.mfaDisabled])).toEqual([
      ['system', false],
      ['system', true],
    ]);
    expect(JSON.stringify(audit)).not.toContain('operator reset passphrase');
  }, 60_000);
});

describe('REQUIRE_OWNER_MFA and installations without a credential key', () => {
  it('blocks an unenrolled owner from app routes until two-factor is on', async () => {
    const ctx = await createTestContext({ env: { ...KEY_ENV, REQUIRE_OWNER_MFA: 'true' } });
    try {
      const owner = (await login(ctx, OWNER.email, OWNER.password)).cookie!;
      expect((await inject(ctx, 'GET', '/api/customers', undefined, owner)).body.error).toBe(
        'MFA_ENROLMENT_REQUIRED',
      );
      expect(
        (await inject(ctx, 'GET', '/api/auth/account', undefined, owner)).body.mfaEnrolmentRequired,
      ).toBe(true);
      const viewer = (await login(ctx, VIEWER.email, VIEWER.password)).cookie!;
      expect((await inject(ctx, 'GET', '/api/customers', undefined, viewer)).status).toBe(200);
      const setup = await inject(ctx, 'POST', '/api/auth/mfa/totp/setup', {}, owner);
      const code = totp(base32Decode(setup.body.secret), Date.now() / 1000);
      expect(
        (await inject(ctx, 'POST', '/api/auth/mfa/totp/confirm', { code }, owner)).status,
      ).toBe(200);
      expect((await inject(ctx, 'GET', '/api/customers', undefined, owner)).status).toBe(200);
      expect(
        (
          await inject(
            ctx,
            'POST',
            '/api/auth/mfa/disable',
            { password: OWNER.password, code: '000000' },
            owner,
          )
        ).body.error,
      ).toBe('MFA_REQUIRED');
    } finally {
      await ctx.close();
    }
  });

  it('refuses MFA set-up without CREDENTIAL_ENCRYPTION_KEY, and the reset request still answers 202', async () => {
    const ctx = await createTestContext();
    try {
      const owner = (await login(ctx, OWNER.email, OWNER.password)).cookie!;
      expect((await inject(ctx, 'POST', '/api/auth/mfa/totp/setup', {}, owner)).body.error).toBe(
        'MFA_UNAVAILABLE',
      );
      expect(
        (await inject(ctx, 'POST', '/api/auth/password-reset/request', { email: OWNER.email }))
          .status,
      ).toBe(202);
    } finally {
      await ctx.close();
    }
  });
});
