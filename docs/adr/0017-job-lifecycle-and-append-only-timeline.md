# ADR 0017: Job lifecycle, append-only timeline and business export

- Status: Accepted (records decisions implemented in Phase 1, migration `0004`)
- Date: 2026-10-19

## Context

Phase 1 added job cards: properties (job sites), a job timeline, notes, evidence files and a whole-business export. These decisions were made in code and tests (`packages/core/src/job-status.ts`, `packages/database/migrations/0004_crm_job_cards.sql`, `apps/api/src/routes/export.ts`) without an ADR.

## Decision

**Job status transitions are a table in pure code.** `packages/core/src/job-status.ts` holds the only list of allowed moves:

| From          | Forward moves                                     |
| ------------- | ------------------------------------------------- |
| `new`         | `quoted`, `scheduled`, `in_progress`, `cancelled` |
| `quoted`      | `scheduled`, `in_progress`, `cancelled`           |
| `scheduled`   | `in_progress`, `cancelled`                        |
| `in_progress` | `completed`, `cancelled`                          |
| `completed`   | none (reopen only)                                |
| `cancelled`   | none (reopen only)                                |

`checkJobTransition` returns `UNCHANGED`, `INVALID_TRANSITION` or `REOPEN_REQUIRED`; the API maps them to 409 and includes the allowed next statuses. Moving to `completed` sets `completed_at`; leaving it clears it.

**Reopening is explicit.** A completed job may go back to `in_progress` and a cancelled job back to `new` only when the request carries `reopen: true`. A stray status update can therefore never revive closed work. Reopens are recorded as `status_changed` events with `metadata.reopen = true`.

**The timeline is append-only and written in the same transaction as the change.** `job_events` rows are inserted by `recordJobEvent` (`packages/database/src/job-events.ts`) inside the mutation's transaction, so history cannot disagree with the record. A `BEFORE UPDATE OR DELETE` trigger raises an exception: the table cannot be edited, even by the application. Event types are a CHECK list (extended by later migrations, e.g. `0005` adds quote sent/accepted/declined/expired/revised and the `customer` actor). Metadata holds identifiers, counts and decisions only: never message bodies, prompts or credentials. Note text is joined from `job_notes` at read time rather than copied. Migration `0004` backfilled a `created` event for every existing job and a `note_added` event for every existing note.

**The business export is one JSON bundle of tenant-scoped tables** (`GET /api/export`, owner only, audited):

- Format `opentradie-business-export`, `formatVersion` 1, with `schemaVersion` (last applied migration), app version and per-table row counts.
- Read in one `REPEATABLE READ READ ONLY` transaction so every table reflects the same moment. Postgres renders the JSON so bigint and timestamps keep exact text.
- Secrets are excluded by column (`password_hash`, `encrypted_credentials`, `encryption_key_id`, `token_hash`, `search_vector`, and any column matching password/secret/token/credential/private_key/key_id) and by table (sessions, idempotency records, queue, relay inbox, installation claim, derived embeddings).
- File contents are not embedded. Each `documents` row carries `storage_key`, `size_bytes` and `sha256`; files are copied from the file store or a backup alongside the export.

## Consequences

- Adding a job status or event type needs a migration (CHECK lists) and a change to the core table; tests in `packages/core/src/job-status.test.ts` and `tests/integration/job-cards.test.ts` pin the behaviour.
- Corrections to history are new events, never edits.
- Concurrent migrations from parallel work streams that both extend `job_events` CHECK lists must be merged carefully: each drops and recreates the constraint, so the later migration must include every value.
- Per-customer export and a restic restore drill are not implemented (Planned).
