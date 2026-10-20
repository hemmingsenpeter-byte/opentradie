# ADR 0027: Unpaid invoice follow-ups (Workflow D)

Status: Accepted (2026-10-20). Implemented and tested: backend, PWA (Settings › Payment follow-ups,
invoice follow-up timeline and hold) and a Playwright journey (`tests/e2e/payment-follow-ups.spec.ts`)
against the FAKE mailbox and FAKE accounting adapter only.

## Decision

- A pure core function (`packages/core/src/collections.ts`) decides an invoice's follow-up stage
  from its status, due date, the latest provider payment snapshot, the owner hold, customer
  erasure and the stages already prepared: `pre_due_courtesy` (off by default), `overdue_1` (7
  days), `overdue_2` (14), `overdue_final` (30), `escalate_owner` (45; an owner task, never a
  customer message). Days are calendar days in the business time zone, so DST never shifts a stage.
- Policy lives in `collections_settings` (migration 0014): disabled by default and every stage
  requires owner approval by default. Turning auto-send on for a stage is a standing approval
  recorded against the owner who saved the policy (`updated_by`).
- An hourly `collections.scan` task (a chain of hour-bucketed tasks, like `accounting.reconcile`)
  records one `reminders` row per stage with dedupe key `invoice:<id>:<stage>`, so repeated or
  concurrent scans and restarts never duplicate. Each customer stage becomes an inbox thread with
  an outbound DRAFT (`origin='system'`) rendered from a deterministic template: every figure comes
  from integer cents on the invoice or the latest snapshot; no model output.
- Auto-send stages with a connected mailbox are approved and queued on the existing
  `inbox.send` path (at most once). Both paths re-check the invoice inside `inbox.send` before any
  provider call: paid, voided, nothing due, held or erased means the draft is discarded and the
  reminder suppressed. The scan also withdraws unsent drafts whose invoice no longer needs chasing.
  The re-check uses the last reconciled status; it does not call the ledger itself.
- `COLLECTIONS_TEST_NOW` fixes the scan clock for tests and demos only; config refuses it with
  `NODE_ENV=production` or the cloud profile.

## Consequences

Follow-ups appear in the existing inbox for approval. Job timeline events, audit events and
`GET /api/invoices/:id/follow-ups` give the history. The agent's `payment.status` read tool reports
the latest stage and hold state, read-only.
