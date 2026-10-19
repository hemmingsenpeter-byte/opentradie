CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE businesses (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  currency text NOT NULL DEFAULT 'NZD',
  time_zone text NOT NULL DEFAULT 'Pacific/Auckland',
  demo_data boolean NOT NULL DEFAULT false,
  tax_basis_points integer NOT NULL DEFAULT 0 CHECK (tax_basis_points BETWEEN 0 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','viewer')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, id), UNIQUE(tenant_id, email)
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  user_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE customers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  name text NOT NULL,
  email text,
  phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id)
);
CREATE INDEX customers_search ON customers USING gin(to_tsvector('simple',name));
CREATE TABLE customer_contacts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  customer_id uuid NOT NULL,
  name text NOT NULL,
  email text,
  phone text,
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id)
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  customer_id uuid NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','quoted','scheduled','in_progress','completed')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id)
);
CREATE TABLE job_notes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  job_id uuid NOT NULL,
  text text NOT NULL,
  provenance text NOT NULL DEFAULT 'user_supplied' CHECK(provenance IN ('user_supplied','verified','inferred')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE TABLE communications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  customer_id uuid,
  job_id uuid,
  text text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  external_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id),
  FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE TABLE documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  customer_id uuid,
  job_id uuid,
  storage_key text NOT NULL,
  media_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id),
  FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE TABLE approved_rates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  code text NOT NULL,
  label text NOT NULL,
  unit_price_cents bigint NOT NULL CHECK(unit_price_cents BETWEEN 0 AND 1000000000),
  active boolean NOT NULL DEFAULT true,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,code)
);
CREATE TABLE quotes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  customer_id uuid NOT NULL,
  job_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved')),
  version integer NOT NULL DEFAULT 1,
  assumptions jsonb NOT NULL DEFAULT '[]',
  missing_information jsonb NOT NULL DEFAULT '[]',
  subtotal_cents bigint NOT NULL CHECK(subtotal_cents >= 0),
  tax_cents bigint NOT NULL CHECK(tax_cents >= 0),
  total_cents bigint NOT NULL CHECK(total_cents = subtotal_cents + tax_cents),
  tax_basis_points integer NOT NULL CHECK(tax_basis_points BETWEEN 0 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id),
  FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE TABLE quote_line_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  quote_id uuid NOT NULL,
  rate_code text NOT NULL,
  description text NOT NULL,
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 10000),
  unit_price_cents bigint NOT NULL CHECK(unit_price_cents >= 0),
  line_total_cents bigint NOT NULL CHECK(line_total_cents = quantity::bigint * unit_price_cents),
  FOREIGN KEY(tenant_id,quote_id) REFERENCES quotes(tenant_id,id),
  FOREIGN KEY(tenant_id,rate_code) REFERENCES approved_rates(tenant_id,code)
);
CREATE TABLE approval_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  quote_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','approved')),
  approved_by uuid,
  decided_at timestamptz,
  UNIQUE(tenant_id,quote_id),
  FOREIGN KEY(tenant_id,quote_id) REFERENCES quotes(tenant_id,id),
  FOREIGN KEY(tenant_id,approved_by) REFERENCES users(tenant_id,id)
);
CREATE TABLE provider_connections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  provider text NOT NULL,
  encrypted_credentials bytea NOT NULL,
  encryption_key_id text NOT NULL,
  status text NOT NULL DEFAULT 'disconnected',
  UNIQUE(tenant_id,id)
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  actor_id uuid,
  action text NOT NULL,
  entity_id uuid,
  request_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
CREATE INDEX audit_events_tenant_created ON audit_events(tenant_id,created_at DESC);
CREATE TABLE knowledge_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  customer_id uuid,
  job_id uuid,
  source_type text NOT NULL CHECK(source_type IN ('communication','document','job_note')),
  source_id uuid NOT NULL,
  content text NOT NULL,
  provenance text NOT NULL CHECK(provenance IN ('user_supplied','verified','inferred')),
  embedding vector(768),
  embedding_provider text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id),
  FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE INDEX knowledge_text_search ON knowledge_items USING gin(to_tsvector('simple',content));
CREATE TABLE scheduled_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','complete','failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,idempotency_key)
);
CREATE INDEX scheduled_tasks_claim ON scheduled_tasks(available_at) WHERE status IN ('pending','leased');
CREATE TABLE idempotency_records (
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,scope,key)
);
