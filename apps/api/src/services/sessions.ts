import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '@opentradie/database';
import type { RuntimeConfig } from '@opentradie/platform';
import type { FastifyReply } from 'fastify';

export const SESSION_COOKIE = 'opentradie_session';
export const SESSION_HOURS = 8;
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

/**
 * Browser and OS family only ("Firefox on Linux"). The raw user agent and the IP address are
 * never stored: this is enough for an owner to recognise their own devices.
 */
export function userAgentFamily(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\/|CriOS\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux|X11/.test(ua)
            ? 'Linux'
            : null;
  if (!browser && !os) return 'Unknown';
  return [browser ?? 'Browser', os ? `on ${os}` : null].filter(Boolean).join(' ');
}

export async function createSession(
  client: Queryable,
  input: { tenantId: string; userId: string; userAgent: string | undefined; mfaVerified: boolean },
): Promise<string> {
  const token = newToken();
  await client.query(
    `INSERT INTO sessions(token_hash,tenant_id,user_id,expires_at,user_agent_family,mfa_verified)
     VALUES($1,$2,$3,now() + interval '${SESSION_HOURS} hours',$4,$5)`,
    [
      tokenHash(token),
      input.tenantId,
      input.userId,
      userAgentFamily(input.userAgent),
      input.mfaVerified,
    ],
  );
  await client.query('DELETE FROM sessions WHERE expires_at < now()');
  return token;
}

export function setSessionCookie(reply: FastifyReply, token: string, config: RuntimeConfig) {
  reply.setCookie(SESSION_COOKIE, token, {
    signed: true,
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_HOURS * 3600,
  });
}
