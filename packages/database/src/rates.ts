import { randomUUID } from 'node:crypto';
import type { Queryable } from './db.js';
import type { RateHistoryChange } from './check-values.js';

export interface RateValues {
  code: string;
  label: string;
  unit: 'each' | 'hour' | 'visit';
  unitPriceCents: number;
}

export interface RateRecord extends RateValues {
  id: string;
  active: boolean;
  approvedBy: string | null;
  approvedAt: Date;
  retiredAt: Date | null;
  updatedAt: Date;
}

export const RATE_COLUMNS = `id,code,label,unit,unit_price_cents::int AS "unitPriceCents",active,approved_by AS "approvedBy",
  approved_at AS "approvedAt",retired_at AS "retiredAt",updated_at AS "updatedAt"`;

/** Append one version of a rate to approved_rate_history (0019). */
export async function recordRateVersion(
  client: Queryable,
  input: {
    tenantId: string;
    rateId: string;
    change: RateHistoryChange;
    rate: RateValues;
    active: boolean;
    changedBy: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO approved_rate_history(id,tenant_id,rate_id,code,change,label,unit,unit_price_cents,active,changed_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      randomUUID(),
      input.tenantId,
      input.rateId,
      input.rate.code,
      input.change,
      input.rate.label,
      input.rate.unit,
      input.rate.unitPriceCents,
      input.active,
      input.changedBy,
    ],
  );
}

/** Insert a new owner-approved rate and its first version. The caller audits. */
export async function insertApprovedRate(
  client: Queryable,
  tenantId: string,
  rate: RateValues,
  approvedBy: string,
  change: RateHistoryChange = 'created',
): Promise<string> {
  const id = randomUUID();
  await client.query(
    'INSERT INTO approved_rates(id,tenant_id,code,label,unit,unit_price_cents,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [id, tenantId, rate.code, rate.label, rate.unit, rate.unitPriceCents, approvedBy],
  );
  await recordRateVersion(client, {
    tenantId,
    rateId: id,
    change,
    rate,
    active: true,
    changedBy: approvedBy,
  });
  return id;
}
