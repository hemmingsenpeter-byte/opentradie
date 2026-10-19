# Architecture

OPENTRADIE is a modular monolith: one TypeScript codebase, one API process, one PostgreSQL schema. The same code runs in three deployment profiles (local, cloud, hybrid); only configuration, adapters and packaging differ ([ADR 0003](adr/0003-one-product-three-deployment-profiles.md)).

## Status vocabulary

Every doc uses these four labels. They were reconciled against the merged code on 2026-10-19. CI results are not claimed here: see GitHub Actions.

| Label                               | Meaning                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| Implemented and tested              | Code exists and automated tests exercise it              |
| Implemented, not integration-tested | Code exists; no test against the real external system    |
| Scaffolded                          | Structure, config or contract only; behaviour incomplete |
| Planned                             | Not started                                              |

## Shape

```text
Channels         PWA / dashboard (apps/web)          future: WhatsApp, email, Shortcuts, voice
                          |
OPENTRADIE API   apps/api (Fastify + Zod)
                 authn/authz, tenant scope, customers, jobs, quotes, approvals,
                 audit, privacy-policy enforcement, business-tool boundary
                          |
Agent adapter    packages/agent: AgentRuntime
                 MockAgentRuntime | RealOpenClawAgentRuntime (Gateway WebSocket client)
                          |
Portable infra   PostgreSQL, pgvector optional (packages/database), file store (local FS | S3),
                 job tables, secrets from environment
```

Workspaces: `apps/api`, `apps/web`, `packages/core` (pricing, GST, quote versions, approval rules, privacy policy), `packages/documents` (quote and invoice PDF rendering), `packages/database` (schema, SQL migrations, seed), `packages/agent` (runtime adapters), `packages/integrations` (accounting contract, Xero adapter, speech-to-text adapters, credential envelope), `packages/platform` (runtime configuration, Postgres job queue and task handlers, relay contract, file stores, embedding providers, logical backup, installation claim), `apps/worker` (standalone queue worker; the API also runs the worker in-process unless `RUN_WORKER=false`).

## Rules that shape the code

- Agents propose; the backend validates; owners approve. The agent has no tools in v0.1 and no send, approve, shell, filesystem or database access.
- All material side effects go through validated API services and are audited.
- Money is integer cents; prices come from approved rate records ([ADR 0007](adr/0007-integer-cents-deterministic-pricing.md)).
- `tenant_id` comes from the authenticated session, never from client input ([ADR 0006](adr/0006-single-tenant-runtime-tenant-id-from-auth.md)).
- Privacy mode is enforced server-side and fails closed ([ADR 0005](adr/0005-privacy-modes-fail-closed.md)).
- OpenClaw is an external runtime reached only through its Gateway protocol ([ADR 0002](adr/0002-openclaw-gateway-client-only-agent-runtime.md)).

## Request flow: enquiry to accepted quote

1. The owner submits an enquiry (`POST /api/enquiries`).
2. The API gathers tenant-scoped context (customers, notes, approved rates) and calls `AgentRuntime.interpret`. Under the current privacy mode the policy check runs first.
3. The agent returns a proposal (customer query, rate code, quantity). The backend validates it against real records, asks for clarification if ambiguous, and never trusts agent-supplied prices.
4. `calculateQuote` selects approved-rate lines and records assumptions and missing information; the draft (numbered `Q-0001`, …) is priced and totalled by the core GST engine with the business's tax settings.
5. The owner may edit draft lines (`PATCH /api/quotes/:id`: approved rates, material cost plus markup, or an owner-entered price; fractional quantities, tax codes, discounts). The server reprices every line and recalculates GST; clients never send totals.
6. The owner approves (`POST /api/quotes/:id/approve`); only the `owner` role can, and an audit event is written in the same transaction.
7. The owner sends (`POST /api/quotes/:id/send`): the PDF is rendered and stored, a single-use acceptance link is issued (only its SHA-256 is stored), and an outbound message **draft** with the link is recorded. Nothing is emailed; there is no email provider yet.
8. The customer opens `/q/<token>` (no sign-in) and accepts or declines with a typed name (`POST /api/public/quotes/:token/accept|decline`). The decision, an append-only `quote_decisions` record, a `customer` audit event and a timeline event are written together. See [ADR 0018](adr/0018-quote-sending-and-customer-acceptance.md).

The OpenAPI document at `/api/openapi.json` is authoritative for routes. Every mutation needs an `Idempotency-Key` header and an `Origin` equal to `APP_ORIGIN`.

## Routes

`GET /health` (public; 200 with `ok` or `degraded`, 503 when the database is unavailable) and `GET /api/openapi.json`. Authenticated by session cookie: `POST /api/auth/login` (10 per minute), `POST /api/auth/logout`, `GET /api/me`, `GET /api/state`, `GET /api/search?q=`, `GET /api/communications`, `GET /api/rates`, `GET /api/audit-events`, `GET|POST /api/customers`, `GET|PATCH|DELETE /api/customers/:id` (DELETE archives), `POST|GET /api/customers/:id/contacts`, `POST /api/customers/:id/properties`, `GET /api/properties?q=&customerId=`, `GET|PATCH|DELETE /api/properties/:id` (DELETE archives), `GET|POST /api/jobs`, `GET|PATCH /api/jobs/:id` (GET is the job card: job, customer, property, allowed next statuses, notes, documents, quotes and timeline; PATCH validates status transitions and returns 409 `INVALID_STATUS_TRANSITION` or `REOPEN_REQUIRED`), `POST /api/jobs/:id/notes`, `POST /api/jobs/:id/evidence` (JSON with base64 content; JPEG, PNG, WebP, HEIC or PDF up to 6 MiB, bytes must match the type; 8 MiB body limit on this route only), `GET /api/documents/:id/content`, `GET /api/export` (owner only, audited), `POST /api/enquiries`, `GET /api/quotes`, `GET|PATCH /api/quotes/:id` (PATCH edits draft lines), `POST /api/quotes/:id/approve`, `POST /api/quotes/:id/reject`, `POST /api/quotes/:id/send`, `POST /api/quotes/:id/revise`, `GET /api/quotes/:id/pdf`, `GET|PATCH /api/settings/business` (GST registration and number, price entry, validity, default markup), `GET /api/approvals`, `GET /api/model-policy`, `POST /api/model-approvals`. Public, no session, reached only with an acceptance token (30 GET and 10 POST per minute; POSTs still need `Origin` = `APP_ORIGIN`): `GET /api/public/quotes/:token`, `GET /api/public/quotes/:token/pdf`, `POST /api/public/quotes/:token/accept`, `POST /api/public/quotes/:token/decline`. The PWA renders the customer page at `/q/:token`. `POST /relay/v1/events` exists only when `RELAY_SHARED_SECRET` is set and is authenticated by HMAC signature, not a session. Every mutating business route requires the `owner` role (a viewer gets 403). Other limits: 300 requests per minute globally, 600 for the relay route, 60 for evidence uploads, 10 for export, 64 KiB request bodies except evidence uploads.

Job status transitions are decided only by `packages/core/src/job-status.ts`: `new` to `quoted`, `scheduled`, `in_progress` or `cancelled`; `quoted` to `scheduled`, `in_progress` or `cancelled`; `scheduled` to `in_progress` or `cancelled`; `in_progress` to `completed` or `cancelled`. A `completed` job can be reopened to `in_progress` and a `cancelled` job to `new`, only with `reopen: true`. Each job mutation (create, status, property, details, note, evidence, quote draft, edit, approval, rejection, send, customer acceptance or decline, expiry, revision) appends a `job_events` row in the same transaction ([ADR 0017](adr/0017-job-lifecycle-and-append-only-timeline.md)).

## Component status

| Component                                                                                                    | Status                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pricing, approval rule, privacy policy (`packages/core`)                                                     | Implemented and tested (`packages/core/src/*.test.ts`, `tests/security`)                                                                                                                                                                                                                                                       |
| Fractional-quantity pricing, NZ GST, quote versions, TSI checks, GST number check digit (`packages/core`)    | Implemented and tested; quotes persist milli quantities, line kinds, tax codes, price sources and per-code GST (ADR 0016, ADR 0018). Invoices are not persisted yet (TSI checks are pure code only)                                                                                                                            |
| Quote editing, sending, revisions, customer acceptance and expiry                                            | Implemented and tested (`tests/integration/quotes-acceptance.test.ts`, `tests/e2e/quote-acceptance.spec.ts`). Sending records a message draft only: no email or SMS is delivered (Planned)                                                                                                                                     |
| Quote and invoice PDFs (`packages/documents`)                                                                | Quote PDF: Implemented and tested, rendered and stored on send. Invoice PDF: Implemented and tested as pure code; not wired to the API                                                                                                                                                                                         |
| Schema and SQL migrations `0001` to `0005`                                                                   | Implemented and tested on PostgreSQL 16 locally (including upgrades of pre-`0004` jobs and pre-`0005` quotes) and earlier on embedded PostgreSQL 17; `0003` (pgvector) needs the extension and is exercised by the CI pgvector service                                                                                         |
| API with auth, tenant scope, audit, rate limiting                                                            | Implemented and tested (`tests/integration`, `tests/security`)                                                                                                                                                                                                                                                                 |
| Customers, contacts, properties and job cards (status transitions, timeline, notes, photo and file evidence) | Implemented and tested (`packages/core/src/job-status.test.ts`, `tests/integration/job-cards.test.ts`, `tests/security`, `tests/e2e/job-card.spec.ts`)                                                                                                                                                                         |
| Business data export (`GET /api/export`, versioned JSON, no secrets)                                         | Implemented and tested (`tests/integration/job-cards.test.ts`); file contents are not embedded, only their checksums and storage keys                                                                                                                                                                                          |
| `MockAgentRuntime`                                                                                           | Implemented; never evidence of real integration                                                                                                                                                                                                                                                                                |
| `RealOpenClawAgentRuntime`                                                                                   | Implemented, not integration-tested unless the smoke procedure has been run ([OPENCLAW_INTEGRATION.md](OPENCLAW_INTEGRATION.md))                                                                                                                                                                                               |
| Web app (PWA)                                                                                                | Implemented and tested (12 component tests; 4 Playwright journeys: quote approval, viewer refusal, job card from customer to export, quote edit → send → customer acceptance); quote editor, GST settings, public `/q/:token` page; installable manifest and service worker. A full 360 px phone-width audit has not been done |
| Postgres-backed job queue and worker                                                                         | Implemented and tested (leasing, retries, recorded failures; `tests/integration/queue-and-relay.test.ts`)                                                                                                                                                                                                                      |
| Local FS file store                                                                                          | Implemented and tested                                                                                                                                                                                                                                                                                                         |
| S3 file store                                                                                                | Implemented, not integration-tested (in-memory fake only)                                                                                                                                                                                                                                                                      |
| Relay ingress and delivery harness                                                                           | Implemented and tested (HMAC-signed `POST /relay/v1/events`); no public relay                                                                                                                                                                                                                                                  |
| Accounting adapter contract, Xero adapter (`packages/integrations`)                                          | Contract and fake adapter: Implemented and tested. Xero adapter: Implemented, not integration-tested ([accounting](integrations/accounting.md))                                                                                                                                                                                |
| Speech-to-text adapters (whisper.cpp, OpenAI-compatible)                                                     | Implemented, not integration-tested; mock for tests ([speech](integrations/speech.md))                                                                                                                                                                                                                                         |
| Provider credential envelope (AES-256-GCM)                                                                   | Implemented and tested in memory; not yet wired to `provider_connections`                                                                                                                                                                                                                                                      |
| Email, WhatsApp; Xero/speech routes and jobs                                                                 | Planned                                                                                                                                                                                                                                                                                                                        |

## Observability

Structured JSON logs (Fastify/pino) with a request ID returned to clients, a `/health` endpoint that checks the database, and log redaction rules: never log message bodies, credentials, prompts or provider responses. Metrics endpoint: Planned.
