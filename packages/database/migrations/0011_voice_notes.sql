-- Voice notes (ADR 0024): owner-recorded audio, its transcript with provenance, an optional
-- owner correction, the server's customer/job resolution, and clarification questions. The
-- audio is a document (kind 'other', no job_id so it is not listed as job evidence). Transcripts
-- are customer data: stored here, shown to the business, never logged or written to audit rows.
-- Proposals created from a voice note reference it as action_proposals.source_ref.

CREATE TABLE voice_notes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  uploaded_by uuid NOT NULL,
  document_id uuid NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('audio/m4a', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/webm', 'audio/ogg')),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'transcribing', 'transcribed', 'interpreting', 'proposed', 'needs_clarification', 'failed')),
  -- Transcript as returned by the speech provider, and its provenance.
  transcript text CHECK (char_length(transcript) <= 20000),
  transcript_provider text CHECK (char_length(transcript_provider) <= 200),
  transcript_model text CHECK (char_length(transcript_model) <= 200),
  transcript_location text CHECK (transcript_location IN ('local', 'hosted')),
  transcript_language text CHECK (char_length(transcript_language) <= 16),
  duration_ms integer CHECK (duration_ms >= 0),
  avg_confidence numeric(4, 3) CHECK (avg_confidence BETWEEN 0 AND 1),
  -- [{startMs,endMs,text,confidence,lowConfidence}]
  segments jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(segments) = 'array'),
  transcribed_at timestamptz,
  -- Owner correction. Interpretation always uses the corrected text when present.
  corrected_transcript text CHECK (char_length(corrected_transcript) <= 20000),
  corrected_by uuid,
  corrected_at timestamptz,
  -- Bumped by every correction or clarification; proposal idempotency keys include it.
  interpretation_version integer NOT NULL DEFAULT 1 CHECK (interpretation_version >= 1),
  -- Server resolution of the customer and job (never chosen by the model).
  resolved_customer_id uuid,
  resolved_job_id uuid,
  resolution_status text NOT NULL DEFAULT 'unresolved' CHECK (resolution_status IN ('unresolved', 'job_hint', 'matched', 'owner_selected', 'ambiguous', 'not_found')),
  -- Owner-chosen hourly rate when several approved labour rates could apply.
  labour_rate_code text CHECK (labour_rate_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  -- {questions:[], candidates:[], rateOptions:[], notices:[]}: server-generated text and ids only.
  clarification jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(clarification) = 'object'),
  -- Runtime that interpreted the note (e.g. 'mock' is synthetic) and whether it was synthetic.
  interpreted_by text CHECK (char_length(interpreted_by) <= 64),
  interpreted_at timestamptz,
  error_code text CHECK (char_length(error_code) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, corrected_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id),
  FOREIGN KEY (tenant_id, resolved_customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, resolved_job_id) REFERENCES jobs(tenant_id, id),
  CHECK (status <> 'failed' OR error_code IS NOT NULL),
  CHECK ((corrected_transcript IS NULL) = (corrected_at IS NULL))
);
CREATE INDEX voice_notes_recent ON voice_notes(tenant_id, created_at DESC);
CREATE INDEX voice_notes_job ON voice_notes(tenant_id, resolved_job_id) WHERE resolved_job_id IS NOT NULL;
CREATE INDEX action_proposals_source_ref ON action_proposals(tenant_id, source, source_ref) WHERE source_ref IS NOT NULL;
