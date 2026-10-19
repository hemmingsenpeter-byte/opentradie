-- Quotes v2: business GST settings, fractional quote lines with price sources and tax codes,
-- persisted per-code GST totals, quote numbers and revisions, sending, and customer acceptance.
-- Existing rows are migrated in place; applied migrations are never edited.

-- ---------- business tax and quoting settings ----------
ALTER TABLE businesses
  ADD COLUMN gst_registered boolean NOT NULL DEFAULT true,
  -- Digits only (8 or 9). The API also checks the IRD check digit before storing it.
  ADD COLUMN gst_number text CHECK (gst_number IS NULL OR gst_number ~ '^[0-9]{8,9}$'),
  ADD COLUMN prices_entered text NOT NULL DEFAULT 'exclusive' CHECK (prices_entered IN ('exclusive', 'inclusive')),
  ADD COLUMN quote_validity_days integer NOT NULL DEFAULT 30 CHECK (quote_validity_days BETWEEN 1 AND 365),
  ADD COLUMN default_material_markup_bp integer NOT NULL DEFAULT 0 CHECK (default_material_markup_bp BETWEEN 0 AND 100000),
  ADD COLUMN next_quote_number integer NOT NULL DEFAULT 1 CHECK (next_quote_number >= 1);

-- ---------- quotes ----------
ALTER TABLE quotes DROP CONSTRAINT quotes_status_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_status_check
  CHECK (status IN ('draft', 'approved', 'sent', 'accepted', 'rejected', 'expired', 'superseded'));

ALTER TABLE quotes
  ADD COLUMN quote_number text,
  ADD COLUMN quote_group_id uuid,
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  ADD COLUMN previous_version_id uuid,
  ADD COLUMN valid_until date,
  ADD COLUMN sent_at timestamptz,
  ADD COLUMN accepted_at timestamptz,
  ADD COLUMN declined_at timestamptz,
  ADD COLUMN expired_at timestamptz,
  ADD COLUMN superseded_at timestamptz,
  ADD COLUMN decision_source text CHECK (decision_source IN ('owner', 'customer')),
  ADD COLUMN gst_registered boolean NOT NULL DEFAULT true,
  ADD COLUMN prices_entered text NOT NULL DEFAULT 'exclusive' CHECK (prices_entered IN ('exclusive', 'inclusive')),
  ADD COLUMN tax_breakdown jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(tax_breakdown) = 'array');

-- Existing quotes: their own group, numbered per business in creation order.
UPDATE quotes q SET
  quote_group_id = q.id,
  quote_number = 'Q-' || CASE WHEN n.seq < 10000 THEN lpad(n.seq::text, 4, '0') ELSE n.seq::text END
FROM (
  SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS seq FROM quotes
) n
WHERE n.id = q.id;
UPDATE businesses b SET next_quote_number = 1 + (SELECT count(*) FROM quotes q WHERE q.tenant_id = b.id);
UPDATE quotes SET decision_source = 'owner' WHERE status = 'rejected';
-- Every existing line was standard-rated and GST-exclusive (one tax rate on the subtotal).
UPDATE quotes SET tax_breakdown = jsonb_build_array(jsonb_build_object(
    'taxCode', 'standard', 'rateBasisPoints', tax_basis_points,
    'netCents', subtotal_cents, 'taxCents', tax_cents, 'grossCents', total_cents))
WHERE EXISTS (SELECT 1 FROM quote_line_items l WHERE l.tenant_id = quotes.tenant_id AND l.quote_id = quotes.id);

ALTER TABLE quotes
  ALTER COLUMN quote_number SET NOT NULL,
  ALTER COLUMN quote_group_id SET NOT NULL,
  ADD CONSTRAINT quotes_quote_number_format CHECK (quote_number ~ '^Q-[0-9]{4,}$'),
  ADD CONSTRAINT quotes_number_revision_unique UNIQUE (tenant_id, quote_number, revision),
  ADD CONSTRAINT quotes_previous_version_fk FOREIGN KEY (tenant_id, previous_version_id) REFERENCES quotes(tenant_id, id),
  ADD CONSTRAINT quotes_revision_link CHECK ((revision = 1) = (previous_version_id IS NULL)),
  ADD CONSTRAINT quotes_first_revision_group CHECK (revision > 1 OR quote_group_id = id),
  ADD CONSTRAINT quotes_sent_fields CHECK (
    (status IN ('draft', 'approved') AND sent_at IS NULL)
    OR status IN ('rejected', 'superseded')
    OR (status IN ('sent', 'accepted', 'expired') AND sent_at IS NOT NULL AND valid_until IS NOT NULL)),
  ADD CONSTRAINT quotes_accepted_fields CHECK (
    (status = 'accepted') = (accepted_at IS NOT NULL)
    AND (status <> 'accepted' OR decision_source = 'customer')),
  ADD CONSTRAINT quotes_declined_fields CHECK (
    declined_at IS NULL OR (status = 'rejected' AND decision_source = 'customer' AND sent_at IS NOT NULL)),
  ADD CONSTRAINT quotes_rejected_fields CHECK (status <> 'rejected' OR decision_source IS NOT NULL),
  ADD CONSTRAINT quotes_expired_fields CHECK ((status = 'expired') = (expired_at IS NOT NULL)),
  ADD CONSTRAINT quotes_superseded_fields CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)),
  ADD CONSTRAINT quotes_unregistered_no_tax CHECK (gst_registered OR (tax_cents = 0 AND tax_breakdown = '[]'::jsonb));

-- At most one live (not superseded) version of a quote.
CREATE UNIQUE INDEX quotes_one_live_version ON quotes(tenant_id, quote_group_id) WHERE status <> 'superseded';
CREATE INDEX quotes_sent_valid_until ON quotes(tenant_id, valid_until) WHERE status = 'sent';

-- ---------- quote lines ----------
ALTER TABLE quote_line_items DROP CONSTRAINT quote_line_items_check; -- line_total_cents = quantity * unit_price_cents
ALTER TABLE quote_line_items DROP CONSTRAINT quote_line_items_quantity_check;
ALTER TABLE quote_line_items DROP CONSTRAINT quote_line_items_unit_check;
ALTER TABLE quote_line_items
  ALTER COLUMN quantity DROP NOT NULL,
  ALTER COLUMN rate_code DROP NOT NULL,
  ADD COLUMN quantity_milli integer,
  ADD COLUMN kind text,
  ADD COLUMN tax_code text NOT NULL DEFAULT 'standard',
  ADD COLUMN price_source text NOT NULL DEFAULT 'approved_rate',
  ADD COLUMN cost_cents bigint,
  ADD COLUMN markup_bp integer,
  ADD COLUMN discount_bp integer NOT NULL DEFAULT 0,
  ADD COLUMN gross_cents bigint,
  ADD COLUMN discount_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN entered_by uuid;

UPDATE quote_line_items SET
  quantity_milli = quantity * 1000,
  kind = CASE WHEN unit = 'hour' THEN 'labour' ELSE 'fee' END,
  gross_cents = line_total_cents;

ALTER TABLE quote_line_items
  ALTER COLUMN quantity_milli SET NOT NULL,
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN gross_cents SET NOT NULL,
  ADD CONSTRAINT quote_line_items_entered_by_fk FOREIGN KEY (tenant_id, entered_by) REFERENCES users(tenant_id, id),
  ADD CONSTRAINT quote_line_items_unit_check CHECK (unit IN ('each', 'hour', 'visit', 'metre', 'square_metre', 'litre', 'kilogram')),
  ADD CONSTRAINT quote_line_items_kind_check CHECK (kind IN ('labour', 'material', 'fee', 'discount')),
  ADD CONSTRAINT quote_line_items_tax_code_check CHECK (tax_code IN ('standard', 'zero_rated', 'exempt')),
  ADD CONSTRAINT quote_line_items_price_source_check CHECK (price_source IN ('approved_rate', 'cost_plus_markup', 'owner_entered')),
  ADD CONSTRAINT quote_line_items_quantity_milli_check CHECK (quantity_milli BETWEEN 1 AND 10000000),
  -- The legacy whole-number column is kept for readers that predate fractional quantities.
  ADD CONSTRAINT quote_line_items_legacy_quantity CHECK (quantity IS NULL OR quantity_milli = quantity * 1000),
  ADD CONSTRAINT quote_line_items_rate_source CHECK (price_source <> 'approved_rate' OR rate_code IS NOT NULL),
  ADD CONSTRAINT quote_line_items_cost_source CHECK (
    price_source <> 'cost_plus_markup' OR (kind = 'material' AND cost_cents IS NOT NULL AND markup_bp IS NOT NULL
      AND unit_price_cents = round(cost_cents::numeric * (10000 + markup_bp) / 10000))),
  -- An owner-entered price always names the owner who typed it; nothing else may carry one.
  ADD CONSTRAINT quote_line_items_owner_source CHECK ((price_source = 'owner_entered') = (entered_by IS NOT NULL)),
  ADD CONSTRAINT quote_line_items_cost_range CHECK (cost_cents IS NULL OR cost_cents BETWEEN 0 AND 1000000000000),
  ADD CONSTRAINT quote_line_items_markup_range CHECK (markup_bp IS NULL OR markup_bp BETWEEN 0 AND 100000),
  ADD CONSTRAINT quote_line_items_discount_range CHECK (discount_bp BETWEEN 0 AND 10000 AND (kind <> 'discount' OR discount_bp = 0)),
  -- Amount invariants, rounded half away from zero exactly as packages/core/src/pricing.ts does.
  ADD CONSTRAINT quote_line_items_gross CHECK (gross_cents = round(quantity_milli::numeric * unit_price_cents / 1000)),
  ADD CONSTRAINT quote_line_items_discount CHECK (discount_cents = round(gross_cents::numeric * discount_bp / 10000)),
  ADD CONSTRAINT quote_line_items_amount CHECK (
    line_total_cents = CASE WHEN kind = 'discount' THEN discount_cents - gross_cents ELSE gross_cents - discount_cents END);

-- ---------- documents ----------
ALTER TABLE documents DROP CONSTRAINT documents_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_kind_check
  CHECK (kind IN ('approved_quote', 'quote_pdf', 'attachment', 'photo', 'other'));

-- ---------- customer acceptance ----------
-- Single-use acceptance links. Only the SHA-256 of the random token is stored.
CREATE TABLE quote_acceptance_tokens (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  quote_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  document_id uuid,
  communication_id uuid,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes(tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id),
  FOREIGN KEY (tenant_id, communication_id) REFERENCES communications(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);
CREATE UNIQUE INDEX quote_acceptance_tokens_live ON quote_acceptance_tokens(tenant_id, quote_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

-- The approval record of a customer's (or owner-recorded) decision. Append-only.
CREATE TABLE quote_decisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  quote_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accepted', 'declined')),
  source text NOT NULL CHECK (source IN ('customer', 'owner')),
  token_id uuid,
  -- The name the customer typed as their signature, and an optional comment. Nothing else
  -- identifying (no IP address or device fingerprint) is stored.
  signer_name text NOT NULL CHECK (btrim(signer_name) <> '' AND length(signer_name) <= 200),
  comment text CHECK (comment IS NULL OR length(comment) <= 2000),
  quote_number text NOT NULL,
  revision integer NOT NULL,
  total_cents bigint NOT NULL CHECK (total_cents >= 0),
  document_sha256 text CHECK (document_sha256 IS NULL OR document_sha256 ~ '^[a-f0-9]{64}$'),
  decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, quote_id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes(tenant_id, id),
  FOREIGN KEY (tenant_id, token_id) REFERENCES quote_acceptance_tokens(tenant_id, id),
  CHECK (source <> 'customer' OR token_id IS NOT NULL)
);

CREATE FUNCTION quote_decisions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'quote_decisions is append-only';
END;
$$;
CREATE TRIGGER quote_decisions_append_only BEFORE UPDATE OR DELETE ON quote_decisions
  FOR EACH ROW EXECUTE FUNCTION quote_decisions_append_only();

-- ---------- timeline and audit actors ----------
ALTER TABLE job_events DROP CONSTRAINT job_events_type_check;
ALTER TABLE job_events ADD CONSTRAINT job_events_type_check CHECK (type IN (
  'created', 'status_changed', 'details_updated', 'property_changed', 'note_added',
  'evidence_added', 'quote_drafted', 'quote_updated', 'quote_approved', 'quote_rejected',
  'quote_sent', 'quote_accepted', 'quote_declined', 'quote_expired', 'quote_revised'));
ALTER TABLE job_events DROP CONSTRAINT job_events_actor_type_check;
ALTER TABLE job_events ADD CONSTRAINT job_events_actor_type_check
  CHECK (actor_type IN ('user', 'system', 'agent', 'customer'));
ALTER TABLE audit_events DROP CONSTRAINT audit_events_actor_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_type_check
  CHECK (actor_type IN ('user', 'system', 'agent', 'customer'));
