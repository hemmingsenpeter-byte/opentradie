import { randomUUID } from 'node:crypto';
import { hashPassword, isValidNzGstNumber, normaliseGstNumber } from '@opentradie/core';
import { transaction, type Database, type Queryable } from './db.js';
import { recordAudit } from './audit.js';
import { insertApprovedRate, type RateValues } from './rates.js';

export const MIN_OWNER_PASSWORD_LENGTH = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ProvisionOptions {
  tenantId: string;
  businessName: string;
  trade: string;
  ownerEmail: string;
  ownerDisplayName?: string;
  /** Read from a TTY prompt or OWNER_PASSWORD_FILE by the CLI; never a command-line argument. */
  ownerPassword: string;
  gstRegistered: boolean;
  gstNumber: string | null;
  pricesEntered: 'exclusive' | 'inclusive';
  rates: readonly RateValues[];
  allowAlongsideDemo?: boolean;
  dryRun?: boolean;
}

export type ProvisionResult =
  | { status: 'created'; tenantId: string; ownerId: string; rateCount: number }
  | { status: 'dry_run'; tenantId: string; rateCount: number }
  | { status: 'already_provisioned'; tenantId: string };

export class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisionError';
  }
}

/** Input checks shared by the dry run and the real run. Throws ProvisionError with a fixable message. */
export function validateProvisionOptions(options: ProvisionOptions): { gstNumber: string | null } {
  if (!UUID.test(options.tenantId)) throw new ProvisionError('--tenant-id must be a UUID.');
  const name = options.businessName.trim();
  if (!name || name.length > 200) throw new ProvisionError('--business must be 1-200 characters.');
  if (!/^[a-z][a-z0-9_ -]{1,39}$/i.test(options.trade.trim()))
    throw new ProvisionError('--trade must be a short word such as electrician or plumber.');
  if (!EMAIL.test(options.ownerEmail) || options.ownerEmail.length > 254)
    throw new ProvisionError('--owner-email is not an email address.');
  if (options.ownerPassword.length < MIN_OWNER_PASSWORD_LENGTH)
    throw new ProvisionError(
      `The owner password must be at least ${MIN_OWNER_PASSWORD_LENGTH} characters.`,
    );
  let gstNumber: string | null = null;
  if (options.gstRegistered) {
    if (!options.gstNumber)
      throw new ProvisionError('--gst-number is required when --gst-registered yes.');
    const digits = normaliseGstNumber(options.gstNumber);
    if (!digits || !isValidNzGstNumber(digits))
      throw new ProvisionError(
        'That is not a valid NZ GST number (IRD check digit failed). Check the 8 or 9 digits on the IRD registration.',
      );
    gstNumber = digits;
  } else if (options.gstNumber)
    throw new ProvisionError('--gst-number is only accepted with --gst-registered yes.');
  if (!options.rates.length) throw new ProvisionError('The rates file has no rates.');
  return { gstNumber };
}

async function refuseConflicts(client: Queryable, options: ProvisionOptions): Promise<boolean> {
  const rows = (
    await client.query<{ id: string; demo: boolean }>(
      'SELECT id, demo_data AS demo FROM businesses ORDER BY created_at',
    )
  ).rows;
  const own = rows.find((row) => row.id === options.tenantId.toLowerCase());
  if (own?.demo)
    throw new ProvisionError(
      'This tenant id holds the synthetic demo business. Provision a real business into a fresh database or a new tenant id.',
    );
  if (own) return true;
  const others = rows.filter((row) => row.id !== options.tenantId.toLowerCase());
  if (others.some((row) => !row.demo))
    throw new ProvisionError(
      'This database already holds another business. Each installation has exactly one business; use a fresh database.',
    );
  if (others.length && !options.allowAlongsideDemo)
    throw new ProvisionError(
      'This database holds the synthetic demo business for a different tenant. Use a fresh database, or pass --allow-alongside-demo for a test installation.',
    );
  return false;
}

/**
 * Create a real business, its owner and its owner-approved rate card in one transaction.
 * Re-running for a tenant that already exists changes nothing. No demo customers are created.
 */
export async function provisionTenant(
  db: Database,
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const { gstNumber } = validateProvisionOptions(options);
  const tenantId = options.tenantId.toLowerCase();
  if (options.dryRun) {
    if (await refuseConflicts(db.pool, options)) return { status: 'already_provisioned', tenantId };
    return { status: 'dry_run', tenantId, rateCount: options.rates.length };
  }
  const passwordHash = await hashPassword(options.ownerPassword);
  return transaction(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`seed:${tenantId}`]);
    if (await refuseConflicts(client, options)) return { status: 'already_provisioned', tenantId };
    const callOut = options.rates.find((rate) => rate.code === 'call_out' && rate.unit === 'visit');
    await client.query(
      `INSERT INTO businesses(id,name,trade,demo_data,gst_registered,gst_number,prices_entered,call_out_rate_code)
       VALUES($1,$2,$3,false,$4,$5,$6,$7)`,
      [
        tenantId,
        options.businessName.trim(),
        options.trade.trim().toLowerCase(),
        options.gstRegistered,
        gstNumber,
        options.pricesEntered,
        callOut ? callOut.code : null,
      ],
    );
    const ownerId = randomUUID();
    await client.query(
      "INSERT INTO users(id,tenant_id,email,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5,'owner')",
      [
        ownerId,
        tenantId,
        options.ownerEmail.trim().toLowerCase(),
        options.ownerDisplayName?.trim() || 'Owner',
        passwordHash,
      ],
    );
    const audit = (action: string, entityType: string, entityId: string, metadata = {}) =>
      recordAudit(client, {
        tenantId,
        actorType: 'system',
        actorId: null,
        action,
        entityType,
        entityId,
        requestId: 'provision:tenant',
        metadata,
      });
    await audit('tenant.provisioned', 'business', tenantId, {
      gstRegistered: options.gstRegistered,
      pricesEntered: options.pricesEntered,
      rateCount: options.rates.length,
    });
    await audit('user.created', 'user', ownerId, { role: 'owner' });
    for (const rate of options.rates) {
      const id = await insertApprovedRate(client, tenantId, rate, ownerId, 'imported');
      await audit('rate.created', 'approved_rate', id, {
        code: rate.code,
        unitPriceCents: rate.unitPriceCents,
        source: 'provision',
      });
    }
    return { status: 'created', tenantId, ownerId, rateCount: options.rates.length };
  });
}
