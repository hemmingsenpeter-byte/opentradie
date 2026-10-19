-- AI operator foundations (ADR 0021): the agent tool gateway, its call log, action proposals,
-- per-tenant approval policy, and the job time and material records that proposals execute into.
-- Agents never write domain records directly: a tool call creates an action proposal, and only an
-- owner approval (or an owner-enabled auto policy for job notes) executes it.

-- Tenant-scoped agent sessions. Only a hash of the external session key is stored.
CREATE TABLE agent_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  channel text NOT NULL CHECK (channel IN ('mcp', 'assistant', 'voice', 'email')),
  session_key_hash text NOT NULL CHECK (session_key_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel, session_key_hash)
);

-- Action proposals: validated, structured suggestions awaiting an owner decision.
CREATE TABLE action_proposals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  source text NOT NULL CHECK (source IN ('agent', 'voice', 'email', 'user')),
  -- An opaque reference to where the proposal came from (agent session id, message id). Never content.
  source_ref text CHECK (char_length(source_ref) <= 200),
  session_id uuid,
  tool text NOT NULL CHECK (tool ~ '^[a-z]+\.[a-z_]+$'),
  -- The schema-validated tool input. Never prompts or raw model output.
  payload jsonb NOT NULL,
  -- Deterministic, server-generated description for the approval inbox.
  summary text NOT NULL CHECK (char_length(summary) <= 500),
  -- Questions the owner should answer before approving (from the agent or from server checks).
  clarifications jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(clarifications) = 'array'),
  approval_policy text NOT NULL DEFAULT 'owner' CHECK (approval_policy IN ('owner', 'auto')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed', 'superseded')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  job_id uuid,
  customer_id uuid,
  created_by_type text NOT NULL DEFAULT 'agent' CHECK (created_by_type IN ('agent', 'user', 'system')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by_type text CHECK (decided_by_type IN ('user', 'system')),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text CHECK (char_length(decision_reason) <= 500),
  edited boolean NOT NULL DEFAULT false,
  executed_at timestamptz,
  result_entity_type text,
  result_entity_id uuid,
  failure_code text,
  failure_reason text CHECK (char_length(failure_reason) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, session_id) REFERENCES agent_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users(tenant_id, id),
  CHECK ((status = 'executed') = (executed_at IS NOT NULL)),
  CHECK (status <> 'failed' OR failure_code IS NOT NULL),
  CHECK (status = 'pending' OR decided_at IS NOT NULL)
);
CREATE INDEX action_proposals_inbox ON action_proposals(tenant_id, status, created_at DESC);
CREATE INDEX action_proposals_job ON action_proposals(tenant_id, job_id) WHERE job_id IS NOT NULL;

-- Every tool call through the gateway. Identifiers, hashes and outcomes only: free-text
-- arguments are replaced by their length before they reach this table.
CREATE TABLE agent_tool_calls (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  session_id uuid,
  request_id text NOT NULL CHECK (char_length(request_id) <= 128),
  tool text NOT NULL CHECK (char_length(tool) <= 64),
  risk text CHECK (risk IN ('read', 'propose')),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  input_redacted jsonb NOT NULL DEFAULT '{}',
  outcome text NOT NULL CHECK (outcome IN ('ok', 'proposed', 'auto_executed', 'duplicate', 'invalid_input', 'price_refused', 'unknown_tool', 'not_found', 'conflict', 'error')),
  error_code text CHECK (char_length(error_code) <= 64),
  proposal_id uuid,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES agent_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES action_proposals(tenant_id, id)
);
CREATE INDEX agent_tool_calls_tenant_created ON agent_tool_calls(tenant_id, created_at DESC);

-- Per-tenant approval policy. Absent row = owner approval. Only job notes may be auto-executed,
-- and only when the owner enables it; the database refuses any other combination.
CREATE TABLE agent_tool_policies (
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  tool text NOT NULL,
  approval text NOT NULL CHECK (approval IN ('owner', 'auto')),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, tool),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users(tenant_id, id),
  CHECK (approval = 'owner' OR tool = 'job.add_note')
);

-- Labour recorded against a job. The price is never stored here: it comes from the approved rate
-- (referenced by id) when the time is invoiced. Quantity is thousandths of an hour.
CREATE TABLE job_time_entries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  job_id uuid NOT NULL,
  rate_id uuid NOT NULL,
  rate_code text NOT NULL,
  quantity_milli integer NOT NULL CHECK (quantity_milli BETWEEN 1 AND 24000),
  description text CHECK (char_length(description) <= 500),
  work_date date,
  provenance text NOT NULL CHECK (provenance IN ('user_supplied', 'agent_proposed')),
  proposal_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  FOREIGN KEY (tenant_id, rate_id) REFERENCES approved_rates(tenant_id, id),
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES action_proposals(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);
CREATE INDEX job_time_entries_job ON job_time_entries(tenant_id, job_id, created_at);

-- Materials used on a job. A supplier cost may be reported by an agent but the sell price is only
-- ever computed by core pricing (cost x owner-approved markup) at owner approval.
CREATE TABLE job_materials (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  job_id uuid NOT NULL,
  description text NOT NULL CHECK (btrim(description) <> '' AND char_length(description) <= 200),
  unit text NOT NULL DEFAULT 'each' CHECK (unit IN ('each', 'hour', 'visit', 'metre', 'square_metre', 'litre', 'kilogram')),
  quantity_milli integer NOT NULL CHECK (quantity_milli BETWEEN 1 AND 10000000),
  unit_cost_cents bigint CHECK (unit_cost_cents BETWEEN 0 AND 1000000000),
  markup_bp integer CHECK (markup_bp BETWEEN 0 AND 100000),
  sell_unit_cents bigint CHECK (sell_unit_cents >= 0),
  price_source text NOT NULL CHECK (price_source IN ('cost_plus_markup', 'unpriced')),
  cost_provenance text CHECK (cost_provenance IN ('agent_reported', 'owner_entered')),
  cost_confirmed_by uuid,
  supplier text CHECK (char_length(supplier) <= 200),
  provenance text NOT NULL CHECK (provenance IN ('user_supplied', 'agent_proposed')),
  proposal_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES action_proposals(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, cost_confirmed_by) REFERENCES users(tenant_id, id),
  CHECK (
    (price_source = 'unpriced' AND unit_cost_cents IS NULL AND markup_bp IS NULL AND sell_unit_cents IS NULL)
    OR (price_source = 'cost_plus_markup' AND unit_cost_cents IS NOT NULL AND markup_bp IS NOT NULL
        AND sell_unit_cents IS NOT NULL AND cost_provenance IS NOT NULL AND cost_confirmed_by IS NOT NULL)
  )
);
CREATE INDEX job_materials_job ON job_materials(tenant_id, job_id, created_at);

-- New job timeline event types. The existing list is extended in place (not restated) so that
-- other migrations that also extend it compose in any order.
DO $$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'job_events'::regclass AND conname = 'job_events_type_check';
  IF definition IS NULL THEN
    RAISE EXCEPTION 'job_events_type_check not found';
  END IF;
  ALTER TABLE job_events DROP CONSTRAINT job_events_type_check;
  EXECUTE 'ALTER TABLE job_events ADD CONSTRAINT job_events_type_check '
    || regexp_replace(definition, '\]', ', ''time_recorded''::text, ''material_added''::text, ''communication_drafted''::text]');
END;
$$;
