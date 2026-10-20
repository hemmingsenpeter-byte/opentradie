-- Unified inbox (Phase 5, ADR 0022): conversation threads, email threading and triage on
-- communications, attachments as documents, and signed-webhook receipts for de-duplication.
--
-- Body storage policy: message bodies are business records and are stored in
-- communications.text (plain text; HTML is converted to text and never stored). They are never
-- written to logs, audit metadata, job_events metadata, queue payloads or task failure records.

-- ---------- threads ----------
CREATE TABLE communication_threads (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('manual', 'email', 'sms', 'whatsapp', 'mock')),
  subject text,
  -- Lower-case subject without reply/forward prefixes; used only as a weak threading fallback.
  subject_normalised text,
  customer_id uuid,
  job_id uuid,
  -- Provider conversation id (Gmail threadId, Microsoft Graph conversationId) when known.
  external_thread_id text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'archived')),
  -- Set when the server could not link a customer or job without guessing.
  needs_review boolean NOT NULL DEFAULT false,
  review_reason text CHECK (review_reason IS NULL OR review_reason IN (
    'customer_ambiguous', 'customer_name_only', 'job_ambiguous', 'customer_unknown', 'triage_failed')),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  CHECK (needs_review = (review_reason IS NOT NULL))
);
CREATE INDEX communication_threads_recent ON communication_threads(tenant_id, last_message_at DESC);
CREATE INDEX communication_threads_subject ON communication_threads(tenant_id, subject_normalised)
  WHERE subject_normalised IS NOT NULL;
CREATE UNIQUE INDEX communication_threads_external ON communication_threads(tenant_id, channel, external_thread_id)
  WHERE external_thread_id IS NOT NULL;

-- ---------- messages (the existing communications table) ----------
ALTER TABLE communications DROP CONSTRAINT communications_status_check;
ALTER TABLE communications ADD CONSTRAINT communications_status_check
  CHECK (status IN ('received', 'draft', 'approved', 'sending', 'sent', 'failed', 'discarded'));

ALTER TABLE communications
  ADD COLUMN thread_id uuid,
  ADD COLUMN origin text NOT NULL DEFAULT 'legacy' CHECK (origin IN (
    'legacy', 'webhook', 'manual_paste', 'agent_draft', 'owner')),
  -- RFC 5322 threading headers, stored with angle brackets as received.
  ADD COLUMN message_id_header text CHECK (message_id_header IS NULL OR length(message_id_header) <= 998),
  ADD COLUMN in_reply_to text CHECK (in_reply_to IS NULL OR length(in_reply_to) <= 998),
  ADD COLUMN references_header text[] NOT NULL DEFAULT '{}',
  -- Addresses are needed to match customers and to reply; display names only as received.
  ADD COLUMN from_address text CHECK (from_address IS NULL OR length(from_address) <= 320),
  ADD COLUMN from_name text CHECK (from_name IS NULL OR length(from_name) <= 200),
  ADD COLUMN to_addresses text[] NOT NULL DEFAULT '{}',
  ADD COLUMN cc_addresses text[] NOT NULL DEFAULT '{}',
  ADD COLUMN received_at timestamptz,
  ADD COLUMN read_at timestamptz,
  -- Server-side matching plus validated agent output: classification, summary, matched
  -- customer/job ids with basis and confidence, non-executing suggested actions, warnings.
  ADD COLUMN triage jsonb CHECK (triage IS NULL OR jsonb_typeof(triage) = 'object'),
  ADD COLUMN triage_status text NOT NULL DEFAULT 'not_applicable' CHECK (triage_status IN (
    'not_applicable', 'pending', 'completed', 'policy_denied', 'unavailable', 'invalid_output')),
  -- An agent draft answers exactly one inbound message.
  ADD COLUMN reply_to_communication_id uuid,
  ADD COLUMN approved_by uuid,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN send_attempt integer NOT NULL DEFAULT 0 CHECK (send_attempt >= 0),
  ADD COLUMN sent_at timestamptz,
  ADD COLUMN provider text CHECK (provider IS NULL OR provider IN (
    'gmail', 'microsoft_graph', 'generic_mime', 'fake')),
  ADD COLUMN provider_message_id text,
  ADD COLUMN provider_thread_id text,
  -- Short error code only (e.g. NO_MAIL_CONNECTION); never a provider response body.
  ADD COLUMN send_error_code text CHECK (send_error_code IS NULL OR send_error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT communications_thread_fk FOREIGN KEY (tenant_id, thread_id) REFERENCES communication_threads(tenant_id, id),
  ADD CONSTRAINT communications_reply_to_fk FOREIGN KEY (tenant_id, reply_to_communication_id) REFERENCES communications(tenant_id, id),
  ADD CONSTRAINT communications_approved_by_fk FOREIGN KEY (tenant_id, approved_by) REFERENCES users(tenant_id, id),
  ADD CONSTRAINT communications_approval_fields CHECK (
    status NOT IN ('approved', 'sending', 'sent') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR origin = 'legacy'),
  ADD CONSTRAINT communications_sent_fields CHECK (status <> 'sent' OR sent_at IS NOT NULL OR origin = 'legacy'),
  ADD CONSTRAINT communications_outbound_only_drafts CHECK (
    direction = 'outbound' OR status IN ('received', 'failed') OR origin = 'legacy');

CREATE INDEX communications_thread ON communications(tenant_id, thread_id, created_at) WHERE thread_id IS NOT NULL;
CREATE INDEX communications_message_id ON communications(tenant_id, message_id_header) WHERE message_id_header IS NOT NULL;
CREATE INDEX communications_from_address ON communications(tenant_id, lower(from_address)) WHERE from_address IS NOT NULL;
CREATE UNIQUE INDEX communications_one_agent_draft ON communications(tenant_id, reply_to_communication_id)
  WHERE origin = 'agent_draft';
CREATE UNIQUE INDEX communications_provider_message ON communications(tenant_id, provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL AND direction = 'outbound';

-- ---------- jobs created from email ----------
ALTER TABLE jobs DROP CONSTRAINT jobs_origin_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_origin_check CHECK (origin IN ('manual', 'assistant_proposed', 'seed', 'email'));

-- ---------- attachments ----------
ALTER TABLE documents
  ADD COLUMN communication_id uuid,
  ADD CONSTRAINT documents_communication_fk FOREIGN KEY (tenant_id, communication_id) REFERENCES communications(tenant_id, id);
CREATE INDEX documents_communication ON documents(tenant_id, communication_id) WHERE communication_id IS NOT NULL;

-- ---------- signed webhook receipts ----------
-- One row per provider event id. A repeated delivery is acknowledged and not processed again.
CREATE TABLE webhook_receipts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  provider text NOT NULL CHECK (provider IN ('gmail', 'microsoft_graph', 'generic_mime')),
  external_event_id text NOT NULL CHECK (external_event_id ~ '^[A-Za-z0-9._:@<>+=-]{1,200}$'),
  signature_verified boolean NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'rejected', 'failed')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  communication_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, external_event_id),
  FOREIGN KEY (tenant_id, communication_id) REFERENCES communications(tenant_id, id),
  -- Unsigned or badly signed requests are rejected before any row is written.
  CHECK (signature_verified)
);
