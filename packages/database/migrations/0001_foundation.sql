-- OPENTRADIE foundation schema. One schema for every deployment profile.
-- Every business-owned row carries tenant_id; composite foreign keys keep references inside a tenant.

CREATE TABLE businesses (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  trade text NOT NULL DEFAULT 'electrician',
  currency text NOT NULL DEFAULT 'NZD' CHECK (currency ~ '^[A-Z]{3}$'),
  time_zone text NOT NULL DEFAULT 'Pacific/Auckland',
  locale text NOT NULL DEFAULT 'en-NZ',
  tax_label text NOT NULL DEFAULT 'GST',
  tax_basis_points integer NOT NULL DEFAULT 1500 CHECK (tax_basis_points BETWEEN 0 AND 10000),
  call_out_rate_code text,
  demo_data boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'viewer')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, email)
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE customers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  name text NOT NULL,
  preferred_name text,
  email text,
  phone text,
  address text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(preferred_name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(address, ''))
  ) STORED,
  UNIQUE (tenant_id, id)
);
CREATE INDEX customers_search ON customers USING gin(search_vector);
CREATE INDEX customers_tenant_name ON customers(tenant_id, name);

CREATE TABLE customer_contacts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  customer_id uuid NOT NULL,
  name text NOT NULL,
  role text,
  email text,
  phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  customer_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'quoted', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  site_address text,
  origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'assistant_proposed', 'seed')),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(site_address, ''))
  ) STORED,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);
CREATE INDEX jobs_search ON jobs USING gin(search_vector);
CREATE INDEX jobs_tenant_customer ON jobs(tenant_id, customer_id, created_at DESC);

CREATE TABLE job_notes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  job_id uuid NOT NULL,
  author_id uuid,
  text text NOT NULL,
  provenance text NOT NULL DEFAULT 'user_supplied' CHECK (provenance IN ('user_supplied', 'verified', 'inferred')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  FOREIGN KEY (tenant_id, author_id) REFERENCES users(tenant_id, id)
);

CREATE TABLE communications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  customer_id uuid,
  job_id uuid,
  direction text NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound')),
  channel text NOT NULL DEFAULT 'manual' CHECK (channel IN ('manual', 'email', 'sms', 'whatsapp', 'mock')),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'draft', 'approved', 'sent', 'failed')),
  sender text,
  subject text,
  text text NOT NULL,
  external_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id)
);
CREATE INDEX communications_tenant_created ON communications(tenant_id, created_at DESC);
CREATE UNIQUE INDEX communications_external_reference ON communications(tenant_id, channel, external_reference) WHERE external_reference IS NOT NULL;

CREATE TABLE documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  customer_id uuid,
  job_id uuid,
  quote_id uuid,
  kind text NOT NULL CHECK (kind IN ('approved_quote', 'attachment', 'photo', 'other')),
  storage_key text NOT NULL,
  file_name text NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, storage_key),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id)
);

CREATE TABLE approved_rates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,63}$'),
  label text NOT NULL,
  unit text NOT NULL CHECK (unit IN ('each', 'hour', 'visit')),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents BETWEEN 0 AND 1000000000),
  active boolean NOT NULL DEFAULT true,
  approved_by uuid,
  approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE quotes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  customer_id uuid NOT NULL,
  job_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  currency text NOT NULL,
  assumptions jsonb NOT NULL DEFAULT '[]',
  missing_information jsonb NOT NULL DEFAULT '[]',
  subtotal_cents bigint NOT NULL CHECK (subtotal_cents >= 0),
  tax_cents bigint NOT NULL CHECK (tax_cents >= 0),
  total_cents bigint NOT NULL CHECK (total_cents = subtotal_cents + tax_cents),
  tax_basis_points integer NOT NULL CHECK (tax_basis_points BETWEEN 0 AND 10000),
  created_by uuid,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users(tenant_id, id),
  CHECK ((status = 'draft') = (decided_at IS NULL))
);
ALTER TABLE documents ADD FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes(tenant_id, id);

CREATE TABLE quote_line_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  quote_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  rate_code text NOT NULL,
  description text NOT NULL,
  unit text NOT NULL CHECK (unit IN ('each', 'hour', 'visit')),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents bigint NOT NULL CHECK (line_total_cents = quantity::bigint * unit_price_cents),
  UNIQUE (tenant_id, quote_id, position),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes(tenant_id, id),
  FOREIGN KEY (tenant_id, rate_code) REFERENCES approved_rates(tenant_id, code)
);

CREATE TABLE approval_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  subject_type text NOT NULL CHECK (subject_type IN ('quote')),
  quote_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by uuid,
  decided_by uuid,
  decided_at timestamptz,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, quote_id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes(tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE provider_connections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  provider text NOT NULL CHECK (provider IN ('xero', 'gmail', 'microsoft_graph', 'whatsapp_business', 'test')),
  status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'connected', 'error')),
  encrypted_credentials bytea,
  encryption_key_id text,
  external_account_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider),
  CHECK ((encrypted_credentials IS NULL) = (encryption_key_id IS NULL))
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  actor_type text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system', 'agent')),
  actor_id uuid,
  action text NOT NULL,
  entity_type text,
  entity_id uuid,
  request_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX audit_events_tenant_created ON audit_events(tenant_id, created_at DESC);
CREATE INDEX audit_events_entity ON audit_events(tenant_id, entity_id);

CREATE TABLE knowledge_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  customer_id uuid,
  job_id uuid,
  source_type text NOT NULL CHECK (source_type IN ('communication', 'document', 'job_note')),
  source_id uuid NOT NULL,
  source_created_at timestamptz NOT NULL,
  content text NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('user_supplied', 'verified', 'inferred')),
  extraction_status text NOT NULL DEFAULT 'raw' CHECK (extraction_status IN ('raw', 'extracted', 'reviewed')),
  confidence numeric(4, 3) CHECK (confidence BETWEEN 0 AND 1),
  embedding_status text NOT NULL DEFAULT 'pending' CHECK (embedding_status IN ('pending', 'embedded', 'not_configured', 'policy_denied', 'failed', 'unsupported')),
  created_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, source_type, source_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id)
);
CREATE INDEX knowledge_search ON knowledge_items USING gin(search_vector);

CREATE TABLE idempotency_records (
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status_code integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope, key)
);
