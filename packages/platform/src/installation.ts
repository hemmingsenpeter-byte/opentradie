import { createHash } from 'node:crypto';
import type { Database } from '@opentradie/database';
import type { DeploymentProfile } from './config.js';

export class InstallationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallationConflictError';
  }
}

export function gatewayFingerprint(url: string | null): string | null {
  if (!url) return null;
  const parsed = new URL(url);
  return createHash('sha256').update(`${parsed.protocol}//${parsed.host}`).digest('hex').slice(0, 32);
}

/**
 * Claim the database for one installation. Multiple processes of the same installation may share
 * it (API + worker); a different installation, a profile change or a different OpenClaw gateway is
 * refused, so a hybrid setup can never run two authoritative databases or competing gateways.
 * Moving an installation is a documented migration procedure, not a restart with new settings.
 */
export async function claimInstallation(
  db: Database,
  claim: { installationId: string; profile: DeploymentProfile; gatewayUrl: string | null },
): Promise<void> {
  const fingerprint = gatewayFingerprint(claim.gatewayUrl);
  await db.pool.query(
    'INSERT INTO installation_claim(installation_id,deployment_profile,gateway_fingerprint) VALUES($1,$2,$3) ON CONFLICT (singleton) DO NOTHING',
    [claim.installationId, claim.profile, fingerprint],
  );
  const current = await db.pool.query<{ installation_id: string; deployment_profile: string; gateway_fingerprint: string | null }>(
    'SELECT installation_id,deployment_profile,gateway_fingerprint FROM installation_claim',
  );
  const row = current.rows[0]!;
  if (row.installation_id !== claim.installationId) {
    throw new InstallationConflictError(`This database is already the authoritative store for installation "${row.installation_id}". Refusing to start a second authoritative runtime.`);
  }
  if (row.deployment_profile !== claim.profile) {
    throw new InstallationConflictError(`This installation is recorded as "${row.deployment_profile}". Changing deployment profile is a migration, not a setting.`);
  }
  if (row.gateway_fingerprint !== null && fingerprint !== null && row.gateway_fingerprint !== fingerprint) {
    throw new InstallationConflictError('A different OpenClaw gateway is already bound to this installation. Refusing to start a competing gateway.');
  }
  await db.pool.query('UPDATE installation_claim SET last_seen_at=now(), gateway_fingerprint=coalesce(gateway_fingerprint,$1)', [fingerprint]);
}
