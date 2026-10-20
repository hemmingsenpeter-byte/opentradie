-- Customer erasure (ADR 0025). A customer's personal data can be erased on request while
-- financial records needed for tax record-keeping are retained in pseudonymised form.
--
-- job_events and quote_decisions stay append-only. The only UPDATE either table accepts is the
-- erasure redaction, and only inside a transaction that set `opentradie.erasure = 'on'`
-- (SET LOCAL, so it never outlives the erasure transaction). Every other column must be
-- unchanged, and the redacted columns may only take the fixed redaction values below.
-- DELETE is still always refused.

ALTER TABLE customers ADD COLUMN erased_at timestamptz;

CREATE OR REPLACE FUNCTION job_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND current_setting('opentradie.erasure', true) = 'on'
    AND NEW.summary = 'Details erased at the customer''s request'
    AND NEW.metadata = '{"erased": true}'::jsonb
    AND (to_jsonb(NEW) - 'summary' - 'metadata') = (to_jsonb(OLD) - 'summary' - 'metadata')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'job_events is append-only';
END;
$$;

CREATE OR REPLACE FUNCTION quote_decisions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND current_setting('opentradie.erasure', true) = 'on'
    AND NEW.signer_name = '[erased]'
    AND NEW.comment IS NULL
    AND (to_jsonb(NEW) - 'signer_name' - 'comment') = (to_jsonb(OLD) - 'signer_name' - 'comment')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'quote_decisions is append-only';
END;
$$;
