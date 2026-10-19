# Architecture v2: target design

Target architecture for Phases 1 to 7, adapted to the repository as it exists on 2026-10-19. It extends [ARCHITECTURE.md](ARCHITECTURE.md); where the two differ, ARCHITECTURE.md describes what is built and this page describes what is planned.

Every item is labelled with the status vocabulary: **Implemented and tested**, **Implemented, not integration-tested**, **Scaffolded**, **Planned**. Nothing on this page marked Planned exists in code. No real Xero, email, WhatsApp, speech or live OpenClaw integration exists or is claimed.

## Principles carried over (unchanged)

- Modular monolith, one codebase, one PostgreSQL schema, one authoritative database and one OpenClaw Gateway per installation ([ADR 0001](adr/0001-modular-monolith-pnpm-workspaces.md), [ADR 0003](adr/0003-one-product-three-deployment-profiles.md)).
- Agents propose; the backend validates; owners approve. The agent has no send, approve, shell, filesystem or database tool.
- All prices come from owner-approved rate records; integer cents; tenant-scoped queries; every mutation audited in the same transaction.
- All model output and incoming content is untrusted. `LOCAL_ONLY` fails closed for hosted inference and embeddings, with no automatic fallback.
- Deployment-profile differences live in adapters, configuration and `deployments/`, never in business logic.

## Layers

```text
 PWA (apps/web)                       owner on phone / desktop; viewer role read-only
        |  HTTPS, session cookie, Idempotency-Key + Origin on mutations
 Business API (apps/api)              Fastify + Zod; modules below; the only writer of business data
   |        |              |              |
   |        |              |              +-- Tool gateway (MCP over HTTP, API-hosted)  <--- OpenClaw Gateway (sole agent runtime)
   |        |              |                    authenticated, tenant-scoped, propose-only tools
   |        |              +-- Communications gateway (inbound webhooks / relay -> normalised messages)
   |        +-- Queue + outbox (PostgresJobQueue, apps/worker or in-process)
   +-- Persistence: PostgreSQL (authoritative), FileStore (local FS | S3)
        |
 Integration adapters (provider interfaces; one implementation per vendor, mock for CI)
   AccountingAdapter  SpeechToText  MailProvider  CalendarProvider  MessagingProvider  FileStore  AgentRuntime  LLM/Embeddings
```

| Layer                  | Today                                                                                                                                                                                                 | Planned change                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| PWA                    | `apps/web`: React 19, Tailwind 4, service worker, manifest. Screens: Login, Home, Customers, Jobs, Quotes, Assistant, Settings. **Implemented and tested** (3 component tests, 2 Playwright journeys) | Phase 1+ screens: property, job timeline, quote editor, invoice, inbox, calendar. A phone-width audit has not been done (**unverified**) |
| Communications gateway | `relay_inbox` plus `POST /relay/v1/events` (HMAC); `communications` table with manual and mock sources. **Implemented and tested** harness, no real channel                                           | Phase 5: normalised inbound pipeline, email first                                                                                        |
| Business API           | `apps/api`: auth, tenancy, audit, rate limiting, customers, jobs, notes, enquiries, quotes, approvals. **Implemented and tested**                                                                     | Domain modules below                                                                                                                     |
| Queue                  | `PostgresJobQueue` ([ADR 0008](adr/0008-postgres-backed-job-queue.md)). **Implemented and tested**                                                                                                    | Outbox and dispatcher on the same queue ([ADR 0012](adr/0012-durable-workflow-outbox-on-existing-queue.md)). **Planned**                 |
| OpenClaw operator      | `packages/agent`: `AgentRuntime`, `MockAgentRuntime`, `RealOpenClawAgentRuntime`. Mock **Implemented and tested**; real adapter **Implemented, not integration-tested**                               | Tool gateway. **Planned** (Phase 4)                                                                                                      |
| Persistence            | Migrations 0001 to 0003, `FileStore`. **Implemented and tested**                                                                                                                                      | Migrations 0004 to 0009. **Planned**                                                                                                     |
| Adapters               | `AgentRuntime`, `FileStore`, embeddings provider. **Implemented**                                                                                                                                     | Others **Planned**                                                                                                                       |

## Domain modules

The ten modules are logical boundaries inside the one deployable. Code today lives in route and service files rather than per-module folders; the target is to introduce `apps/api/src/modules/<name>/` (routes, service, schemas) as each module grows, moving existing code only when it is touched, with pure rules in `packages/core`.

| #   | Module                       | Responsibility                                                           | Code today                                                                                                                        | Planned location                                                                                                          | Phase       |
| --- | ---------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | Identity and tenancy         | Business, users, sessions, roles, installation claim, idempotency        | `apps/api/src/routes/system.ts`, `packages/database` (`businesses`, `users`, `sessions`), `packages/platform/src/installation.ts` | unchanged; add business tax profile (GST number, address) in 0006                                                         | existing, 3 |
| 2   | Customers and properties     | Customers, contacts, sites                                               | `routes/records.ts`, `services/records.ts`; `customers.address` and `jobs.site_address` are free text                             | `modules/customers`; `properties` table (0004)                                                                            | 1           |
| 3   | Jobs                         | Job card, status, notes, timeline, evidence (photos, documents)          | `routes/records.ts` (`jobs`, `job_notes`, `documents`)                                                                            | `modules/jobs`; `job_events`, `job_evidence` (0004)                                                                       | 1           |
| 4   | Pricing and quotes           | Rates, deterministic pricing, versions, states, acceptance               | `packages/core/src/{money,quote,proposal,customer-match}.ts`, `routes/quotes.ts`, `routes/assistant.ts`                           | `modules/quotes`; `packages/core` gains fractional quantity, markup, per-line tax treatment; PDF via `packages/documents` | 2           |
| 5   | Invoicing and payments       | Invoices from jobs/quotes, numbering, payment snapshots, follow-ups      | none                                                                                                                              | `modules/invoices` (0006)                                                                                                 | 3           |
| 6   | Accounting integration       | Xero connection, push, pull, conflict handling                           | `provider_connections` table (allows `xero`; no code uses it)                                                                     | `packages/integrations/accounting`, outbox handlers in `packages/platform`                                                | 3           |
| 7   | Communications               | Threads, messages, attachments, drafts, delivery status                  | `communications` table, `relay_inbox`, `packages/platform/src/relay.ts`, `GET /api/communications`                                | `modules/communications` (0008), `packages/integrations/mail`, `messaging`                                                | 5           |
| 8   | Scheduling and reminders     | Appointments, availability, reminders, follow-up timers                  | `jobs.status = 'scheduled'` only; `scheduled_tasks` is the queue substrate                                                        | `modules/scheduling` (0009)                                                                                               | 6           |
| 9   | Operator (agent)             | Tool gateway, action proposals, voice notes, transcripts, interpretation | `packages/agent`, `routes/assistant.ts` (enquiry interpretation), `core/src/{proposal,model-policy}.ts`                           | `modules/operator`, `packages/integrations/speech` (0007)                                                                 | 4           |
| 10  | Documents, export and backup | PDFs, stored files, per-customer and full export, encrypted backup       | `documents` table, `packages/platform/{file-store,backup}.ts`; approved quote stored as JSON                                      | `packages/documents`, `modules/exports` (0004), restic scripts in `deployments/`                                          | 1, 2, 7     |

Cross-cutting (exist): audit (`packages/database/src/audit.ts`), privacy-mode policy (`packages/core/src/model-policy.ts`), idempotency, rate limiting, request IDs.

## Queue and outbox

**Today:** `scheduled_tasks` with idempotent enqueue per `(tenant_id, kind, idempotency_key)`, optional enlistment in the caller's transaction, leasing with `FOR UPDATE SKIP LOCKED`, lease reclaim, exponential backoff, `PermanentTaskError`, failure rows. Kinds: `relay.process`, `knowledge.embed`. **Implemented and tested.**

**Planned (0006): transactional outbox.** An `outbox_events` row is inserted in the same transaction as the business change (for example "invoice approved"). A dispatcher task turns each row into an adapter call. Rules:

1. Outbox rows are append-only facts with `tenant_id`, `aggregate_type`, `aggregate_id`, `event_type`, `payload` (no message bodies), `dedupe_key` (unique with `tenant_id`), `status`, `available_at`, `attempts`.
2. A dispatch task is enqueued with the outbox id as idempotency key; handlers are idempotent and record each attempt in `sync_attempts`.
3. Permanent failures (validation rejected by the provider) stop retries and surface in the UI as "needs attention"; transient failures retry with backoff.
4. Nothing external is called inside a request transaction.

## Tool gateway (OpenClaw to OPENTRADIE)

**Implemented (Phase 4 foundations), not verified with a live OpenClaw Gateway: see [ADR 0021](adr/0021-agent-business-tool-gateway.md) for the shipped tool names** (`job.add_note`, `job.update_status`, `job.record_time`, `job.add_material`, `rates.list` and so on; `property.find`, `appointment.propose` and `followup.propose` below are not built). [ADR 0002](adr/0002-openclaw-gateway-client-only-agent-runtime.md) keeps OpenClaw reachable only via the Gateway protocol, and said the agent gets no business tools in v0.1 with the extension point left open. This design uses OpenClaw's documented MCP client: the API hosts an MCP server (Streamable HTTP) and the Gateway lists it under `mcp.servers` with a `toolFilter.include` allow-list of exactly the tool names below. A new ADR is required when Phase 4 starts; ADR 0002 itself needs no change except its "no tools in v0.1" sentence being superseded.

**Unverified assumptions (must be proven against a live Gateway before Phase 4 is accepted):** how an authentication header is configured for a remote MCP server; whether `toolFilter` composes with the global tool policy so that built-in shell, filesystem and browser tools stay denied for the business agent; whether the Gateway can pass per-session context. The mock gateway proves none of this.

Controls (all server-side, in the API):

- Authentication: a per-installation bearer secret held in the Gateway's secret mechanism and in `provider_connections` (encrypted). Not a user session.
- Tenancy: `tenant_id` comes from the installation claim, never from tool arguments (ADR 0006). Every query is tenant-scoped.
- Read tools return minimal fields (names, codes, ids, no contact details beyond what is needed, no prices from rate records unless required for the proposal check).
- Write-like tools create **action proposals** (`action_proposals`, 0007), never domain mutations. The owner approves a proposal through a session-authenticated API route; only then does the backend execute the change in one audited transaction.
- Draft tools create records in `draft` state that cannot leave the system: sending is a separate owner-approved API action, not a tool.
- Each call is logged in `agent_tool_calls` with tool name, outcome, ids and a hash of the arguments. Arguments that contain message bodies, prompts or provider responses are not logged.
- Per-tool rate and size limits; unknown tools are rejected; all arguments are validated with Zod; all returned text is treated as untrusted when it later reaches a model.

| Tool                  | Class   | Effect                                                                                           | Approval policy                                                                                                  |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `customer.find`       | Read    | Search customers by name, phone, email; returns ids and display names                            | None; tenant-scoped, field-minimised, audited as read                                                            |
| `customer.get`        | Read    | One customer with contacts and sites                                                             | None                                                                                                             |
| `property.find`       | Read    | Sites for a customer or address text                                                             | None                                                                                                             |
| `job.find`            | Read    | Search jobs by customer, status, text                                                            | None                                                                                                             |
| `job.get`             | Read    | Job card with notes and timeline summary                                                         | None                                                                                                             |
| `rate.list`           | Read    | Approved rate codes, labels, units (as today's agent context)                                    | None                                                                                                             |
| `job.create`          | Propose | Proposes a job for a customer/property                                                           | Owner approves the proposal; backend creates the job (origin `assistant_proposed`)                               |
| `job.note.add`        | Propose | Proposes a note (for example from a voice transcript), provenance `inferred`                     | Owner approves; stored with `inferred` provenance until confirmed                                                |
| `job.status.propose`  | Propose | Proposes a status change                                                                         | Owner approves                                                                                                   |
| `quote.prepare`       | Propose | Supplies rate codes and quantities; backend prices from approved rates and returns a draft quote | Draft only; owner approval (existing approval flow) before it can be sent. Agent-supplied prices are ignored     |
| `invoice.prepare`     | Propose | Proposes an invoice from a completed job or accepted quote                                       | Backend builds lines from the accepted quote/job records; owner approves before issue or Xero push               |
| `communication.draft` | Draft   | Creates a draft reply attached to a thread                                                       | Never sent by the agent; owner edits and approves, then the backend sends via `MailProvider`/`MessagingProvider` |
| `reminder.create`     | Propose | Proposes a reminder for the owner or a follow-up                                                 | Owner approves content and time                                                                                  |
| `appointment.propose` | Propose | Proposes a time slot                                                                             | Owner approves; customer notification is a separate draft                                                        |
| `followup.propose`    | Draft   | Proposes an unpaid-invoice follow-up message                                                     | Draft only; owner approves each send                                                                             |

Not exposed under any name: send, approve, reject, delete, export, shell, filesystem, database, credential, settings, and any tool that sets prices or tax.

## Persistence

PostgreSQL is authoritative and holds all business records; the file store holds document bytes (hash recorded in `documents`); OpenClaw session state is private to the Gateway and never a source of truth ([DATA_MODEL.md](DATA_MODEL.md)). Hand-written, checksummed SQL migrations only ([ADR 0004](adr/0004-postgres-pgvector-sql-migrations.md)); applied files `0001` to `0003` are never edited.

## Integration adapters

Each adapter is an interface in `packages/integrations/<area>` (new workspace, **Planned**) with a vendor implementation and a mock. CI uses mocks plus real PostgreSQL; a mock never counts as evidence of a real integration. Credentials live encrypted in `provider_connections` using `CREDENTIAL_ENCRYPTION_KEY` (validated today, not yet applied by code).

| Adapter             | Implementations                                                                                                               | Authority                                                                                                      | Sync direction                                                                       | Failure modes                                                                                                                                                                    | Conflict policy                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AccountingAdapter` | Xero via `xero-node` ([ADR 0013](adr/0013-accounting-adapter-xero-ledger-authority.md)); in-memory test adapter               | Xero for posted ledger state, payments and bank reconciliation; OPENTRADIE for quotes, jobs and draft invoices | Out: contacts and issued invoices. In: invoice status, payments, voids               | Token expiry or revoked consent (stop and show "reconnect"); HTTP 429 (back off); validation errors (permanent, owner fixes data); org or tax-rate mismatch; Xero outage (retry) | Pushed invoice is locked locally; corrections are credit note or new version. On any difference, Xero wins for payment and ledger fields; OPENTRADIE flags `sync_conflict` for the owner and never overwrites the ledger |
| `SpeechToText`      | whisper.cpp `whisper-server` (local); faster-whisper (optional hosted); mock ([ADR 0014](adr/0014-speech-to-text-adapter.md)) | OPENTRADIE owns audio and transcript; the transcript is a proposal source, not a fact                          | Out: audio to transcriber. In: transcript text                                       | Service down or model missing (task fails, voice note kept, retry); unsupported audio (convert or reject); empty or low-confidence output; `LOCAL_ONLY` blocks hosted variant    | Transcript is immutable; owner edits create a new revision. Derived job updates are proposals                                                                                                                            |
| `MailProvider`      | Gmail OAuth and Microsoft Graph (**Planned**); mock                                                                           | Mailbox owns the raw email; OPENTRADIE owns the thread linkage, drafts and status                              | In: new messages (poll or push). Out: sends only after owner approval                | OAuth expiry; duplicate delivery (dedupe by provider message id); send rejected; attachment too large or malicious                                                               | Re-sync never deletes OPENTRADIE records; deleted-at-source messages are marked, not removed                                                                                                                             |
| `CalendarProvider`  | ICS export first; Google/Microsoft later (**Planned**); mock                                                                  | OPENTRADIE owns appointments                                                                                   | Out: appointments. In (later): busy times only                                       | Token expiry; time zone and DST errors; double booking                                                                                                                           | OPENTRADIE wins; external edits are shown as conflicts, not applied                                                                                                                                                      |
| `MessagingProvider` | WhatsApp Business or SMS via relay (**Planned**); mock                                                                        | Provider owns delivery state; OPENTRADIE owns the message record                                               | In: webhook through relay (HMAC-signed, existing harness). Out: after owner approval | Webhook replay (dedupe on `relay_inbox`), template or window rules, delivery failure                                                                                             | Provider delivery status overwrites only delivery fields                                                                                                                                                                 |
| `FileStore`         | Local FS and S3 (**Implemented and tested** local; S3 **Implemented, not integration-tested**)                                | OPENTRADIE                                                                                                     | n/a                                                                                  | Disk full, S3 unreachable; hash mismatch                                                                                                                                         | Content-addressed by `sha256` in `documents`; no overwrite                                                                                                                                                               |
| `AgentRuntime`      | `RealOpenClawAgentRuntime`, `MockAgentRuntime`                                                                                | Gateway owns agent session state only                                                                          | Request and event stream                                                             | Gateway down, policy blocks (`LOCAL_ONLY`), malformed proposal (rejected by Zod)                                                                                                 | Backend validation always wins                                                                                                                                                                                           |
| `LLM` / embeddings  | Existing embeddings providers; hosted inference only through the Gateway                                                      | n/a                                                                                                            | n/a                                                                                  | Provider unavailable; policy denied (no fallback)                                                                                                                                | n/a                                                                                                                                                                                                                      |

## Xero ledger versus operational invoices

OPENTRADIE keeps **operational** invoices: a draft created from a job or accepted quote, reviewed and approved by the owner, numbered by OPENTRADIE, and rendered as an NZ tax-invoice PDF. Xero holds the **ledger**: once an invoice is pushed, Xero is the authority for its posted amounts, payments, bank reconciliation, GST returns and period locks.

1. Draft and approved invoices are editable only in OPENTRADIE. Approval freezes the lines, rates and GST: approved `invoices` and `invoice_lines` rows (0006) become immutable, enforced by the service and a trigger or CHECK designed in PR 2.5.
2. Issue enqueues an outbox event; the Xero adapter creates or updates the contact, then the invoice (status authorised) with the OPENTRADIE invoice number as reference. The returned Xero ids are stored in `accounting_external_refs`.
3. Re-sending must not create duplicates: look up by stored external id first, then by invoice number/reference, then create. (Whether Xero accepts an idempotency key is **unverified**; the xero-node README does not mention one.)
4. Payment status flows back by scheduled pull (webhooks only if later justified) into `payment_snapshots`. Snapshots are read-only evidence; they drive "paid" display and unpaid follow-ups.
5. After issue, changing an amount in OPENTRADIE is blocked; the owner issues a credit note or a replacement invoice, both pushed through the same path.
6. GST amounts on the invoice come from OPENTRADIE's integer-cents engine; if Xero returns a different total (rounding or tax rate setup) the invoice is flagged `sync_conflict` and not auto-corrected.
7. Xero connection cost, tier limits and egress charges are **unverified** and must be checked before shipping (finding 3 in [open-source-assessment.md](open-source-assessment.md)).

## Money and tax design (Planned, Phase 2)

- Quantities become fractional, stored as integer **thousandths** (`quantity_milli`), so 1.5 hours is 1500. Line total = `round_half_up(unit_price_cents * quantity_milli / 1000)` computed with bigint. The existing CHECK `line_total_cents = quantity * unit_price_cents` is replaced in a new table version, not by editing `0001`.
- Markup in basis points on cost-type lines, applied before tax, with the rounding rule stated in the quote assumptions.
- Tax treatment per line: `standard` (business GST rate, 15% as a configurable basis-point value), `zero_rated`, `exempt`. Tax is still rounded once on the taxable subtotal ([ADR 0007](adr/0007-integer-cents-deterministic-pricing.md) rule), and the document shows GST-inclusive and exclusive totals.
- NZ tax-invoice content (supplier name and GST number, the words "tax invoice", date, description, amounts and GST, plus buyer details above the IRD threshold) is **unverified** here because the IRD site was unreachable; confirm the current rules with IRD guidance before building Phase 3 templates.

## Data model plan

### Existing tables (migrations 0001 to 0003): Implemented and tested

| Migration                 | Tables                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0001 foundation           | `businesses`, `users`, `sessions`, `customers`, `customer_contacts`, `jobs`, `job_notes`, `communications`, `documents`, `approved_rates`, `quotes`, `quote_line_items`, `approval_requests`, `provider_connections`, `audit_events`, `knowledge_items`, `idempotency_records` |
| 0002 queue, relay, policy | `scheduled_tasks`, `scheduled_task_failures`, `relay_inbox`, `model_use_approvals`, `installation_claim`                                                                                                                                                                       |
| 0003 embeddings           | `knowledge_embeddings` (needs pgvector)                                                                                                                                                                                                                                        |
| migrator                  | `schema_migrations` (name and SHA-256 checksum)                                                                                                                                                                                                                                |

### Planned migrations: all Planned, none written

Every new table carries `tenant_id` and composite `(tenant_id, id)` foreign keys, and every mutation writes an `audit_events` row in the same transaction.

| Migration | Phase | Additions                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0004      | 1     | `properties` (customer sites: address parts, access notes, optional link from `jobs`), `job_events` (append-only timeline: status changes, notes, quote/invoice milestones), `job_evidence` (links a `documents` row, photo or file, to a job with caption and taken-at), `exports` (export requests, status, file reference, checksum)                                                       |
| 0005      | 2     | `quote_versions` and `quote_version_lines` (fractional `quantity_milli`, cost and markup basis points, tax treatment per line, stated assumptions); quote states `draft`, `approved` (owner approved, not yet sent; retained from 0001), `sent`, `accepted`, `rejected`, `expired`, `superseded`; `quote_acceptance_tokens` (hashed single-use tokens with expiry, never stored in plaintext) |
| 0006      | 3     | `business_tax_profile` (GST number, registered address, invoice prefix), `invoices`, `invoice_lines`, `invoice_number_sequences`, `accounting_external_refs`, `outbox_events`, `sync_attempts`, `payment_snapshots`                                                                                                                                                                           |
| 0007      | 4     | `agent_tool_calls`, `voice_notes`, `transcripts` (immutable revisions), `action_proposals`                                                                                                                                                                                                                                                                                                    |
| 0008      | 5     | `threads`, `messages` (replaces ad hoc use of `communications`; migration of existing rows decided in that phase), `message_attachments` (to `documents`)                                                                                                                                                                                                                                     |
| 0009      | 6     | `appointments`, `availability_rules`, `reminders`                                                                                                                                                                                                                                                                                                                                             |

Design decisions to confirm in the owning phase:

- **Quote states.** The brief's list has no `approved`; 0001 already stores it and the approval flow depends on it, so 0005 extends the CHECK list rather than removing it. `rejected` is used for both owner rejection and customer rejection, distinguished by a `decision_source` column.
- **Existing quote tables.** `quote_line_items` has integer quantity `1..10000`; 0005 adds the new version tables and migrates existing rows into version 1 without editing applied files. Whether the old tables remain as views or are retired is decided in PR 2.3.
- **`communications` versus `threads`/`messages`.** 0008 supersedes `communications`; the existing table and its API (`GET /api/communications`) stay until a data-migration test exists.

## What changes in the repository layout (Planned)

```text
apps/api/src/modules/<module>/          routes, services, schemas per domain module (incremental)
packages/core/                           pure rules: money v2, quote v2, invoice, GST, state machines
packages/documents/                      PDF templates (react-pdf), pure functions from snapshots
packages/integrations/<area>/            accounting, speech, mail, messaging, calendar adapters + mocks
packages/database/migrations/0004..0009  hand-written SQL
deployments/                             restic, whisper-server, optional faster-whisper unit files (unverified until run)
```
