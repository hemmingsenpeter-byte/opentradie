import { createHash, randomBytes } from 'node:crypto';

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
}

/** Opaque CSRF state for the authorize redirect. Store it server-side, bound to the owner session. */
export function createOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

/** RFC 7636 PKCE pair (S256). The verifier stays server-side; only the challenge goes in the URL. */
export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(48).toString('base64url');
  return { codeVerifier, codeChallenge: pkceChallenge(codeVerifier) };
}

export function pkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/** Refresh this long before the provider's stated expiry to absorb clock skew and slow requests. */
export const REFRESH_SKEW_MS = 120_000;

export function tokenNeedsRefresh(tokens: OAuthTokenSet, now: Date): boolean {
  return tokens.expiresAt.getTime() - REFRESH_SKEW_MS <= now.getTime();
}

/**
 * Collapses concurrent refreshes for the same key into one in-flight promise. Providers such as
 * Xero rotate refresh tokens on every use, so two parallel refreshes would revoke each other.
 * This only protects one process; multi-process deployments need a row lock in the store.
 */
export class SingleFlight<T> {
  private readonly inFlight = new Map<string, Promise<T>>();
  run(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = task().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }
}
