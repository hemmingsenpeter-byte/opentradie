-- Tasks and the Today screen (Feature 16, ADR 0032): the owner's single to-do list.
-- Reminders (0009) stay the scheduling primitive for timed outbound drafts; a task is an owner
-- to-do. Rule-generated tasks carry a rule_key and a dedupe_key unique per business, so the
-- periodic scan never duplicates one and never reopens one the owner completed or dismissed.

CREATE TABLE task_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES businesses(id),
  rules_enabled boolean NOT NULL DEFAULT true,
  follow_up_quote_days integer NOT NULL DEFAULT 3 CHECK (follow_up_quote_days BETWEEN 1 AND 60),
  reply_after_hours integer NOT NULL DEFAULT 24 CHECK (reply_after_hours BETWEEN 1 AND 336),
  invoice_after_days integer NOT NULL DEFAULT 1 CHECK (invoice_after_days BETWEEN 0 AND 60),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  kind text NOT NULL CHECK (kind IN ('book_job', 'call', 'follow_up_quote', 'reply_message',
    'invoice_job', 'chase_payment', 'custom')),
  title text NOT NULL CHECK (btrim(title) <> '' AND char_length(title) <= 200),
  notes text CHECK (char_length(notes) <= 2000),
  due_at timestamptz,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'snoozed', 'done', 'dismissed')),
  snoozed_until timestamptz,
  completed_at timestamptz,
  -- A person (completed_by set) or the scan when the rule's condition cleared (system).
  completed_by uuid,
  completed_by_type text CHECK (completed_by_type IN ('user', 'system')),
  -- Short machine reason such as 'condition_cleared'. Never message content.
  resolution_reason text CHECK (char_length(resolution_reason) <= 100),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'agent', 'voice', 'email', 'rule')),
  -- Opaque reference (proposal, voice note or request id). Never content.
  source_ref text CHECK (char_length(source_ref) <= 200),
  customer_id uuid,
  job_id uuid,
  quote_id uuid,
  invoice_id uuid,
  thread_id uuid,
  appointment_id uuid,
  rule_key text CHECK (rule_key IN ('book_job', 'follow_up_quote', 'reply_message', 'invoice_job', 'chase_payment')),
  dedupe_key text CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES communication_threads(tenant_id, id),
  FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointments(tenant_id, id),
  FOREIGN KEY (tenant_id, completed_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  CHECK ((status = 'snoozed') = (snoozed_until IS NOT NULL)),
  CHECK ((status IN ('done', 'dismissed')) = (completed_at IS NOT NULL)),
  CHECK ((completed_at IS NULL) = (completed_by_type IS NULL)),
  CHECK (completed_by IS NULL OR completed_by_type = 'user'),
  CHECK ((rule_key IS NULL) = (source <> 'rule')),
  CHECK (rule_key IS NULL OR dedupe_key IS NOT NULL)
);
CREATE INDEX tasks_tenant_open ON tasks(tenant_id, status, due_at);
CREATE INDEX tasks_tenant_rule ON tasks(tenant_id, rule_key) WHERE rule_key IS NOT NULL;

-- Owner-enabled auto-execution may now also cover task.create and task.complete (owner to-dos
-- only; nothing customer-facing). The 0007 check is replaced, not loosened for anything else.
ALTER TABLE agent_tool_policies DROP CONSTRAINT agent_tool_policies_check;
ALTER TABLE agent_tool_policies ADD CONSTRAINT agent_tool_policies_check
  CHECK (approval = 'owner' OR tool IN ('job.add_note', 'task.create', 'task.complete'));
