# Handoff: Development Prompt #2

Date: 2026-10-20. Branch: `claude/opentradie-oss-architecture-1gl7cj`. Draft PR: [#20](https://github.com/hemmingsenpeter-byte/opentradie/pull/20).
Status wording follows [ARCHITECTURE.md](ARCHITECTURE.md). Mocks and fakes are never evidence of a real integration.

## 1. Repository status

- Branch head: `see `git log`; the last feature merge is `3eb5a70``. The PR stays a draft until the owner reviews it.
- Tests (local, PostgreSQL 16): vitest 60 files / 606 tests, web 43 tests, Playwright 15/15 tests; `pnpm test:restore-drill` passes with restic 0.17.3. `pnpm test:smoke` passes against the built server.
- CI on PR #20 was fully green on `da1c0d2` (PG17 + pgvector, real Chromium, backup/restore, dependency audit, CodeQL). For later heads, see the PR checks.
- Migrations `0004`, `0005`, `0007` to `0011` were added. There is no `0006`: invoices became `0010` because they reference `0007` tables. None of these has been released, so editing them before merge is still allowed. Once merged, never edit them; add a new migration instead.

## 2. Architecture chosen

[architecture-v2.md](architecture-v2.md) has the full picture. In short:

- **Shape:** a modular monolith: one Fastify API, one PostgreSQL schema, one PWA.
- **Kept as they were:**
  - hand-written SQL migrations (no Drizzle; ADR 0004)
  - the existing Postgres job queue, now with a transactional outbox (ADR 0012)
  - integer cents everywhere; quantities in thousandths (ADR 0016)
- **OpenClaw:**
  - It remains the only agent runtime.
  - Business tools are exposed through an authenticated MCP endpoint (`/agent-tools/mcp`, ADR 0021).
  - Read tools are tenant-scoped.
  - Write tools only create action proposals. An owner approves each one, and deterministic executors carry it out. The same proposal path serves the agent, email triage (ADR 0022) and voice notes (ADR 0024).
- **External systems:**
  - They sit behind adapters in `packages/integrations`: AccountingAdapter (Xero, fake), SpeechToText (whisper.cpp, OpenAI-compatible, mock), MailProvider (Gmail, Graph, fake), MessagingProvider (interface only).
  - CalendarProvider is in `packages/platform` (contract plus fake).
- **Ledger split:** Xero is the authoritative ledger. OPENTRADIE holds the operational invoices and their sync status (ADR 0013, 0020, 0023).

## 3. Repositories selected and rejected

Evidence: [open-source-assessment.md](open-source-assessment.md), [integration-decision-matrix.md](integration-decision-matrix.md), [licence-inventory.md](licence-inventory.md).

- **Use:**
  - PostgreSQL
  - xero-node 20.0.0 (MIT)
  - @react-pdf/renderer 4.9.0 (MIT; kept external to the server bundle)
  - FullCalendar 6.1.21 standard packages (MIT)
  - postal-mime 4.0.4 (MIT-0)
  - @modelcontextprotocol/sdk 1.32.0 (MIT; tests only)
- **Separate service:**
  - whisper.cpp (local speech)
  - faster-whisper (optional hosted speech)
  - restic (encrypted backups, wired by ADR 0028) and rclone (optional offsite copy; not wired)
- **Reference only:**
  - copyleft CRM/ERP: OCA Field Service, ERPNext, Twenty, EspoCRM
  - InvoicePlane
  - Cal.diy
  - pg-boss
- **Rejected or deferred:**
  - Temporal
  - Dinero.js (the existing cents engine is tested)
  - xero-python
  - Chatwoot
  - Activepieces
  - Expo and React Native Paper (until the PWA and API are stable)
  - PaddleOCR and MarkItDown

## 4. Features

`features.json` is the machine-readable source.

| #   | Feature                          | Status                 |
| --- | -------------------------------- | ---------------------- |
| 1   | Voice notes to job updates       | Partially implemented  |
| 2   | Unified AI operator              | Implemented and tested |
| 3   | Auto invoice from job            | Implemented and tested |
| 4   | Xero                             | Partially implemented  |
| 5   | Mobile-first UI                  | Implemented and tested |
| 6   | Job cards                        | Implemented and tested |
| 7   | Quotes                           | Implemented and tested |
| 8   | AI email and message management  | Partially implemented  |
| 9   | NZ-compliant financial documents | Partially implemented  |
| 10  | Unpaid invoice follow-ups        | Implemented and tested |
| 11  | Customer and property CRM        | Implemented and tested |
| 12  | Data ownership and export        | Implemented and tested |
| 13  | GST in quotes                    | Implemented and tested |
| 14  | Scheduling                       | Implemented and tested |
| 15  | AI invoice preparation           | Implemented and tested |

## 5. Demonstrations available (mock agent, fake providers)

Run `pnpm setup:dev && pnpm dev`; the Playwright specs in `tests/e2e/` drive each of these.

- **Workflow A (enquiry → quote):**
  - email or pasted enquiry → customer, job and AI-drafted reply awaiting approval
  - quote edited, approved and sent (PDF plus single-use link)
  - customer accepts on the public page
  - job scheduled in the calendar
- **Workflow B (voice → invoice):**
  - voice note → mock transcript → proposals for time (1.5 h), material (reported cost $185 plus markup), completion, invoice and a reminder one year out
  - owner approves → invoice draft → approve → posted to the fake accounting adapter → reconciled to paid
- **Workflow C (scheduling):** free slots, clash checks with travel buffer, drag-to-reschedule, a reminder draft 24 h before.
- **Workflow D (unpaid invoice):** end-to-end with fakes (ADR 0027, `tests/e2e/payment-follow-ups.spec.ts`): posted invoice past due → follow-up check → first-reminder draft in the Inbox → approve & send (FAKE mailbox) → mock payment read back from the FAKE accounting adapter → no further stage. No live mailbox or Xero run.

## 6. Decisions the owner should confirm

1. **Tax-invoice rules:** an accountant should confirm the NZ taxable-supply-information rules in `packages/core/src/nz-tax-invoice.ts` (ADR 0016), including that GST must be shown on supplies over $1,000.
2. **Acceptance links in plaintext:** the full link sits in the outbound draft, the idempotent replay and the data export (ADR 0018). Decide whether it should only ever be shown at send time.
3. **Material markup default:** a default of `0` is treated as "not set", so a markup is required (Phase 4 wiring). Confirm.
4. **Xero API commercial tiers:** pricing has reportedly been commercial-tiered since March 2026 (unverified). Check the cost and limits before onboarding.
5. **GST rounding:** Xero rounds GST per line, while OPENTRADIE rounds per tax-code group, so totals can differ by up to a cent. The app shows a warning when they do.

## 7. Remaining blockers and unverified items

- **Live integrations never run:**
  - Xero sandbox ("Demo Company (NZ)"); steps are in `docs/integrations/accounting.md`
  - a live OpenClaw Gateway calling the MCP endpoint (header and `toolFilter` shapes are assumptions)
  - a live OpenClaw Gateway running message triage and voice extraction (`triageMessage`, `extractVoiceNote`; tested against a fake Gateway only, ADR 0022/0024 amendments)
  - Gmail and Microsoft Graph
  - Each needs credentials or hardware.
- **Mail connection:** built (ADR 0026, `tests/integration/mail-connections.test.ts`): Settings › Mail connects Gmail or Microsoft 365 through the OAuth flow shared with Xero, tokens are sealed in `provider_connections`, and approved replies send through the stored connection. Tested only against fake Google/Microsoft/Gmail/Graph HTTP; live Gmail and Graph have **not** been run. Mailbox polling is scheduled (`mail.sync` every 5 minutes, `tests/integration/mail-sync.test.ts`, fake HTTP only; an expired Gmail history id or Graph delta link resets the cursor to now with a "some mail may have been missed" warning, migration 0017); Gmail watch / Graph subscriptions are Planned.
- **Built since this handoff was written:** unpaid-invoice follow-ups (Feature 10, ADR 0027) and ICS calendar export (ADR 0019 amendment); per-customer export and erasure (ADR 0025, `tests/integration/customer-privacy.test.ts`) the 360 px screen audit (`tests/e2e/zz-mobile-360.spec.ts`) and zip exports with file contents (`?format=zip` on both exports, first-party STORE-only zip writer, sha256 verified while streaming; ADR 0025 amendment, `tests/integration/export-archive.test.ts`). The 7-year retention period for retained financial records is an assumption to confirm with an accountant.
- **Not built:**
  - automatic purge of retained financial records after the retention period
  - Expo native app
- **Backups (Phase 7):** restic encrypted backup of the logical DB backup plus local file store, retention, `pnpm backup:run` / `pnpm backup:restore`, and a restore drill (`pnpm test:restore-drill`, CI backup job) built (ADR 0028). The drill ran locally with the official restic 0.17.3 binary. Backup scheduling and an rclone offsite copy are not provided or tested.
- **Hardening (Phase 7):** route-wide authentication, role and tenant-isolation sweep over every registered route (`tests/security/route-sweep.test.ts`); worker crash recovery through lease expiry for invoice posting, email send, collections drafts and the outbox (`tests/integration/recovery.test.ts`, fakes only); no hosted fallback for agent, triage, embeddings and speech (`tests/portability/no-hosted-fallback.test.ts`). No bugs were found by these tests. Database connection loss recovery (`tests/integration/database-recovery.test.ts`, real PostgreSQL: `pg_terminate_backend` and `ALLOW_CONNECTIONS false`) found that the standalone worker exited on one transient database error; fixed by the shared `runWorkerLoop`. Not done: the accessibility pass.
- **Docker:** the image is built, run against PostgreSQL and smoke-tested (quote PDF, standalone worker) locally and in the CI `docker` job. The Compose stack was started locally with throwaway values (cloud profile healthy against a dummy S3 endpoint; full smoke only with a local-profile override). Fixed while verifying: the build needs an optional CA secret behind a TLS proxy, the container bound 127.0.0.1 (now `HOST=0.0.0.0` in the image), and `deployments/cloud/.env.example` set `FILE_STORE=local`, which the cloud profile refuses.
- **Not run or measured:**
  - launchd, the MinIO Compose profile and any real cloud deployment
  - Mac mini resource use
- **Fake accounting adapter:** its ledger is PostgreSQL-backed (migration 0018, ADR 0029), so the API and a separate worker (`RUN_WORKER=false`) share one mock ledger. Demo and test only; the in-memory ledger remains for unit tests.
- **e2e rate limit:** run back to back, the suite can exceed the 300/min per-IP rate limit, and it signs in about 10 times a minute against the login limit of 10. The voice spec and the 360 px spec wait out a 429. Consider a higher limit for the e2e profile.
- **Local environment notes:**
  - Embedded Postgres cannot run as root.
  - Tests here used system PostgreSQL 16 through `TEST_DATABASE_URL`.
  - Playwright used a symlinked Chromium headless shell because the installed build does not match Playwright 1.64.
  - CI is the authoritative run.

## 8. Next milestone

Live mail verification, then Phase 7 hardening (Feature 10 and ICS export are built):

1. Try the ICS feed in Apple, Google and Outlook calendar and record the result.
2. Connect a real Gmail and Microsoft 365 test mailbox and record the evidence, including a `mail.sync` poll against each.
3. Live verification against the Xero sandbox and a local whisper.cpp server, recording the evidence and moving their status to "Implemented and tested".
4. Manual accessibility testing with a screen reader (VoiceOver on iOS, TalkBack on Android) and Safari/Firefox. The automated pass (`tests/e2e/zz-accessibility.spec.ts`) is done; it covers landmarks, accessible names, keyboard focus, dialog focus trap and token contrast in Chromium only.
