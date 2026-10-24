-- Automations (ADR 0033): owner-defined workflows stored as data, run by a deterministic engine.
-- Events reuse the transactional outbox (event_outbox, topic 'automation.event'); no new event table.

CREATE TABLE automations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  name text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 120),
  -- Validated by packages/core/src/automations.ts before every write; never code.
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  trigger_event text NOT NULL CHECK (trigger_event ~ '^[a-z]+(\.[a-z_]+)?$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  enabled boolean NOT NULL DEFAULT false,
  source text NOT NULL CHECK (source IN ('manual', 'agent', 'builtin')),
  template_key text CHECK (char_length(template_key) <= 60),
  created_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  proposal_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES action_proposals(tenant_id, id),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);
CREATE INDEX automations_enabled_event ON automations(tenant_id, trigger_event)
  WHERE enabled AND deleted_at IS NULL;
-- An approved agent proposal creates at most one automation.
CREATE UNIQUE INDEX automations_proposal ON automations(tenant_id, proposal_id) WHERE proposal_id IS NOT NULL;

CREATE TABLE automation_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  automation_id uuid NOT NULL,
  automation_version integer NOT NULL CHECK (automation_version >= 1),
  -- The event_outbox row that triggered the run.
  event_id uuid NOT NULL,
  event text NOT NULL CHECK (char_length(event) <= 60),
  entity_type text NOT NULL CHECK (char_length(entity_type) <= 30),
  entity_id text NOT NULL CHECK (char_length(entity_id) <= 160),
  job_id uuid,
  customer_id uuid,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'running', 'succeeded', 'skipped', 'failed')),
  -- One run per (automation, entity, trigger occurrence): retries and redelivery never duplicate.
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 300),
  scheduled_for timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  depth integer NOT NULL DEFAULT 0 CHECK (depth >= 0),
  -- Proposal ids created by the run, and a short reason code when skipped or failed. Never content.
  proposal_ids jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(proposal_ids) = 'array'),
  outcome_code text CHECK (char_length(outcome_code) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key),
  FOREIGN KEY (tenant_id, automation_id) REFERENCES automations(tenant_id, id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES event_outbox(tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);
CREATE INDEX automation_runs_automation ON automation_runs(tenant_id, automation_id, created_at DESC);
CREATE INDEX automation_runs_entity ON automation_runs(tenant_id, automation_id, entity_id);
CREATE INDEX event_outbox_automation_events ON event_outbox(tenant_id, created_at DESC)
  WHERE topic = 'automation.event';

-- Proposal and task sources gain 'automation'. The existing lists are extended in place (not
-- restated) so that other migrations that also extend them compose in any order.
DO $$
DECLARE
  target record;
  definition text;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('action_proposals', 'action_proposals_source_check'),
    ('tasks', 'tasks_source_check')) AS t(tbl, con)
  LOOP
    SELECT pg_get_constraintdef(oid) INTO definition
    FROM pg_constraint WHERE conrelid = target.tbl::regclass AND conname = target.con;
    IF definition IS NULL THEN
      RAISE EXCEPTION '% not found', target.con;
    END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target.tbl, target.con);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I ', target.tbl, target.con)
      || regexp_replace(definition, '\]', ', ''automation''::text]');
  END LOOP;
END;
$$;
