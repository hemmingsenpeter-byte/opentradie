import {
  base32Encode,
  hashPassword,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  passwordProblem,
  verifyPassword,
  verifyTotp,
} from '@opentradie/core';
import {
  clearUserMfa,
  recordAudit,
  transaction,
  type Database,
  type Queryable,
} from '@opentradie/database';
import {
  createKeyring,
  openCredentials,
  sealCredentials,
  type CredentialKeyring,
} from '@opentradie/integrations';
import type { MailConnections } from '@opentradie/integrations/mail';
import type { RuntimeConfig } from '@opentradie/platform';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { HttpError, type RouteRegistry, type UserContext } from '../http.js';
import { errorResponse, userResponse } from '../schemas.js';
import {
  createSession,
  newToken,
  SESSION_COOKIE,
  setSessionCookie,
  tokenHash,
} from '../services/sessions.js';

export const RESET_TOKEN_MINUTES = 30;
const MAX_MFA_ATTEMPTS = 5;
const MAX_OPEN_RESETS = 3;

const password = z.string().min(1).max(256);
const code = z.string().trim().min(6).max(32);
const ok = z.object({ ok: z.literal(true) });

/**
 * Account security (ADR 0031): change password, emailed reset, TOTP two-factor with recovery
 * codes, and session management. Every route acts on the signed-in user's own account only, so
 * viewers may use them. These routes are deliberately not Idempotency-Key replayed: replay would
 * persist a hash of a body that contains a password and cache responses holding secrets.
 */
export function registerAccountRoutes(
  api: RouteRegistry,
  deps: { db: Database; config: RuntimeConfig; mail: MailConnections },
) {
  const { db, config } = deps;
  const keyring: CredentialKeyring | null = config.credentialKeys
    ? createKeyring(config.credentialKeys.activeKeyId, config.credentialKeys.keys)
    : null;
  const binding = (user: { tenantId: string; id: string }) => ({
    tenantId: user.tenantId,
    provider: `totp:${user.id}`,
  });

  const loadHash = async (user: UserContext) =>
    (
      await db.pool.query<{ hash: string }>(
        'SELECT password_hash AS hash FROM users WHERE tenant_id=$1 AND id=$2',
        [user.tenantId, user.id],
      )
    ).rows[0]!.hash;

  /** TOTP (replay-protected per step) or an unused recovery code. Consumes what it accepts. */
  async function checkSecondFactor(
    client: Queryable,
    user: { tenantId: string; id: string },
    supplied: string,
  ): Promise<'totp' | 'recovery' | null> {
    const row = (
      await client.query<{ keyId: string; ciphertext: Buffer }>(
        `SELECT secret_key_id AS "keyId",secret_ciphertext AS ciphertext FROM user_mfa
         WHERE tenant_id=$1 AND user_id=$2 AND enabled_at IS NOT NULL`,
        [user.tenantId, user.id],
      )
    ).rows[0];
    if (!row || !keyring) return null;
    const digits = supplied.replace(/\s/g, '');
    if (/^\d{6}$/.test(digits)) {
      const secret = Buffer.from(openCredentials(row, keyring, binding(user)), 'base64');
      const step = verifyTotp(secret, digits, Date.now() / 1000);
      if (step === null) return null;
      const used = await client.query(
        `UPDATE user_mfa SET last_used_step=$3 WHERE tenant_id=$1 AND user_id=$2
         AND (last_used_step IS NULL OR last_used_step < $3)`,
        [user.tenantId, user.id, step],
      );
      return used.rowCount ? 'totp' : null;
    }
    const consumed = await client.query(
      `UPDATE user_recovery_codes SET used_at=now()
       WHERE tenant_id=$1 AND user_id=$2 AND code_hash=$3 AND used_at IS NULL`,
      [user.tenantId, user.id, hashRecoveryCode(supplied)],
    );
    return consumed.rowCount ? 'recovery' : null;
  }

  async function setPassword(
    client: Queryable,
    user: { tenantId: string; id: string },
    newPassword: string,
  ) {
    await client.query(
      'UPDATE users SET password_hash=$3,password_changed_at=now() WHERE tenant_id=$1 AND id=$2',
      [user.tenantId, user.id, await hashPassword(newPassword)],
    );
  }

  const requireAcceptable = (newPassword: string) => {
    const problem = passwordProblem(newPassword);
    if (problem) throw new HttpError(400, 'WEAK_PASSWORD', problem);
  };

  api.route(
    {
      method: 'GET',
      url: '/api/auth/account',
      summary: 'Two-factor status for the signed-in user (own account only)',
      tags: ['auth'],
      auth: 'user',
      responses: {
        200: {
          description: 'Account security status',
          schema: z.object({
            mfaEnabled: z.boolean(),
            mfaAvailable: z.boolean(),
            mfaEnrolmentRequired: z.boolean(),
            recoveryCodesRemaining: z.number().int(),
          }),
        },
      },
    },
    async ({ user, request }) => {
      const status = await db.pool.query<{ enabled: boolean; remaining: number }>(
        `SELECT EXISTS (SELECT 1 FROM user_mfa WHERE tenant_id=$1 AND user_id=$2 AND enabled_at IS NOT NULL) AS enabled,
                (SELECT count(*)::int FROM user_recovery_codes WHERE tenant_id=$1 AND user_id=$2 AND used_at IS NULL) AS remaining`,
        [user.tenantId, user.id],
      );
      return {
        body: {
          mfaEnabled: status.rows[0]!.enabled,
          mfaAvailable: keyring !== null,
          mfaEnrolmentRequired: request.mfaEnrolmentRequired,
          recoveryCodesRemaining: status.rows[0]!.remaining,
        },
      };
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/auth/password',
      summary:
        'Change your own password (current password required). Signs out every other session. Rate limited.',
      tags: ['auth'],
      auth: 'user',
      body: z.object({ currentPassword: password, newPassword: password }).strict(),
      rateLimit: { max: 10, timeWindow: '1 minute' },
      responses: {
        200: { description: 'Changed', schema: z.object({ otherSessionsRevoked: z.number() }) },
        400: {
          description: 'INVALID_CURRENT_PASSWORD, WEAK_PASSWORD or PASSWORD_UNCHANGED',
          schema: errorResponse,
        },
      },
    },
    async ({ user, body, request }) => {
      if (!(await verifyPassword(body.currentPassword, await loadHash(user))))
        throw new HttpError(400, 'INVALID_CURRENT_PASSWORD', 'Your current password is incorrect.');
      requireAcceptable(body.newPassword);
      if (body.newPassword === body.currentPassword)
        throw new HttpError(400, 'PASSWORD_UNCHANGED', 'Choose a password you are not using now.');
      const revoked = await transaction(db, async (client) => {
        await setPassword(client, user, body.newPassword);
        const others = await client.query(
          'DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2 AND id<>$3',
          [user.tenantId, user.id, request.sessionId],
        );
        await client.query('DELETE FROM auth_tokens WHERE tenant_id=$1 AND user_id=$2', [
          user.tenantId,
          user.id,
        ]);
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'auth.password_changed',
          entityType: 'user',
          entityId: user.id,
          requestId: request.id,
          metadata: { otherSessionsRevoked: others.rowCount ?? 0 },
        });
        return others.rowCount ?? 0;
      });
      return { body: { otherSessionsRevoked: revoked } };
    },
  );

  /**
   * Emailed reset link. The response is the same 202 whether or not the email exists, a mail
   * connection exists, or a link was sent, and the work happens after the response so timing
   * does not reveal it either. The token is sent only in the email and stored as a SHA-256 hash.
   */
  async function sendResetLink(email: string, requestId: string, log: FastifyBaseLogger) {
    const found = await db.pool.query<{ id: string; tenantId: string; displayName: string }>(
      `SELECT id,tenant_id AS "tenantId",display_name AS "displayName" FROM users
       WHERE tenant_id=$1 AND email=$2 AND active=true`,
      [config.tenantId, email],
    );
    const user = found.rows[0];
    if (!user) return;
    const provider = await deps.mail.forTenant(user.tenantId).catch(() => null);
    const open = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth_tokens WHERE tenant_id=$1 AND user_id=$2
       AND purpose='password_reset' AND used_at IS NULL AND expires_at>now()`,
      [user.tenantId, user.id],
    );
    const outcome = !provider
      ? 'no_mail_connection'
      : open.rows[0]!.n >= MAX_OPEN_RESETS
        ? 'too_many_open_links'
        : 'sent';
    let delivered = false;
    if (outcome === 'sent' && provider) {
      const token = newToken();
      await db.pool.query(
        `INSERT INTO auth_tokens(token_hash,tenant_id,user_id,purpose,expires_at)
         VALUES($1,$2,$3,'password_reset',now() + interval '${RESET_TOKEN_MINUTES} minutes')`,
        [tokenHash(token), user.tenantId, user.id],
      );
      const link = `${config.appOrigin}/#/reset-password?token=${token}`;
      try {
        await provider.send({
          to: [{ address: email, name: user.displayName }],
          subject: 'Reset your OPENTRADIE password',
          text: `Someone (hopefully you) asked to reset the password for ${email}.\n\nOpen this link within ${RESET_TOKEN_MINUTES} minutes to choose a new password. It works once:\n\n${link}\n\nIf you did not ask for this, ignore this email; your password has not changed.`,
        });
        delivered = true;
      } catch (error) {
        // Class name only: provider errors may echo the message (and so the token).
        log.warn({ requestId, errorClass: (error as Error).name }, 'password reset email failed');
      }
    }
    await recordAudit(db.pool, {
      tenantId: user.tenantId,
      actorType: 'system',
      actorId: null,
      action: 'auth.password_reset_requested',
      entityType: 'user',
      entityId: user.id,
      requestId,
      metadata: { outcome, delivered },
    });
  }

  api.route(
    {
      method: 'POST',
      url: '/api/auth/password-reset/request',
      summary:
        'Ask for a password reset link by email. Always 202 (no account enumeration); sends only when a mail connection exists. Rate limited.',
      tags: ['auth'],
      auth: 'public',
      body: z.object({ email: z.string().trim().email().max(254) }).strict(),
      rateLimit: { max: 5, timeWindow: '1 minute' },
      responses: { 202: { description: 'Accepted', schema: ok } },
    },
    async ({ body, request }) => {
      const email = body.email.toLowerCase();
      setImmediate(() => {
        sendResetLink(email, request.id, request.log).catch((error: Error) =>
          request.log.error({ errorClass: error.name }, 'password reset request failed'),
        );
      });
      return { status: 202, body: { ok: true } };
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      summary:
        'Set a new password with a reset link token (30 minutes, single use). Signs out every session. Rate limited.',
      tags: ['auth'],
      auth: 'public',
      body: z.object({ token: z.string().min(16).max(128), newPassword: password }).strict(),
      rateLimit: { max: 10, timeWindow: '1 minute' },
      responses: {
        200: { description: 'Password changed; sign in again', schema: ok },
        400: { description: 'INVALID_RESET_TOKEN or WEAK_PASSWORD', schema: errorResponse },
      },
    },
    async ({ body, request }) => {
      requireAcceptable(body.newPassword);
      await transaction(db, async (client) => {
        const used = await client.query<{ tenantId: string; id: string }>(
          `UPDATE auth_tokens SET used_at=now() WHERE token_hash=$1 AND tenant_id=$2
           AND purpose='password_reset' AND used_at IS NULL AND expires_at>now()
           RETURNING tenant_id AS "tenantId",user_id AS id`,
          [tokenHash(body.token), config.tenantId],
        );
        const user = used.rows[0];
        if (!user)
          throw new HttpError(
            400,
            'INVALID_RESET_TOKEN',
            'This reset link has expired or was already used. Ask for a new one.',
          );
        await setPassword(client, user, body.newPassword);
        const revoked = await client.query(
          'DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2',
          [user.tenantId, user.id],
        );
        await client.query(
          'DELETE FROM auth_tokens WHERE tenant_id=$1 AND user_id=$2 AND used_at IS NULL',
          [user.tenantId, user.id],
        );
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'auth.password_reset',
          entityType: 'user',
          entityId: user.id,
          requestId: request.id,
          metadata: { sessionsRevoked: revoked.rowCount ?? 0 },
        });
      });
      return { body: { ok: true } };
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/auth/mfa/totp/setup',
      summary:
        'Start TOTP two-factor enrolment: returns an otpauth:// URI and base32 secret (stored encrypted). Confirm with a code to turn it on.',
      tags: ['auth'],
      auth: 'user',
      rateLimit: { max: 10, timeWindow: '1 minute' },
      responses: {
        200: {
          description: 'Secret to add to an authenticator app',
          schema: z.object({ otpauthUri: z.string(), secret: z.string() }),
        },
        409: { description: 'MFA_ALREADY_ENABLED or MFA_UNAVAILABLE', schema: errorResponse },
      },
    },
    async ({ user, request }) => {
      if (!keyring)
        throw new HttpError(
          409,
          'MFA_UNAVAILABLE',
          'Two-factor sign-in needs CREDENTIAL_ENCRYPTION_KEY to be configured on this installation.',
        );
      const raw = newTotpSecret();
      const sealed = sealCredentials(raw.toString('base64'), keyring, binding(user));
      await transaction(db, async (client) => {
        const stored = await client.query(
          `INSERT INTO user_mfa(tenant_id,user_id,secret_key_id,secret_ciphertext) VALUES($1,$2,$3,$4)
           ON CONFLICT (tenant_id,user_id) DO UPDATE
             SET secret_key_id=EXCLUDED.secret_key_id,secret_ciphertext=EXCLUDED.secret_ciphertext,
                 last_used_step=NULL,created_at=now()
             WHERE user_mfa.enabled_at IS NULL`,
          [user.tenantId, user.id, sealed.keyId, sealed.ciphertext],
        );
        if (!stored.rowCount)
          throw new HttpError(409, 'MFA_ALREADY_ENABLED', 'Two-factor sign-in is already on.');
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'auth.mfa_setup_started',
          entityType: 'user',
          entityId: user.id,
          requestId: request.id,
        });
      });
      const secret = base32Encode(raw);
      return { body: { otpauthUri: otpauthUri(secret, user.email, 'OPENTRADIE'), secret } };
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/auth/mfa/totp/confirm',
      summary:
        'Turn on TOTP two-factor with a code from the authenticator app. Returns 10 single-use recovery codes, shown once.',
      tags: ['auth'],
      auth: 'user',
      body: z.object({ code }).strict(),
      rateLimit: { max: 10, timeWindow: '1 minute' },
      responses: {
        200: {
          description: 'Enabled',
          schema: z.object({ recoveryCodes: z.array(z.string()) }),
        },
        400: { description: 'INVALID_CODE or MFA_NOT_STARTED', schema: errorResponse },
      },
    },
    async ({ user, body, request }) => {
      if (!keyring)
        throw new HttpError(409, 'MFA_UNAVAILABLE', 'Two-factor sign-in is not set up.');
      const recoveryCodes = newRecoveryCodes();
      await transaction(db, async (client) => {
        const pending = (
          await client.query<{ keyId: string; ciphertext: Buffer }>(
            `SELECT secret_key_id AS "keyId",secret_ciphertext AS ciphertext FROM user_mfa
             WHERE tenant_id=$1 AND user_id=$2 AND enabled_at IS NULL FOR UPDATE`,
            [user.tenantId, user.id],
          )
        ).rows[0];
        if (!pending) throw new HttpError(400, 'MFA_NOT_STARTED', 'Start two-factor set-up first.');
        const secret = Buffer.from(openCredentials(pending, keyring, binding(user)), 'base64');
        const step = verifyTotp(secret, body.code.replace(/\s/g, ''), Date.now() / 1000);
        if (step === null)
          throw new HttpError(400, 'INVALID_CODE', 'That code did not match. Try the next one.');
        await client.query(
          'UPDATE user_mfa SET enabled_at=now(),last_used_step=$3 WHERE tenant_id=$1 AND user_id=$2',
          [user.tenantId, user.id, step],
        );
        await client.query('DELETE FROM user_recovery_codes WHERE tenant_id=$1 AND user_id=$2', [
          user.tenantId,
          user.id,
        ]);
        for (const recovery of recoveryCodes)
          await client.query(
            'INSERT INTO user_recovery_codes(tenant_id,user_id,code_hash) VALUES($1,$2,$3)',
            [user.tenantId, user.id, hashRecoveryCode(recovery)],
          );
        await client.query('UPDATE sessions SET mfa_verified=true WHERE tenant_id=$1 AND id=$2', [
          user.tenantId,
          request.sessionId,
        ]);
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'auth.mfa_enabled',
          entityType: 'user',
          entityId: user.id,
          requestId: request.id,
          metadata: { method: 'totp', recoveryCodes: recoveryCodes.length },
        });
      });
      request.mfaEnrolmentRequired = false;
      return { body: { recoveryCodes } };
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/auth/mfa/disable',
      summary: 'Turn off two-factor sign-in (password and a current code or recovery code).',
      tags: ['auth'],
      auth: 'user',
      body: z.object({ password, code }).strict(),
      rateLimit: { max: 10, timeWindow: '1 minute' },
      responses: {
        200: { description: 'Disabled', schema: ok },
        400: { description: 'INVALID_CREDENTIALS', schema: errorResponse },
        409: { description: 'MFA_REQUIRED by REQUIRE_OWNER_MFA', schema: errorResponse },
      },
    },
    async ({ user, body, request }) => {
      if (config.requireOwnerMfa && user.role === 'owner')
        throw new HttpError(
          409,
          'MFA_REQUIRED',
          'This installation requires two-factor sign-in for owners (REQUIRE_OWNER_MFA).',
        );
      if (!(await verifyPassword(body.password, await loadHash(user))))
        throw new HttpError(400, 'INVALID_CREDENTIALS', 'Password or code is incorrect.');
      await transaction(db, async (client) => {
        if (!(await checkSecondFactor(client, user, body.code)))
          throw new HttpError(400, 'INVALID_CREDENTIALS', 'Password or code is incorrect.');
        await clearUserMfa(client, user.tenantId, user.id);
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'auth.mfa_disabled',
          entityType: 'user',
          entityId: user.id,
          requestId: request.id,
        });
      });
      return { body: { ok: true } };
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/auth/mfa/verify',
      summary:
        'Second sign-in step: the pending token from login (5 minutes, single use, 5 attempts) plus a TOTP or recovery code. Sets the session cookie. Rate limited.',
      tags: ['auth'],
      auth: 'public',
      body: z.object({ mfaToken: z.string().min(16).max(128), code }).strict(),
      rateLimit: { max: 10, timeWindow: '1 minute' },
      responses: {
        200: {
          description: 'Signed in',
          schema: z.object({ user: userResponse, usedRecoveryCode: z.boolean() }),
        },
        401: { description: 'INVALID_CODE or MFA_TOKEN_EXPIRED', schema: errorResponse },
      },
    },
    async ({ body, request, reply }) => {
      const hash = tokenHash(body.mfaToken);
      const pending = (
        await db.pool.query<{ tenantId: string; id: string; attempts: number }>(
          `UPDATE auth_tokens SET attempts=attempts+1 WHERE token_hash=$1 AND tenant_id=$2
           AND purpose='mfa_login' AND used_at IS NULL AND expires_at>now()
           RETURNING tenant_id AS "tenantId",user_id AS id,attempts`,
          [hash, config.tenantId],
        )
      ).rows[0];
      if (!pending || pending.attempts > MAX_MFA_ATTEMPTS) {
        if (pending)
          await db.pool.query('UPDATE auth_tokens SET used_at=now() WHERE token_hash=$1', [hash]);
        throw new HttpError(
          401,
          'MFA_TOKEN_EXPIRED',
          'This sign-in attempt has expired. Enter your password again.',
        );
      }
      const result = await transaction(db, async (client) => {
        const method = await checkSecondFactor(client, pending, body.code);
        if (!method) return null;
        const consumed = await client.query(
          'UPDATE auth_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL',
          [hash],
        );
        if (!consumed.rowCount) return null;
        const user = (
          await client.query<UserContext>(
            `SELECT id,tenant_id AS "tenantId",email,display_name AS "displayName",role FROM users
             WHERE tenant_id=$1 AND id=$2 AND active=true`,
            [pending.tenantId, pending.id],
          )
        ).rows[0];
        if (!user) return null;
        const token = await createSession(client, {
          tenantId: user.tenantId,
          userId: user.id,
          userAgent: request.headers['user-agent'],
          mfaVerified: true,
        });
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'session.login',
          entityType: 'user',
          entityId: user.id,
          requestId: request.id,
          metadata: { mfa: method },
        });
        return { user, token, method };
      });
      if (!result)
        throw new HttpError(401, 'INVALID_CODE', 'That code did not match. Try the next one.');
      setSessionCookie(reply, result.token, config);
      return { body: { user: result.user, usedRecoveryCode: result.method === 'recovery' } };
    },
  );

  const sessionResponse = z.object({
    id: z.string(),
    createdAt: z.string(),
    lastSeenAt: z.string(),
    expiresAt: z.string(),
    userAgentFamily: z.string(),
    mfaVerified: z.boolean(),
    current: z.boolean(),
  });

  api.route(
    {
      method: 'GET',
      url: '/api/auth/sessions',
      summary:
        'Your own active sessions: created/last-seen time and browser family only (no IP addresses are stored).',
      tags: ['auth'],
      auth: 'user',
      responses: {
        200: { description: 'Sessions', schema: z.object({ sessions: z.array(sessionResponse) }) },
      },
    },
    async ({ user, request }) => {
      const rows = await db.pool.query(
        `SELECT id,created_at AS "createdAt",last_seen_at AS "lastSeenAt",expires_at AS "expiresAt",
                user_agent_family AS "userAgentFamily",mfa_verified AS "mfaVerified",id=$3 AS current
         FROM sessions WHERE tenant_id=$1 AND user_id=$2 AND expires_at>now()
         ORDER BY last_seen_at DESC`,
        [user.tenantId, user.id, request.sessionId],
      );
      return { body: { sessions: rows.rows } };
    },
  );

  api.route(
    {
      method: 'DELETE',
      url: '/api/auth/sessions/:id',
      summary: 'Sign out one of your own sessions (another device, or this one).',
      tags: ['auth'],
      auth: 'user',
      params: z.object({ id: z.string().uuid() }),
      responses: {
        200: { description: 'Revoked', schema: ok },
        404: { description: 'Not one of your sessions', schema: errorResponse },
      },
    },
    async ({ user, params, request, reply }) => {
      await transaction(db, async (client) => {
        const deleted = await client.query(
          'DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2 AND id=$3',
          [user.tenantId, user.id, params.id],
        );
        if (!deleted.rowCount) throw new HttpError(404, 'NOT_FOUND', 'Session not found.');
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'session.revoked',
          entityType: 'user',
          entityId: user.id,
          requestId: request.id,
          metadata: { current: params.id === request.sessionId },
        });
      });
      if (params.id === request.sessionId)
        reply.clearCookie(SESSION_COOKIE, {
          path: '/',
          secure: config.secureCookies,
          sameSite: 'strict',
          httpOnly: true,
        });
      return { body: { ok: true } };
    },
  );
}
