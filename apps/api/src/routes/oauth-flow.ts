import { createHash, randomUUID } from 'node:crypto';
import type { Queryable, Transaction } from '@opentradie/database';
import {
  openCredentials,
  sealCredentials,
  type ConnectionProvider,
  type CredentialKeyring,
} from '@opentradie/integrations';

/**
 * OAuth authorization-code plumbing shared by every provider connection (accounting and mail,
 * ADR 0026). The state is stored only as a SHA-256 hash, the PKCE verifier sealed with the
 * credential key under its own AAD purpose, and each row is single-use and expires in 10 minutes.
 */

/** OAuth state rows live this long; the owner has to finish consent within it. */
export const AUTHORISATION_TTL_MS = 10 * 60_000;

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** The PKCE verifier is sealed under its own AAD purpose, so it can never open as a token row. */
const verifierBinding = (tenantId: string, provider: string) => ({
  tenantId,
  provider: `${provider}:oauth_verifier`,
});

/** Stores a pending authorisation (inside the caller's transaction) and prunes stale rows. */
export async function storeAuthorisation(
  client: Transaction,
  input: {
    tenantId: string;
    userId: string;
    provider: ConnectionProvider;
    keyring: CredentialKeyring;
    state: string;
    codeVerifier: string | null;
  },
): Promise<void> {
  const sealed = input.codeVerifier
    ? sealCredentials(
        input.codeVerifier,
        input.keyring,
        verifierBinding(input.tenantId, input.provider),
      )
    : null;
  await client.query(
    `INSERT INTO oauth_authorisations(id,tenant_id,provider,user_id,state_hash,sealed_verifier,verifier_key_id,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      randomUUID(),
      input.tenantId,
      input.provider,
      input.userId,
      sha256(input.state),
      sealed?.ciphertext ?? null,
      sealed?.keyId ?? null,
      new Date(Date.now() + AUTHORISATION_TTL_MS),
    ],
  );
  await client.query(
    "DELETE FROM oauth_authorisations WHERE tenant_id=$1 AND expires_at < now() - interval '1 day'",
    [input.tenantId],
  );
}

/**
 * Atomically marks the authorisation for `state` used and returns who started it plus the opened
 * PKCE verifier. Null for an unknown, expired, replayed or other-provider state.
 */
export async function claimAuthorisation(
  pool: Queryable,
  input: {
    tenantId: string;
    provider: ConnectionProvider;
    keyring: CredentialKeyring;
    state: string;
  },
): Promise<{ userId: string; codeVerifier: string | null } | null> {
  const claimed = (
    await pool.query<{ userId: string; sealed: Buffer | null; keyId: string | null }>(
      `UPDATE oauth_authorisations SET used_at=now()
       WHERE tenant_id=$1 AND provider=$2 AND state_hash=$3 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id AS "userId",sealed_verifier AS sealed,verifier_key_id AS "keyId"`,
      [input.tenantId, input.provider, sha256(input.state)],
    )
  ).rows[0];
  if (!claimed) return null;
  return {
    userId: claimed.userId,
    get codeVerifier() {
      return claimed.sealed && claimed.keyId
        ? openCredentials(
            { keyId: claimed.keyId, ciphertext: claimed.sealed },
            input.keyring,
            verifierBinding(input.tenantId, input.provider),
          )
        : null;
    },
  };
}
