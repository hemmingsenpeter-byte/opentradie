import { randomUUID } from 'node:crypto';
import { hashPassword, passwordProblem } from '@opentradie/core';
import { recordAudit } from './audit.js';
import { transaction, type Database, type Queryable } from './db.js';

export class AccountResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountResetError';
  }
}

/** Removes every TOTP secret and recovery code for a user (MFA off). */
export async function clearUserMfa(client: Queryable, tenantId: string, userId: string) {
  await client.query('DELETE FROM user_recovery_codes WHERE tenant_id=$1 AND user_id=$2', [
    tenantId,
    userId,
  ]);
  await client.query('DELETE FROM user_mfa WHERE tenant_id=$1 AND user_id=$2', [tenantId, userId]);
}

/**
 * Operator password reset (pnpm owner:reset-password): no email needed. Sets the new password,
 * revokes every session and outstanding token, and disables MFA only when asked. Audited as
 * a system action; the password itself is never recorded.
 */
export async function resetUserPassword(
  db: Database,
  options: { email: string; newPassword: string; disableMfa?: boolean; tenantId?: string },
): Promise<{ tenantId: string; userId: string; sessionsRevoked: number; mfaDisabled: boolean }> {
  const problem = passwordProblem(options.newPassword);
  if (problem) throw new AccountResetError(problem);
  const users = await db.pool.query<{ id: string; tenantId: string }>(
    `SELECT id,tenant_id AS "tenantId" FROM users WHERE email=$1 AND active=true ${
      options.tenantId ? 'AND tenant_id=$2' : ''
    }`,
    options.tenantId
      ? [options.email.trim().toLowerCase(), options.tenantId]
      : [options.email.trim().toLowerCase()],
  );
  if (users.rows.length === 0) throw new AccountResetError('No active user has that email.');
  if (users.rows.length > 1)
    throw new AccountResetError('That email exists in several businesses: pass --tenant-id.');
  const user = users.rows[0]!;
  const passwordHash = await hashPassword(options.newPassword);
  return transaction(db, async (client) => {
    await client.query(
      'UPDATE users SET password_hash=$3,password_changed_at=now() WHERE tenant_id=$1 AND id=$2',
      [user.tenantId, user.id, passwordHash],
    );
    const revoked = await client.query('DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2', [
      user.tenantId,
      user.id,
    ]);
    await client.query('DELETE FROM auth_tokens WHERE tenant_id=$1 AND user_id=$2', [
      user.tenantId,
      user.id,
    ]);
    const mfaDisabled = Boolean(options.disableMfa);
    if (mfaDisabled) await clearUserMfa(client, user.tenantId, user.id);
    await recordAudit(client, {
      tenantId: user.tenantId,
      actorType: 'system',
      actorId: null,
      action: 'auth.password_reset_by_operator',
      entityType: 'user',
      entityId: user.id,
      requestId: `cli-${randomUUID()}`,
      metadata: { sessionsRevoked: revoked.rowCount ?? 0, mfaDisabled },
    });
    return {
      tenantId: user.tenantId,
      userId: user.id,
      sessionsRevoked: revoked.rowCount ?? 0,
      mfaDisabled,
    };
  });
}
