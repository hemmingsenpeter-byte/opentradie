# ADR 0032: Tasks and the Today screen

- Status: Accepted
- Date: 2026-10-24
- Feature: 16 Tasks and Today

## Context

A tradie needs one list of what to do next: jobs to book, people to call, quotes to chase,
messages to answer, jobs to invoice. Before this, owner to-dos were scattered: `reminders`
(0009) became manual drafts in the inbox, collections escalation (0014) set a reminder to
`escalated`, and nothing told the owner that an accepted quote still needed a booking.

## Decision

1. **A `tasks` table (migration 0021) is the owner's to-do list.** Kinds `book_job`, `call`,
   `follow_up_quote`, `reply_message`, `invoice_job`, `chase_payment`, `custom`; priority
   `low|normal|high`; status `open|snoozed|done|dismissed`; source
   `manual|agent|voice|email|rule`; tenant-scoped composite foreign keys to customer, job, quote,
   invoice, thread and appointment. `completed_by_type` is `user` or `system`; a system
   resolution records `resolution_reason = 'condition_cleared'`. Rule tasks carry `rule_key` and a
   `dedupe_key` unique per business. Thresholds live in `task_settings` (defaults: quote
   follow-up 3 days, reply after 24 h, invoice 1 day after completion; rules on).
2. **Reminders stay the scheduling primitive for timed outbound drafts** (appointment and
   invoice reminders, `reminder.create`). They are not migrated. An owner to-do is a task:
   voice-note "remind me to …" / "remind me to call …" phrases now produce `task.create`
   proposals (kind `call` when the phrase starts with call/ring/phone), dated server-side with the
   existing `voiceReminderDueAt` (9:00 am business time, from the recording time; never a
   model-computed date). They no longer produce `reminder.create`, so one spoken phrase never
   becomes both a reminder and a task.
3. **Rules are pure** (`packages/core/src/task-rules.ts`, `now` injected, business time zone):
   accepted quote without a future non-cancelled appointment → `book_job`; quote `sent` ≥ N days
   → `follow_up_quote`; latest inbound message in an open thread unanswered (no outbound
   approved/sending/sent after it) ≥ 24 h → `reply_message` (keyed by message, so a later
   unanswered message is a new task); completed job without a non-void invoice ≥ 1 day →
   `invoice_job`; posted/part-paid invoice not on hold that is escalated by collections or
   overdue beyond the final follow-up stage → `chase_payment` (a call). Email triage's
   `needs_reply` adds no proposal: the reply rule covers it, avoiding double tasks.
4. **`tasks.scan` is a durable hourly task** (same pattern as `collections.scan`; started at API
   boot, idempotent per hour bucket, chained by its handler) and also runs when an appointment
   is booked or cancelled and on the owner's "Check now" (`POST /api/tasks/scan`, inline). It
   upserts by dedupe key, never reopens a task the owner completed or dismissed, reopens one the
   scan itself resolved when the condition returns (e.g. booking cancelled), resolves rule tasks
   whose condition cleared, and wakes lapsed snoozes. One advisory lock per tenant serialises
   scans.
5. **Agent tools**: `task.list` (read), `task.create`, `task.complete`, `task.snooze` (proposals).
   `task.create` and `task.complete` may be set to `auto` by the owner (the 0007 database check is
   replaced to allow exactly `job.add_note`, `task.create`, `task.complete`); default is owner
   approval. Agent task kinds exclude `reply_message` and `chase_payment`, which only rules make.
   No task tool sends anything.
6. **Today is the Home screen**: Overdue / Today / Upcoming / Snoozed (collapsed) by
   business-local day, one-tap Call (`tel:`), Schedule (opens the job with slot suggestions),
   Draft reply (opens the thread), Open job/quote/invoice, Done, Snooze (tomorrow / next week /
   pick a date, 9:00 am business time), Dismiss; quick add; today's appointments; a due-count
   badge on the Home tab. Viewers read only.

## Consequences

- Customer erasure redacts task titles and notes for the customer's tasks.
- Switching rules off resolves open rule tasks at the next scan (system, `condition_cleared`).
- Raising a threshold can resolve a rule task whose condition no longer holds; that is
  intended (the rule decides).
- Status: Implemented and tested with the mock agent and real PostgreSQL
  (`tests/integration/tasks.test.ts`, `packages/core/src/task-rules.test.ts`,
  `apps/web/src/Today.test.tsx`, `tests/e2e/zz-today.spec.ts`). No real OpenClaw run.
