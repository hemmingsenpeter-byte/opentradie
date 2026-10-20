-- Unpaid invoice follow-ups (Workflow D, ADR 0027). Off by default; every stage needs owner
-- approval unless the owner turns auto-send on for that stage.

CREATE TABLE collections_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES businesses(id),
  enabled boolean NOT NULL DEFAULT false,
  pre_due_courtesy_enabled boolean NOT NULL DEFAULT false,
  pre_due_days integer NOT NULL DEFAULT 3 CHECK (pre_due_days BETWEEN 1 AND 365),
  overdue_1_days integer NOT NULL DEFAULT 7 CHECK (overdue_1_days BETWEEN 1 AND 365),
  overdue_2_days integer NOT NULL DEFAULT 14 CHECK (overdue_2_days BETWEEN 1 AND 365),
  overdue_final_days integer NOT NULL DEFAULT 30 CHECK (overdue_final_days BETWEEN 1 AND 365),
  escalate_days integer NOT NULL DEFAULT 45 CHECK (escalate_days BETWEEN 1 AND 365),
  auto_send_pre_due boolean NOT NULL DEFAULT false,
  auto_send_overdue_1 boolean NOT NULL DEFAULT false,
  auto_send_overdue_2 boolean NOT NULL DEFAULT false,
  auto_send_overdue_final boolean NOT NULL DEFAULT false,
  -- The owner who last saved the policy. An auto-sent follow-up records them as its approver:
  -- turning auto-send on for a stage is a standing approval for that stage's template.
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users(tenant_id, id),
  CHECK (overdue_1_days < overdue_2_days AND overdue_2_days < overdue_final_days
    AND overdue_final_days < escalate_days)
);

-- Owner hold (dispute, payment arrangement): no follow-ups while set.
ALTER TABLE invoices
  ADD COLUMN collections_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN collections_hold_reason text CHECK (char_length(collections_hold_reason) <= 300),
  ADD COLUMN collections_hold_at timestamptz,
  ADD CONSTRAINT invoices_collections_hold_at CHECK (collections_hold = (collections_hold_at IS NOT NULL));

-- Extend CHECK lists by reading their current values, so nothing an earlier migration allowed is
-- dropped (packages/database/src/check-values.ts; tests/integration/migrations.test.ts).
CREATE FUNCTION pg_temp.extend_check(tbl regclass, col text, additions text[]) RETURNS void
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

-- 'escalated': an owner task instead of a customer message (final stage).
SELECT pg_temp.extend_check('reminders', 'status', ARRAY['escalated']);
-- 'system': drafts the server prepares from a deterministic template (follow-ups).
SELECT pg_temp.extend_check('communications', 'origin', ARRAY['system']);
SELECT pg_temp.extend_check('job_events', 'type', ARRAY[
  'invoice_follow_up_prepared', 'invoice_follow_up_suppressed', 'invoice_follow_up_escalated',
  'invoice_collections_hold']);

CREATE INDEX reminders_invoice_followups ON reminders(tenant_id, subject_id, created_at)
  WHERE subject_type = 'invoice';
