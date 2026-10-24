-- Rate card management: every change to an owner-approved rate is kept as a version.
-- approved_rates keeps one current row per code (quote lines reference it by code);
-- approved_rate_history records each version with when it took effect and who approved it.
-- Quote and invoice lines already store their own unit price, so past documents keep the price
-- they were issued with when a rate changes.

ALTER TABLE approved_rates
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE approved_rate_history (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  rate_id uuid NOT NULL,
  code text NOT NULL,
  change text NOT NULL CHECK (change IN ('created', 'updated', 'retired', 'reactivated', 'imported')),
  label text NOT NULL,
  unit text NOT NULL,
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents BETWEEN 0 AND 1000000000),
  active boolean NOT NULL,
  changed_by uuid,
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, rate_id) REFERENCES approved_rates(tenant_id, id),
  FOREIGN KEY (tenant_id, changed_by) REFERENCES users(tenant_id, id)
);
CREATE INDEX approved_rate_history_rate ON approved_rate_history(tenant_id, rate_id, effective_from);

-- Existing rates: their first version is the one approved when they were created.
INSERT INTO approved_rate_history(id,tenant_id,rate_id,code,change,label,unit,unit_price_cents,active,changed_by,effective_from)
SELECT gen_random_uuid(), tenant_id, id, code, 'created', label, unit, unit_price_cents, active, approved_by, approved_at
FROM approved_rates;
UPDATE approved_rates SET retired_at = approved_at WHERE active = false;
