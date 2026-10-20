-- Invoices, the transactional outbox and accounting sync (ADR 0023).
--
-- Numbered 0010 (not the originally reserved 0006) because invoices reference the job time
-- entries and materials created by 0007: a migration must sort after every table it references.
--
-- OPENTRADIE owns the operational invoice (draft → approved). After a successful post the
-- accounting provider is the authoritative ledger; payment figures are read back into
-- payment_snapshots and never recalculated here.

-- ---------- business invoicing settings ----------
ALTER TABLE businesses
  ADD COLUMN payment_terms_days integer NOT NULL DEFAULT 20 CHECK (payment_terms_days BETWEEN 0 AND 365),
  ADD COLUMN next_invoice_number integer NOT NULL DEFAULT 1 CHECK (next_invoice_number >= 1),
  -- Revenue account for posted invoice lines (Xero NZ default chart: 200 Sales).
  ADD COLUMN accounting_sales_account_code text NOT NULL DEFAULT '200'
    CHECK (accounting_sales_account_code ~ '^[A-Za-z0-9._-]{1,10}$');

-- ---------- invoices ----------
CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  invoice_number text NOT NULL CHECK (invoice_number ~ '^INV-[0-9]{4,}$'),
  customer_id uuid NOT NULL,
  job_id uuid NOT NULL,
  source_quote_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'approved', 'posting', 'posted', 'sync_failed', 'void', 'paid', 'part_paid')),
  -- Bumped on every edit of the draft. The posting idempotency key is derived from (id, version).
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  issue_date date NOT NULL,
  due_date date NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  gst_registered boolean NOT NULL,
  prices_entered text NOT NULL CHECK (prices_entered IN ('exclusive', 'inclusive')),
  tax_basis_points integer NOT NULL CHECK (tax_basis_points BETWEEN 0 AND 10000),
  -- Totals and per-code GST persisted from the core engine (packages/core/src/tax.ts).
  subtotal_cents bigint NOT NULL DEFAULT 0 CHECK (subtotal_cents BETWEEN 0 AND 1000000000000),
  tax_cents bigint NOT NULL DEFAULT 0 CHECK (tax_cents BETWEEN 0 AND 1000000000000),
  total_cents bigint NOT NULL DEFAULT 0 CHECK (total_cents BETWEEN 0 AND 1000000000000),
  tax_breakdown jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(tax_breakdown) = 'array'),
  notes text CHECK (char_length(notes) <= 2000),
  created_by_type text NOT NULL DEFAULT 'user' CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid,
  approved_at timestamptz,
  voided_by uuid,
  voided_at timestamptz,
  pdf_document_id uuid,
  -- Accounting provider state. The provider assigns its own number; ours goes in its Reference.
  accounting_provider text CHECK (accounting_provider IN ('xero', 'test')),
  external_invoice_id text CHECK (char_length(external_invoice_id) <= 128),
  provider_invoice_number text CHECK (char_length(provider_invoice_number) <= 255),
  provider_status text CHECK (provider_status IN ('draft', 'submitted', 'authorised', 'paid', 'voided', 'deleted')),
  provider_total_cents bigint CHECK (provider_total_cents >= 0),
  posted_at timestamptz,
  -- Last sync failure, shown to the owner. Our own message only: never a provider body.
  sync_error_kind text CHECK (sync_error_kind IN (
    'reauthorisation_required', 'not_connected', 'organisation_required', 'validation', 'conflict',
    'permanent', 'transient_exhausted', 'unsupported')),
  sync_error_message text CHECK (char_length(sync_error_message) <= 500),
  -- Provider validation issues may contain business data: shown to the owner, never logged.
  sync_error_issues jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(sync_error_issues) = 'array'),
  amount_paid_cents bigint CHECK (amount_paid_cents >= 0),
  amount_due_cents bigint,
  last_reconciled_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, invoice_number),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  FOREIGN KEY (tenant_id, source_quote_id) REFERENCES quotes(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, voided_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, pdf_document_id) REFERENCES documents(tenant_id, id),
  CHECK (due_date >= issue_date),
  CHECK (total_cents = subtotal_cents + tax_cents),
  CHECK (gst_registered OR (tax_cents = 0 AND tax_breakdown = '[]'::jsonb)),
  -- Only drafts (and drafts that were voided) lack an approval.
  CHECK ((status IN ('draft', 'void')) = (approved_at IS NULL)),
  CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  CHECK ((status = 'void') = (voided_at IS NOT NULL)),
  CHECK (status <> 'void' OR voided_by IS NOT NULL),
  -- Posted, paid and part-paid invoices always name their external ledger record.
  CHECK (status NOT IN ('posted', 'paid', 'part_paid')
    OR (external_invoice_id IS NOT NULL AND accounting_provider IS NOT NULL AND posted_at IS NOT NULL)),
  CHECK (external_invoice_id IS NULL OR accounting_provider IS NOT NULL),
  CHECK ((status = 'sync_failed') = (sync_error_kind IS NOT NULL)),
  CHECK (status <> 'paid' OR amount_paid_cents IS NOT NULL)
);
CREATE INDEX invoices_tenant_status ON invoices(tenant_id, status, created_at DESC);
CREATE INDEX invoices_job ON invoices(tenant_id, job_id);
-- An accepted quote is billed by at most one live (not voided) invoice.
CREATE UNIQUE INDEX invoices_one_live_per_quote ON invoices(tenant_id, source_quote_id)
  WHERE source_quote_id IS NOT NULL AND status <> 'void';
CREATE UNIQUE INDEX invoices_external_id ON invoices(tenant_id, accounting_provider, external_invoice_id)
  WHERE external_invoice_id IS NOT NULL;

-- Invoice lines: the same pricing invariants as quote lines (packages/core/src/pricing.ts).
CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  invoice_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  kind text NOT NULL CHECK (kind IN ('labour', 'material', 'fee', 'discount')),
  description text NOT NULL CHECK (btrim(description) <> '' AND char_length(description) <= 500),
  unit text NOT NULL CHECK (unit IN ('each', 'hour', 'visit', 'metre', 'square_metre', 'litre', 'kilogram')),
  quantity_milli integer NOT NULL CHECK (quantity_milli BETWEEN 1 AND 10000000),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents BETWEEN 0 AND 1000000000),
  tax_code text NOT NULL CHECK (tax_code IN ('standard', 'zero_rated', 'exempt')),
  price_source text NOT NULL CHECK (price_source IN ('approved_rate', 'cost_plus_markup', 'owner_entered')),
  rate_code text,
  cost_cents bigint CHECK (cost_cents BETWEEN 0 AND 1000000000000),
  markup_bp integer CHECK (markup_bp BETWEEN 0 AND 100000),
  discount_bp integer NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
  gross_cents bigint NOT NULL,
  discount_cents bigint NOT NULL DEFAULT 0,
  line_total_cents bigint NOT NULL,
  entered_by uuid,
  -- Where the line came from. Quote lines are rewritten on quote edits, so they are referenced by
  -- id without a foreign key; the quote itself is referenced from invoices.source_quote_id.
  source_type text NOT NULL CHECK (source_type IN ('quote_line', 'time_entry', 'material', 'manual')),
  source_quote_line_id uuid,
  source_time_entry_id uuid,
  source_material_id uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, invoice_id, position),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, entered_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, source_time_entry_id) REFERENCES job_time_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, source_material_id) REFERENCES job_materials(tenant_id, id),
  CHECK ((source_type = 'quote_line') = (source_quote_line_id IS NOT NULL)),
  CHECK ((source_type = 'time_entry') = (source_time_entry_id IS NOT NULL)),
  CHECK ((source_type = 'material') = (source_material_id IS NOT NULL)),
  CHECK (price_source <> 'approved_rate' OR rate_code IS NOT NULL),
  CHECK (price_source <> 'cost_plus_markup' OR (kind = 'material' AND cost_cents IS NOT NULL AND markup_bp IS NOT NULL
    AND unit_price_cents = round(cost_cents::numeric * (10000 + markup_bp) / 10000))),
  CHECK ((price_source = 'owner_entered') = (entered_by IS NOT NULL)),
  CHECK (kind <> 'discount' OR discount_bp = 0),
  CHECK (gross_cents = round(quantity_milli::numeric * unit_price_cents / 1000)),
  CHECK (discount_cents = round(gross_cents::numeric * discount_bp / 10000)),
  CHECK (line_total_cents = CASE WHEN kind = 'discount' THEN discount_cents - gross_cents ELSE gross_cents - discount_cents END)
);

-- A time entry or material is billed by at most one live invoice. Set when a draft takes it,
-- cleared when the draft drops it or is voided.
ALTER TABLE job_time_entries
  ADD COLUMN invoice_id uuid,
  ADD CONSTRAINT job_time_entries_invoice_fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id);
ALTER TABLE job_materials
  ADD COLUMN invoice_id uuid,
  ADD CONSTRAINT job_materials_invoice_fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id);
CREATE INDEX job_time_entries_uninvoiced ON job_time_entries(tenant_id, job_id) WHERE invoice_id IS NULL;
CREATE INDEX job_materials_uninvoiced ON job_materials(tenant_id, job_id) WHERE invoice_id IS NULL;

-- ---------- documents ----------
ALTER TABLE documents
  ADD COLUMN invoice_id uuid,
  ADD CONSTRAINT documents_invoice_fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id);
-- Extend the kind list in place (other migrations extend it too).
DO $$
DECLARE
  existing_name text;
  existing_kinds text[];
BEGIN
  SELECT c.conname, array_agg(m[1] ORDER BY m[1])
    INTO existing_name, existing_kinds
  FROM pg_constraint c
    CROSS JOIN LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') AS m
  WHERE c.conrelid = 'documents'::regclass AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%(kind = ANY%'
  GROUP BY c.conname;
  IF existing_name IS NULL THEN
    RAISE EXCEPTION 'documents kind constraint not found';
  END IF;
  EXECUTE format('ALTER TABLE documents DROP CONSTRAINT %I', existing_name);
  EXECUTE format(
    'ALTER TABLE documents ADD CONSTRAINT %I CHECK (kind IN (%s))',
    existing_name,
    (SELECT string_agg(quote_literal(k), ', ' ORDER BY k)
     FROM (SELECT DISTINCT unnest(existing_kinds || ARRAY['invoice_pdf']) AS k) kinds)
  );
END;
$$;

-- ---------- job timeline ----------
DO $$
DECLARE
  existing_name text;
  existing_types text[];
BEGIN
  SELECT c.conname, array_agg(m[1] ORDER BY m[1])
    INTO existing_name, existing_types
  FROM pg_constraint c
    CROSS JOIN LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') AS m
  WHERE c.conrelid = 'job_events'::regclass AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%(type = ANY%'
  GROUP BY c.conname;
  IF existing_name IS NULL THEN
    RAISE EXCEPTION 'job_events type constraint not found';
  END IF;
  EXECUTE format('ALTER TABLE job_events DROP CONSTRAINT %I', existing_name);
  EXECUTE format(
    'ALTER TABLE job_events ADD CONSTRAINT %I CHECK (type IN (%s))',
    existing_name,
    (SELECT string_agg(quote_literal(t), ', ' ORDER BY t)
     FROM (SELECT DISTINCT unnest(existing_types || ARRAY[
       'invoice_drafted', 'invoice_approved', 'invoice_posted', 'invoice_sync_failed',
       'invoice_voided', 'invoice_paid'
     ]) AS t) types)
  );
END;
$$;

-- ---------- provider mapping ----------
-- Our entity id ↔ provider id. Unique both ways so one external record never maps to two of ours.
CREATE TABLE external_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  provider text NOT NULL CHECK (provider IN ('xero', 'gmail', 'microsoft_graph', 'whatsapp_business', 'test')),
  entity_type text NOT NULL CHECK (entity_type IN ('contact', 'invoice')),
  entity_id uuid NOT NULL,
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, entity_type, entity_id),
  UNIQUE (tenant_id, provider, entity_type, external_id)
);

-- Pending OAuth authorisations. Only the SHA-256 of `state` is stored; the PKCE verifier is
-- sealed with the credential key (AES-256-GCM). Rows are single-use and expire in minutes.
CREATE TABLE oauth_authorisations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  provider text NOT NULL CHECK (provider IN ('xero', 'test')),
  user_id uuid NOT NULL,
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  sealed_verifier bytea,
  verifier_key_id text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id),
  CHECK ((sealed_verifier IS NULL) = (verifier_key_id IS NULL))
);

-- Organisations offered by the provider when the owner connected more than one. Names only.
ALTER TABLE provider_connections
  ADD COLUMN pending_organisations jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(pending_organisations) = 'array'),
  ADD COLUMN status_reason text CHECK (status_reason IN ('reauthorisation_required', 'disconnected_by_owner')),
  ADD COLUMN connected_at timestamptz;

-- ---------- transactional outbox (ADR 0012) ----------
-- Written in the same transaction as the business change; a dispatcher copies each row into the
-- job queue (scheduled_tasks) with the outbox id as the task's idempotency key.
CREATE TABLE event_outbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  topic text NOT NULL CHECK (topic ~ '^[a-z][a-z0-9_.]{1,63}$'),
  -- Identifiers only. Never message bodies, prompts, credentials or provider responses.
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  task_id uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX event_outbox_pending ON event_outbox(created_at) WHERE dispatched_at IS NULL;

-- Every posting attempt, for the owner's sync history. Error kind and our own message only.
CREATE TABLE accounting_sync_attempts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  invoice_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('xero', 'test')),
  operation text NOT NULL CHECK (operation IN ('post_invoice', 'reconcile')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  attempt integer NOT NULL CHECK (attempt >= 1),
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'linked_existing', 'retry_scheduled', 'failed')),
  error_kind text CHECK (char_length(error_kind) <= 64),
  error_code text CHECK (char_length(error_code) <= 64),
  external_invoice_id text CHECK (char_length(external_invoice_id) <= 128),
  task_id uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id)
);
CREATE INDEX accounting_sync_attempts_invoice ON accounting_sync_attempts(tenant_id, invoice_id, started_at DESC);

-- Read-only copies of the provider's payment figures. The provider is authoritative.
CREATE TABLE payment_snapshots (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  invoice_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('xero', 'test')),
  external_invoice_id text NOT NULL,
  provider_status text NOT NULL CHECK (provider_status IN ('draft', 'submitted', 'authorised', 'paid', 'voided', 'deleted')),
  total_cents bigint NOT NULL CHECK (total_cents >= 0),
  amount_paid_cents bigint NOT NULL CHECK (amount_paid_cents >= 0),
  amount_due_cents bigint NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id)
);
CREATE INDEX payment_snapshots_invoice ON payment_snapshots(tenant_id, invoice_id, fetched_at DESC);
