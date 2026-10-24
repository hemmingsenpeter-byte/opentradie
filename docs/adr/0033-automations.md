# ADR 0033: Automations

- Status: Accepted
- Date: 2026-10-24
- Feature: 17 Automations

## Context

Owners want "when X happens, do Y" workflows: ask for a review the day after a job is done,
remind me about big quotes, confirm tomorrow's appointment. An LLM could run these, but then a
model would decide at run time what to send, to whom and when, which breaks the platform's rule
that agents propose, the backend validates and owners approve (ADR 0021). Payment follow-ups
(ADR 0027) and task rules (ADR 0032) already exist as dedicated, tested features.

## Decision

1. **Design and run are separate.** An automation is a JSON definition (versioned, strict Zod
   schema in `packages/core/src/automations.ts`): `trigger` (event + optional filter), `delay`,
   up to five `actions`, `limits`. The owner writes it with a structured form, starts from a
   template, or approves one the AI operator proposed. A deterministic engine runs it. No model
   is called at run time, so the same event and records always give the same result, and a
   prompt injection in a message can never change what an automation does.
2. **Events** (`packages/core/src/automation-events.ts`): `quote.sent|accepted|declined|expired`,
   `job.status_changed` (from/to), `job.completed`, `appointment.booked|cancelled`,
   `appointment.upcoming` (days until), `invoice.posted|paid`, `invoice.overdue` (days),
   `message.received`, `task.created`, `schedule` (daily/weekly at a business-local time).
   They reuse the transactional outbox (`event_outbox`, topic `automation.event`; ADR 0012):
   `recordJobEvent` maps job timeline entries to events in the same transaction, the inbox
   emits `message.received` for non-automated mail, task creation emits `task.created`, and an
   hourly `automation.tick` emits the time-based events once per record per local day (only
   when an enabled automation listens). Payloads are identifiers, enums and small integers under
   `refs`/`data`; facts are read from the records when evaluating.
3. **Safe condition language.** Comparisons on a whitelist of facts (`job.title`, `job.status`,
   `quote.totalCents`, `invoice.daysOverdue`, `customer.hasEmail`, event fields …) with
   `eq/neq/contains/not_contains/gt/gte/lt/lte/exists`, combined with `all/any/not`, depth ≤ 4,
   ≤ 20 comparisons. Operators are type-checked per fact. No code, expressions or `eval`.
   Customer tags and job types do not exist in the data model yet, so they are not facts.
4. **Templates** use `{{placeholder}}` from a whitelist (customer first name/name, job title,
   quote/invoice number, appointment date/time, business name). Unknown placeholders are
   rejected at validation; rendered values have control characters, line breaks, braces and
   angle brackets removed and are length-capped. No money placeholders.
5. **Actions are proposals.** Allowed tools: `task.create`, `communication.draft`,
   `schedule.propose`, `job.add_note`, `reminder.create`, `job.update_status`. Ids are bound
   from the event, never written by the author. Each bound call is validated by
   `parseToolCall` (price-like keys refused anywhere in a definition) and created through
   `createProposal` with source `automation` and the run id as `source_ref`. Approval: the
   action's own `approval` if the registry allows auto for that tool, otherwise the tenant tool
   policy, bounded by `resolveApproval` — so customer messages, status changes and appointments
   always wait for the owner. Money, GST, permissions, state transitions and approval gates are
   not configurable.
6. **Engine.** `automation.event` matches enabled automations and evaluates conditions, then
   inserts an `automation_runs` row with `dedupe_key` unique per (automation, entity,
   occurrence) and enqueues `automation.run` at the delay (business time zone; e.g. "next day
   09:00"). When due, the run re-evaluates conditions on current state (skipped
   `condition_cleared`), checks `enabled`, per-entity and per-day limits, then creates the
   proposals in one transaction. Redelivery or a crash cannot duplicate a run or a proposal
   (dedupe key, `FOR UPDATE`, per-action proposal idempotency keys). Business refusals (record
   gone, appointment clash) mark the run `failed` with a code; never content.
7. **Loops.** The validator refuses an action that can emit the automation's own trigger. At
   run time the engine sets transaction-local `opentradie.automation_depth`/`automation_id`;
   events emitted inside a run carry them, an automation never reacts to its own events and
   chains stop at depth 3 (recorded as skipped `loop_guard`).
8. **AI authoring.** Tool `automation.propose {definition}` is validated and becomes a proposal
   whose summary is the deterministic plain-English text. Approving it creates the automation,
   disabled unless the owner ticks enable in the approval. Any `approval: auto` written by the
   agent is stripped. The tool's `allowedSources` is `agent`/`user`: email triage and voice
   cannot use it. The mock agent recognises the sample review sentence only (pattern matching,
   not a model).
9. **Built-ins are not converted.** Payment follow-ups and the five task rules have tested
   semantics an automation cannot express without change (stage ladders, auto-send policy with
   send-time re-checks, auto-resolve and no-resurrection). The Automations screen lists them as
   "Built in" with a link to where they are configured. Correctness over unification.

## Consequences

- Migration `0022`: `automations`, `automation_runs`; `action_proposals.source` and
  `tasks.source` gain `automation` (extended in place).
- The engine runs in the API process (it needs the API's proposal path), like `tasks.scan`.
- Run history is visible per automation; every create/update/enable/disable/delete and every
  run outcome is audited.
- Not done: custom schedules beyond daily/weekly, condition editing of nested groups in the UI
  (API/assistant only), customer tags and job types as facts.
