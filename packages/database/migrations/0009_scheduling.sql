-- Scheduling: appointments, working hours, scheduling settings and generic reminders.
-- OPENTRADIE is the authority for job appointments; external calendars may later contribute
-- busy times only (docs/integrations/calendar.md, ADR 0019).

-- Per-business scheduling settings. The business time zone stays on businesses.time_zone.
CREATE TABLE scheduling_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES businesses(id),
  buffer_minutes integer NOT NULL DEFAULT 15 CHECK (buffer_minutes BETWEEN 0 AND 240),
  reminder_lead_minutes integer NOT NULL DEFAULT 1440 CHECK (reminder_lead_minutes BETWEEN 30 AND 10080),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Working hours: zero or more ranges per weekday (0 = Sunday), in minutes after local midnight.
-- A business with no rows uses the default Monday to Friday, 07:00 to 17:00.
CREATE TABLE availability_rules (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_minute smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute smallint NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (end_minute > start_minute)
);
CREATE INDEX availability_rules_tenant ON availability_rules(tenant_id, weekday, start_minute);

CREATE TABLE appointments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  job_id uuid NOT NULL,
  property_id uuid,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('proposed', 'confirmed', 'cancelled', 'completed')),
  title text NOT NULL CHECK (btrim(title) <> ''),
  notes text,
  -- Address snapshot at booking time, so later property edits do not rewrite history.
  location text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'assistant_proposed', 'customer_request')),
  -- Set only once a CalendarProvider pushes the event (none is connected yet).
  external_calendar_provider text,
  external_calendar_ref text,
  -- True when the owner booked it knowing it overlaps another appointment.
  conflict_acknowledged boolean NOT NULL DEFAULT false,
  cancel_reason text,
  created_by uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  CHECK (ends_at > starts_at),
  CHECK (ends_at - starts_at <= interval '16 hours'),
  CHECK ((external_calendar_ref IS NULL) = (external_calendar_provider IS NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE INDEX appointments_tenant_time ON appointments(tenant_id, starts_at, ends_at);
CREATE INDEX appointments_tenant_job ON appointments(tenant_id, job_id, starts_at);
CREATE UNIQUE INDEX appointments_external_ref ON appointments(tenant_id, external_calendar_provider, external_calendar_ref)
  WHERE external_calendar_ref IS NOT NULL;

-- Generic reminders: appointment reminders now; invoice follow-ups (Phase 6b) reuse the table.
-- A due reminder is "prepared" into an outbound communication draft; nothing is sent without
-- owner approval and a connected provider.
CREATE TABLE reminders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  subject_type text NOT NULL CHECK (subject_type IN ('appointment', 'invoice', 'job', 'custom')),
  subject_id uuid,
  job_id uuid,
  customer_id uuid,
  due_at timestamptz NOT NULL,
  channel text NOT NULL DEFAULT 'manual' CHECK (channel IN ('manual', 'email', 'sms', 'whatsapp')),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'prepared', 'sent', 'cancelled', 'suppressed')),
  -- One reminder per dedupe key per business, so retries and repeats never duplicate.
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  -- Identifiers and template names only. Never message bodies or credentials.
  payload jsonb NOT NULL DEFAULT '{}',
  communication_id uuid,
  prepared_at timestamptz,
  status_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, communication_id) REFERENCES communications(tenant_id, id),
  CHECK (subject_type = 'custom' OR subject_id IS NOT NULL),
  CHECK ((status = 'prepared') <= (communication_id IS NOT NULL))
);
CREATE INDEX reminders_due ON reminders(due_at) WHERE status = 'scheduled';
CREATE INDEX reminders_subject ON reminders(tenant_id, subject_type, subject_id);

-- A reminder draft for a cancelled or moved appointment is discarded, not deleted.
-- This restates the full list, so it must keep every value earlier migrations allow
-- ('sending' comes from 0008_inbox); tests/integration/migrations.test.ts checks the result.
ALTER TABLE communications DROP CONSTRAINT communications_status_check;
ALTER TABLE communications ADD CONSTRAINT communications_status_check
  CHECK (status IN ('received', 'draft', 'approved', 'sending', 'sent', 'failed', 'discarded'));

-- Appointment milestones on the job timeline. The type list is extended rather than replaced,
-- so any types added by earlier migrations (for example quote states in 0005) are kept.
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
  -- Same `type IN (...)` form as 0004, so later migrations can extend it the same way.
  EXECUTE format(
    'ALTER TABLE job_events ADD CONSTRAINT %I CHECK (type IN (%s))',
    existing_name,
    (SELECT string_agg(quote_literal(t), ', ' ORDER BY t)
     FROM (SELECT DISTINCT unnest(existing_types || ARRAY[
       'appointment_scheduled', 'appointment_rescheduled', 'appointment_confirmed', 'appointment_cancelled'
     ]) AS t) types)
  );
END;
$$;
