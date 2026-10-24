-- Scheduled mailbox sync (ADR 0026 amendment). The provider change cursor (Gmail historyId or a
-- Microsoft Graph delta link) is stored on the mail connection row and advanced only after every
-- message of a batch has been ingested. It is not a credential: it is useless without the sealed
-- tokens. last_synced_at is shown in Settings › Mail.
ALTER TABLE provider_connections
  ADD COLUMN sync_cursor text CHECK (sync_cursor IS NULL OR length(sync_cursor) BETWEEN 1 AND 4096),
  ADD COLUMN last_synced_at timestamptz;

-- Extend CHECK lists by reading their current values (same helper as 0014; pg_temp is per session).
CREATE OR REPLACE FUNCTION pg_temp.extend_check(tbl regclass, col text, additions text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  existing_name text;
  existing_values text[];
BEGIN
  SELECT c.conname, array_agg(m[1] ORDER BY m[1])
    INTO existing_name, existing_values
  FROM pg_constraint c
    CROSS JOIN LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') AS m
  WHERE c.conrelid = tbl AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%(' || col || ' = ANY%'
  GROUP BY c.conname;
  IF existing_name IS NULL THEN
    RAISE EXCEPTION '% % constraint not found', tbl, col;
  END IF;
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', tbl, existing_name);
  EXECUTE format(
    'ALTER TABLE %s ADD CONSTRAINT %I CHECK (%I IN (%s))',
    tbl, existing_name, col,
    (SELECT string_agg(quote_literal(t), ', ' ORDER BY t)
     FROM (SELECT DISTINCT unnest(existing_values || additions) AS t) v)
  );
END;
$$;

-- 'mailbox_sync': inbound mail fetched by the scheduled mail.sync task.
SELECT pg_temp.extend_check('communications', 'origin', ARRAY['mailbox_sync']);
