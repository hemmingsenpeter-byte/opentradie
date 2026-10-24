# Implementation roadmap (phases 0 to 7)

Delivery plan for the features in [feature-dependency-map.md](feature-dependency-map.md), on the design in [architecture-v2.md](architecture-v2.md). It complements the milestone table in [ROADMAP.md](ROADMAP.md), which tracks the v0.1 milestones. Everything below is **Planned** unless a baseline status says otherwise. The lead updates the status columns as each phase lands; the baseline is the code at commit `8c2f736` (2026-10-19).

Rules for every phase (from AGENTS.md): hand-written SQL migrations, never editing applied files; integer money; tenant-scoped queries; owner-only mutations with `Idempotency-Key`; audit event in the same transaction; mocks never presented as real integrations; run `pnpm format:check`, `lint`, `typecheck`, `test`, `build` and the PostgreSQL and Playwright checks for changed behaviour; update `docs/ARCHITECTURE.md` and `docs/DATA_MODEL.md` with each change.

## Baseline status per feature

| ID  | Feature                          | Baseline              | Phase that completes it |
| --- | -------------------------------- | --------------------- | ----------------------- |
| 1   | Voice notes to job updates       | Not started           | 4                       |
| 2   | Unified AI operator              | Partially implemented | 4                       |
| 3   | Auto invoice from job            | Not started           | 3                       |
| 4   | Xero                             | Stubbed               | 3                       |
| 5   | Mobile-first UI                  | Partially implemented | 1 onward                |
| 6   | Job cards                        | Partially implemented | 1                       |
| 7   | Quotes                           | Partially implemented | 2                       |
| 8   | AI email and message management  | Stubbed               | 5                       |
| 9   | NZ-compliant financial documents | Not started           | 3                       |
| 10  | Unpaid invoice follow-ups        | Not started           | 6                       |
| 11  | Customer and property CRM        | Partially implemented | 1                       |
| 12  | Data ownership and export        | Partially implemented | 1, 7                    |
| 13  | GST in quotes                    | Partially implemented | 2                       |
| 14  | Scheduling                       | Not started           | 6                       |
| 15  | AI invoice preparation           | Not started           | 4                       |

Nothing is "Already working" at the feature level: the vertical slice (enquiry, job, deterministic draft quote, owner approval) covers parts of features 2, 6, 7, 11 and 13 only. Deferred: native mobile app (Expo), OCR and document conversion sidecars, Activepieces, and any Chatwoot-style inbox.

## Phases

| Phase | Name                                                  | Migration       | Features             | Status                                                 |
| ----- | ----------------------------------------------------- | --------------- | -------------------- | ------------------------------------------------------ |
| 0     | Research and design documents                         | none            | all (design only)    | This documentation set; Planned work starts at Phase 1 |
| 1     | Customer, property and job foundations; export basics | 0004            | 11, 6, 12 (basic), 5 | Planned                                                |
| 2     | Quotes v2 and NZ GST                                  | 0005            | 7, 13                | Planned                                                |
| 3     | Invoices, outbox and Xero                             | 0006            | 3, 9, 4              | Planned                                                |
| 4     | Operator tool gateway and voice                       | 0007            | 2, 1, 15             | Planned                                                |
| 5     | Communications                                        | 0008            | 8                    | Planned                                                |
| 6     | Scheduling, reminders and follow-ups                  | 0009            | 14, 10               | Planned                                                |
| 7     | Hardening, backup and pilot readiness                 | none (or small) | 12, security items   | Planned                                                |

### Phase 0: research and design documents

- Scope: [open-source-assessment.md](open-source-assessment.md), [integration-decision-matrix.md](integration-decision-matrix.md), [licence-inventory.md](licence-inventory.md), [architecture-v2.md](architecture-v2.md), this roadmap, [features.json](features.json), ADRs 0011 to 0015.
- Acceptance: documents are consistent with each other and with the code; every version and licence statement carries a reviewed-on date or says "unverified"; `pnpm format:check` passes.
- Tests: none (documentation only).
- Blockers: IRD and Xero pricing pages and vendor documentation were not reachable from the review environment; those facts are marked unverified.
- Milestone: owner reads and accepts the decisions or changes them.

### Phase 1: foundations (0004)

- Scope: `properties`, `job_events` timeline, `job_evidence` (photos and documents on a job), `exports` and a queue-driven per-customer and full-tenant JSON export; property selection on jobs; phone-width review of all screens.
- Acceptance:
  - Customer has zero or more properties; a job can reference one; existing free-text `site_address` is preserved and shown.
  - Job timeline records status changes, notes and evidence uploads in order, each with an audit event.
  - Evidence files go through `FileStore`, are size and type limited, and are checksummed.
  - Export produces a JSON bundle plus files for one customer or the whole tenant, owner-only, audited, and contains no credentials or other tenants' data.
  - All screens usable at 360 px width with no horizontal scroll (Playwright mobile viewport).
- Tests: migration compatibility (`tests/integration/migrations.test.ts`), tenancy and viewer-refusal tests for each new route, export content test (no cross-tenant rows, no secrets), upload validation, Playwright mobile journey.
- Blockers: none external.
- Milestone: owner can keep full customer, site and job history in OPENTRADIE and export it.

### Phase 2: quotes v2 and GST (0005)

- Scope: money v2 (fractional quantities as thousandths, markup, tax treatment per line), quote versions and lines, states `draft`, `approved`, `sent`, `accepted`, `rejected`, `expired`, `superseded`, acceptance tokens, quote PDF (`@react-pdf/renderer`), expiry task.
- Acceptance:
  - 1.5 hours at an hourly rate prices exactly; every rounding is half-up and stated in the quote assumptions; no floating point in any money path.
  - Editing an approved quote creates a new version and marks the old one `superseded`; invalid transitions are refused with 409.
  - Acceptance token is single-use, expiring, stored hashed; accepting twice is idempotent and audited.
  - PDF is generated server-side from the approved snapshot; the same snapshot produces the same totals as the stored values.
- Tests: property-style tests for money v2 against hand-computed cases; state machine table test; token expiry and replay; PDF smoke test (non-empty, contains totals text); stale-version refusal retained; migration of existing quotes to version 1.
- Blockers: confirmation of NZ GST presentation rules; `@react-pdf/renderer` transitive licence check; font files bundled.
- Milestone: a quote can be priced, approved, rendered as a PDF and accepted.

### Phase 3: invoices, outbox and Xero (0006)

- Scope: business tax profile, invoices and lines, numbering, tax-invoice PDF, outbox and dispatcher, `AccountingAdapter` with in-memory and Xero implementations, sync attempts, payment snapshots, credit notes or replacement flow.
- Acceptance:
  - Invoice is prepared only from an accepted quote or completed job and owner-approved rate data; issued invoices are immutable.
  - Outbox row is written in the same transaction as invoice issue; killing the worker mid-dispatch causes no duplicate Xero invoice on retry.
  - Payment snapshots update paid status; Xero values win for payment fields; mismatches show `sync_conflict`.
  - Credentials are encrypted at rest with `CREDENTIAL_ENCRYPTION_KEY`; token refresh is transactional.
- Tests: invoice math and immutability; outbox atomicity and idempotent dispatch against real PostgreSQL with a mock adapter; adapter contract test run against both mock and, when credentials are present, the Xero sandbox (opt-in like `pnpm test:openclaw`, exits SKIPPED otherwise); no log line contains tokens.
- Blockers: **Xero sandbox (demo company) and app credentials**; Xero API tier and cost check; confirmation of IRD tax-invoice requirements.
- Milestone: an approved invoice reaches a Xero sandbox ledger and its payment status comes back (claimed only after the opt-in test is run).

### Phase 4: operator tool gateway and voice (0007)

- Scope: MCP tool server in the API, tools in [architecture-v2.md](architecture-v2.md), `action_proposals`, `agent_tool_calls`, owner proposal review UI, `SpeechToText` adapter (whisper.cpp), voice notes and transcripts, `invoice.prepare` proposals.
- Acceptance:
  - Only the listed tools exist; send, approve, delete, shell, filesystem and database tools do not.
  - Tools derive `tenant_id` from the installation, never from arguments; agent-supplied prices are ignored; proposals do nothing until the owner approves.
  - Prompt-injection test corpus (text in customer messages and transcripts) cannot cause an unapproved mutation.
  - A voice note becomes an immutable transcript and proposals; with the speech service down the note is kept and retried; `LOCAL_ONLY` blocks any hosted transcriber.
- Tests: tool authorisation and tenancy tests; injection tests extending `tests/security/privacy-and-injection.test.ts`; speech adapter contract test with mock and, when `WHISPER_URL` is set, a local opt-in test; no transcript text in logs.
- Blockers: **live OpenClaw Gateway** to prove MCP authentication and that `toolFilter` leaves built-in tools denied; **whisper model files** and binary on the test host; a new ADR for tool exposure.
- Milestone: owner dictates a site note and approves the proposed job update; the same path is proven against a live Gateway before it is described as integrated.

### Phase 5: communications (0008)

- Scope: threads, messages, attachments, normalised inbound pipeline, `MailProvider` (mock, then Gmail or Microsoft Graph), `MessagingProvider` via relay, `communication.draft`, owner-approved send.
- Acceptance: inbound duplicates are ignored; every message links to a customer or is unassigned; no message is sent without an owner approval record; attachments are stored via `FileStore`, size and type limited; message bodies never appear in logs.
- Tests: dedupe and replay; approval-before-send; inbound injection corpus; attachment limits; migration or coexistence with `communications`.
- Blockers: mail provider OAuth app and test mailbox; messaging provider account and relay for webhooks.
- Milestone: an emailed enquiry becomes a thread, a job and an approved reply.

### Phase 6: scheduling, reminders and follow-ups (0009)

- Scope: appointments, availability, reminders on the queue, FullCalendar in the PWA, ICS export, unpaid-invoice follow-up drafts.
- Acceptance: appointments store UTC and display in the business time zone including DST changes; double bookings are flagged; reminders fire once (idempotent) and survive restarts; follow-ups are drafts needing approval for every send.
- Tests: DST boundary tests; reminder idempotency and restart; follow-up draft-only test; Playwright calendar journey at phone and desktop widths.
- Blockers: FullCalendar v7 package licence verification (every installed `@fullcalendar/*` package must report `MIT`); real payment state requires Phase 3 sandbox evidence.
- Milestone: owner schedules a job and sees unpaid invoices chased with approved drafts.

### Phase 7: hardening and pilot readiness

- Scope: encrypted backups with restic and optional rclone (scripts under `deployments/`, unverified until run), restore drill, MFA, secret scanning and log-redaction tests, external security review, deployment verification on real hardware and a real cloud host, performance baseline, `LOCAL_ONLY` end-to-end test, licence inventory regeneration, full export and portability test across profiles.
- Acceptance: restore drill passes from a restic repository on a clean machine; MFA enforced for the owner; `pnpm audit --prod` has no high findings; no copyleft in the production tree; documentation states only what was run.
- Tests: backup and restore drill, security suite, Playwright full journey.
- Blockers: Mac mini and cloud host access; reviewer availability.
- Milestone: pilot with one real business under an agreed commercial arrangement.

## Pull request sequence

Proposed; the lead may re-sequence. Each PR is small enough to review, adds tests with the behaviour, and updates the docs it touches. Pull requests 2.1 to 2.9 cover Phases 0 to 6; Phase 7 follows as further PRs.

| PR  | Phase | Content                                                                                             | Migration        | Depends on                      |
| --- | ----- | --------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------- |
| 2.1 | 0     | These design documents and ADRs 0011 to 0015                                                        | none             | none                            |
| 2.2 | 1     | Properties, job timeline, evidence, export; mobile viewport tests                                   | 0004             | 2.1                             |
| 2.3 | 2     | Money v2 and quote v2 core rules in `packages/core`, new quote tables and API                       | 0005             | 2.2                             |
| 2.4 | 2     | Quote lifecycle: states, acceptance tokens, expiry, PDF                                             | none (uses 0005) | 2.3                             |
| 2.5 | 3     | Business tax profile, invoices, numbering, tax-invoice PDF, outbox and dispatcher with mock adapter | 0006             | 2.4                             |
| 2.6 | 3     | Xero adapter, OAuth connection, sync, payment snapshots, opt-in sandbox test                        | none (uses 0006) | 2.5, Xero sandbox               |
| 2.7 | 4     | Tool gateway, action proposals, tool-call log, proposal review UI, speech adapter and voice notes   | 0007             | 2.4 (invoice.prepare needs 2.5) |
| 2.8 | 5     | Threads, messages, mail and messaging adapters, drafts and approved send                            | 0008             | 2.7                             |
| 2.9 | 6     | Appointments, reminders, calendar UI, follow-up drafts                                              | 0009             | 2.6, 2.8                        |

Migration 0005 is a single file written in PR 2.3 and covers the whole quote schema (versions, lines, states, acceptance tokens), so PR 2.4 adds behaviour only. Applied migration files are never edited, so if 2.4 finds a schema gap it adds the next number and the later phase numbers shift.

## Cross-cutting acceptance checks

| Check                                                                                                                                      | When                   |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| Every new route has a viewer-refused test and a cross-tenant test                                                                          | every PR               |
| Every new table has `tenant_id` and composite foreign keys; `tests/integration/migrations.test.ts` passes on a database migrated from 0001 | every migration        |
| Every external call happens from a worker task or adapter, never inside a request transaction                                              | Phases 3, 4, 5, 6      |
| Statuses in README and `docs/ARCHITECTURE.md` updated; no claim of real integration without an opt-in test result                          | every PR               |
| Licence inventory updated for any new dependency                                                                                           | every PR that adds one |
