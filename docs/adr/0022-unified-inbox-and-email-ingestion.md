# ADR 0022: Unified inbox and email ingestion

- Status: Accepted (Phase 5, Feature 8). Refines [ADR 0015](0015-native-communications-model-no-chatwoot.md).
- Date: 2026-10-20

## Context

ADR 0015 decided that OPENTRADIE owns its communications data and that providers sit behind adapters. Feature 8's acceptance: a new customer enquiry received by email becomes a customer and job record, with an AI-prepared reply awaiting approval; nothing is sent without owner approval. There is still no mail OAuth app, no test mailbox and no PostgreSQL wiring for encrypted provider tokens.

## Decision

1. **Schema (migration `0008_inbox.sql`).** ADR 0015 named new `threads`/`messages`/`message_attachments` tables. We instead add `communication_threads` and **extend the existing `communications` table** (thread id, RFC 5322 `Message-ID`/`In-Reply-To`/`References`, from/to/cc addresses, received/read times, `triage` jsonb, `triage_status`, approval, send attempt and provider ids, safe `send_error_code`) and add `documents.communication_id` for attachments. Existing rows, `GET /api/communications`, quote-send drafts and the relay handler keep working unchanged (`origin = 'legacy'`), so no data migration is needed. `webhook_receipts` (unique per tenant, provider and event id) records signed deliveries. `jobs.origin` gains `email`.
2. **Ingestion is deterministic and server-side.** One pipeline (`apps/api/src/services/inbox.ts`) serves the signed webhook `POST /inbound/email/:provider` and the owner's `POST /api/inbox/paste`: parse MIME (postal-mime 4.0.4, MIT-0), de-duplicate by event id and by `Message-ID`, thread by `In-Reply-To`/`References`, then provider thread id, then normalised subject from the same sender within 30 days. The customer is matched by exact email (customer or contact); a display-name match links only on an exact name and is flagged for review; anything ambiguous is flagged `needs_review` and never guessed. A single open job links; several mark `job_ambiguous`. A new sender whose message reads like a request for work (keyword rules in `packages/core/src/inbound-email.ts`, automated mail excluded) gets a customer and a `new` job through the same intake services `POST /api/enquiries` uses (`apps/api/src/services/intake.ts`). No model output decides any of this.
3. **The agent only drafts.** A queued `inbox.triage` task applies the privacy policy first (new purpose `message_triage`; `LOCAL_ONLY` fails closed for hosted, no fallback), then asks the runtime for a strictly validated object: summary, classification enum, reply draft, non-executing suggested actions. The body is passed as data inside an unguessable delimited block; hidden HTML is removed before storage. The backend stores one outbound `draft` per inbound message and flags drafts containing prices, bank details, links or addresses.
4. **Sending needs an owner approval and is at most once.** `POST /api/communications/:id/approve-send` (owner, idempotent) records the approval and queues `inbox.send` keyed by message and attempt. The task moves `approved → sending → sent`; a retry that finds `sending` records `SEND_OUTCOME_UNKNOWN` instead of resending. Without a mail connection it fails visibly with `NO_MAIL_CONNECTION`. Provider errors become safe codes; there is no automatic resend, the owner re-approves.
5. **Adapters.** `MailProvider` (`packages/integrations/src/mail`) with `GmailMailAdapter` and `MicrosoftGraphMailAdapter` over injectable HTTP (**Implemented, not integration-tested**), a raw-MIME path for the generic webhook, and `FakeMailAdapter`. Production wiring returns no connection until tokens are stored in `provider_connections`. `MessagingProvider` (WhatsApp, SMS) is an interface and fake only (**Planned**).
6. **Inbox tasks run in the API process** (they need the agent runtime and mail connections); the API keeps a loop for them even with `RUN_WORKER=false`.
7. **PWA.** Inbox is reached from Home (`#/inbox`, `#/inbox/paste`, `#/inbox/:id`), not a new bottom tab, so the tab bar still fits at 360px alongside the Calendar and Approvals tabs being added in parallel.

## Consequences

- The acceptance path is Implemented and tested with the mock runtime, the fake mail provider and real PostgreSQL; no real mailbox has been connected, so no real email integration is claimed.
- OpenClaw-backed triage is not implemented: `RealOpenClawAgentRuntime` has no `triageMessage`, so with a real Gateway triage records `unavailable` and the owner writes the reply. The prompt builder exists and is tested for when it is added.
- In `APPROVAL_REQUIRED` mode background triage is always denied (no owner is present to grant a single-use approval).
- Extending `communications` keeps one message table; ADR 0015's separate tables are superseded on that point.
- Attachments are limited to the evidence allowlist (JPEG, PNG, WebP, HEIC, PDF; content must match the type), 10 per message, 10 MiB each.
