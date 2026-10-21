-- DEMO AND TEST ONLY (ADR 0029). The fake accounting provider's ledger, kept in PostgreSQL so the
-- API and a separate worker process share one "external system" when ACCOUNTING_PROVIDER=fake.
-- Not business data: excluded from the data export. Never read by business logic. Empty unless the
-- fake provider is configured (which configuration refuses in the cloud profile and production).

CREATE SEQUENCE fake_accounting_seq;

CREATE TABLE fake_accounting_contacts (
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE fake_accounting_invoices (
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  id text NOT NULL,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX fake_accounting_invoices_id ON fake_accounting_invoices (id);

CREATE TABLE fake_accounting_payments (
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  id text NOT NULL,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE fake_accounting_idempotency (
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  key text NOT NULL,
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
