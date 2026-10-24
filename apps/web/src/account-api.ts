import { request } from './api';
import type { SessionUser } from './types';

/** Account security (ADR 0031). Auth routes are not Idempotency-Key replayed by design. */
export interface AccountStatus {
  mfaEnabled: boolean;
  mfaAvailable: boolean;
  mfaEnrolmentRequired: boolean;
  recoveryCodesRemaining: number;
}
export interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgentFamily: string;
  mfaVerified: boolean;
  current: boolean;
}

export type LoginResult = { user: SessionUser } | { mfaRequired: true; mfaToken: string };

export const loginStep = (email: string, password: string) =>
  request<LoginResult>('/api/auth/login', {
    method: 'POST',
    body: { email, password },
    skipUnauthorizedHook: true,
  });
export const verifyMfa = (mfaToken: string, code: string) =>
  request<{ user: SessionUser; usedRecoveryCode: boolean }>('/api/auth/mfa/verify', {
    method: 'POST',
    body: { mfaToken, code },
    skipUnauthorizedHook: true,
  });
export const requestPasswordReset = (email: string) =>
  request<{ ok: true }>('/api/auth/password-reset/request', {
    method: 'POST',
    body: { email },
    skipUnauthorizedHook: true,
  });
export const confirmPasswordReset = (token: string, newPassword: string) =>
  request<{ ok: true }>('/api/auth/password-reset/confirm', {
    method: 'POST',
    body: { token, newPassword },
    skipUnauthorizedHook: true,
  });

export const getAccount = () => request<AccountStatus>('/api/auth/account');
export const changePassword = (currentPassword: string, newPassword: string) =>
  request<{ otherSessionsRevoked: number }>('/api/auth/password', {
    method: 'POST',
    body: { currentPassword, newPassword },
  });
export const startTotp = () =>
  request<{ otpauthUri: string; secret: string }>('/api/auth/mfa/totp/setup', {
    method: 'POST',
    body: {},
  });
export const confirmTotp = (code: string) =>
  request<{ recoveryCodes: string[] }>('/api/auth/mfa/totp/confirm', {
    method: 'POST',
    body: { code },
  });
export const disableMfa = (password: string, code: string) =>
  request<{ ok: true }>('/api/auth/mfa/disable', { method: 'POST', body: { password, code } });
export const listSessions = () => request<{ sessions: SessionInfo[] }>('/api/auth/sessions');
export const revokeSession = (id: string) =>
  request<{ ok: true }>(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
