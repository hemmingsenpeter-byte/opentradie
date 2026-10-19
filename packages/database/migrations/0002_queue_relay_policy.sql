-- Durable work: the Postgres-backed job queue (ScheduledTask), relay inbox and model-use approvals.

CREATE TABLE scheduled_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 50),
  run_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, kind, idempotency_key),
  CHECK ((status = 'leased') = (lease_expires_at IS NOT NULL))
);
CREATE INDEX scheduled_tasks_ready ON scheduled_tasks(run_at) WHERE status = 'pending';
CREATE INDEX scheduled_tasks_leases ON scheduled_tasks(lease_expires_at) WHERE status = 'leased';

CREATE TABLE scheduled_task_failures (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  attempt integer NOT NULL,
  error text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, task_id) REFERENCES scheduled_tasks(tenant_id, id)
);

CREATE TABLE relay_inbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  source text NOT NULL,
  external_event_id text NOT NULL,
  event_type text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processed', 'failed')),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (tenant_id, source, external_event_id)
);

CREATE TABLE model_use_approvals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  purpose text NOT NULL CHECK (purpose IN ('enquiry_interpretation', 'knowledge_embedding')),
  provider text NOT NULL,
  data_categories text[] NOT NULL,
  approved_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users(tenant_id, id)
);

-- Exactly one authoritative installation owns a database. A second runtime with a different
-- installation id or a different gateway refuses to start against it.
CREATE TABLE installation_claim (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  installation_id text NOT NULL,
  deployment_profile text NOT NULL CHECK (deployment_profile IN ('local', 'cloud', 'hybrid')),
  gateway_fingerprint text,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
