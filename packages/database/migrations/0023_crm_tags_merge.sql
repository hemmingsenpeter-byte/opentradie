-- CRM for a sole tradie (ADR 0034): customer tags, duplicate dismissals and customer merge.

-- Tags are business data: one name per tenant (stored normalised lower-case), a colour from a
-- small fixed palette (packages/database/src/check-values.ts TAG_COLOURS).
CREATE TABLE tags (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  name text NOT NULL CHECK (name = lower(btrim(name)) AND char_length(name) BETWEEN 1 AND 40),
  colour text NOT NULL DEFAULT 'slate' CHECK (colour IN ('slate', 'red', 'amber', 'green', 'teal', 'blue', 'violet', 'pink')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE customer_tags (
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  customer_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, customer_id, tag_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, tag_id) REFERENCES tags(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX customer_tags_tag ON customer_tags(tenant_id, tag_id);

-- "Not a duplicate": the pair is stored ordered (customer_a < customer_b) so it is unique.
CREATE TABLE customer_duplicate_dismissals (
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  customer_a uuid NOT NULL,
  customer_b uuid NOT NULL,
  dismissed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, customer_a, customer_b),
  CHECK (customer_a < customer_b),
  FOREIGN KEY (tenant_id, customer_a) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_b) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, dismissed_by) REFERENCES users(tenant_id, id)
);

-- A merged customer is kept (archived) and points at the survivor so old links resolve.
ALTER TABLE customers ADD COLUMN merged_into_id uuid;
ALTER TABLE customers ADD CONSTRAINT customers_merged_into_fk
  FOREIGN KEY (tenant_id, merged_into_id) REFERENCES customers(tenant_id, id);
ALTER TABLE customers ADD CONSTRAINT customers_merged_not_self CHECK (merged_into_id IS NULL OR merged_into_id <> id);
ALTER TABLE customers ADD CONSTRAINT customers_merged_archived CHECK (merged_into_id IS NULL OR archived_at IS NOT NULL);
