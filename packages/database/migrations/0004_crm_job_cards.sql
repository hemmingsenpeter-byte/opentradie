-- CRM and job cards: properties (job sites), an append-only job timeline, and job -> property links.
-- jobs.site_address is kept for compatibility; new jobs record a property where one is known.

CREATE TABLE properties (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  customer_id uuid NOT NULL,
  label text,
  address_line1 text NOT NULL CHECK (btrim(address_line1) <> ''),
  address_line2 text,
  suburb text,
  city text,
  postcode text,
  access_notes text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(label, '') || ' ' || coalesce(address_line1, '') || ' ' || coalesce(address_line2, '') || ' ' ||
      coalesce(suburb, '') || ' ' || coalesce(city, '') || ' ' || coalesce(postcode, ''))
  ) STORED,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);
CREATE INDEX properties_search ON properties USING gin(search_vector);
CREATE INDEX properties_tenant_customer ON properties(tenant_id, customer_id, created_at);

ALTER TABLE jobs ADD COLUMN property_id uuid;
ALTER TABLE jobs ADD FOREIGN KEY (tenant_id, property_id) REFERENCES properties(tenant_id, id);
CREATE INDEX jobs_tenant_property ON jobs(tenant_id, property_id) WHERE property_id IS NOT NULL;

-- Existing free-text site addresses become one property per (customer, address).
INSERT INTO properties(id, tenant_id, customer_id, address_line1, created_at, updated_at)
SELECT gen_random_uuid(), tenant_id, customer_id, address, min(created_at), min(created_at)
FROM (
  SELECT tenant_id, customer_id, btrim(site_address) AS address, created_at
  FROM jobs WHERE site_address IS NOT NULL AND btrim(site_address) <> ''
) addresses
GROUP BY tenant_id, customer_id, address;

UPDATE jobs j SET property_id = p.id
FROM properties p
WHERE p.tenant_id = j.tenant_id AND p.customer_id = j.customer_id
  AND p.address_line1 = btrim(j.site_address) AND j.property_id IS NULL;

-- Append-only job timeline. Rows are written in the same transaction as the job mutation.
CREATE TABLE job_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  job_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN (
    'created', 'status_changed', 'details_updated', 'property_changed', 'note_added',
    'evidence_added', 'quote_drafted', 'quote_updated', 'quote_approved', 'quote_rejected')),
  actor_type text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system', 'agent')),
  actor_id uuid,
  from_status text CHECK (from_status IN ('new', 'quoted', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  to_status text CHECK (to_status IN ('new', 'quoted', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  summary text NOT NULL,
  -- Identifiers, counts and decisions only. Never message bodies, prompts or credentials.
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES users(tenant_id, id),
  CHECK (type <> 'status_changed' OR (from_status IS NOT NULL AND to_status IS NOT NULL))
);
CREATE INDEX job_events_job ON job_events(tenant_id, job_id, created_at);

CREATE FUNCTION job_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'job_events is append-only';
END;
$$;
CREATE TRIGGER job_events_append_only BEFORE UPDATE OR DELETE ON job_events
  FOR EACH ROW EXECUTE FUNCTION job_events_append_only();

-- Existing jobs and notes get a backfilled timeline so every job has a history.
INSERT INTO job_events(id, tenant_id, job_id, type, actor_type, to_status, summary, metadata, created_at)
SELECT gen_random_uuid(), tenant_id, id, 'created', 'system', status,
  'Job recorded before the timeline existed', '{"backfilled": true}', created_at
FROM jobs;

INSERT INTO job_events(id, tenant_id, job_id, type, actor_type, actor_id, summary, metadata, created_at)
SELECT gen_random_uuid(), tenant_id, job_id, 'note_added',
  CASE WHEN author_id IS NULL THEN 'system' ELSE 'user' END, author_id,
  'Note added', jsonb_build_object('noteId', id, 'backfilled', true), created_at
FROM job_notes;
