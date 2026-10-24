# ADR 0015: Native communications model; Chatwoot rejected

- Status: Accepted; implemented in Phase 5 as refined by [ADR 0022](0022-unified-inbox-and-email-ingestion.md) (communications extended instead of new message tables)
- Date: 2026-10-19

## Context

OPENTRADIE must handle customer email and messages linked to customers, jobs, quotes and approvals, with drafts that the owner approves before anything is sent. Chatwoot v4.18.0 is a full shared-inbox product (MIT outside its `enterprise/` directory) built on Ruby on Rails with Redis and Sidekiq in addition to PostgreSQL (stack as given in the project brief; not re-read from the repository). Today's repository has a `communications` table, a relay inbox with HMAC ingress ([RELAY.md](../RELAY.md)) and no mail or messaging adapter.

## Decision

1. OPENTRADIE owns the canonical communications data: `threads`, `messages` and `message_attachments` (migration 0008) in the single PostgreSQL database, linked to customers and jobs, with attachments in the `FileStore`.
2. Providers sit behind `MailProvider` and `MessagingProvider` adapters. Inbound arrives by poll, push or the signed relay; messages are de-duplicated by provider message id. Outbound is sent only after an owner approval record exists; the agent can only create drafts (`communication.draft`).
3. Provider delivery status updates delivery fields only; it never deletes or rewrites OPENTRADIE records.
4. **Chatwoot is rejected** (and any similar inbox product deferred): it would add a Rails, Redis and Sidekiq stack per installation and a second message store, and synchronising it with OPENTRADIE would create a conflict surface for what must be a single authoritative record. The decision is architectural; the licence (MIT outside `enterprise/`) is not the obstacle.
5. EspoCRM and Twenty (AGPL) are read for timeline concepts only ([ADR 0011](0011-oss-integration-strategy.md)).
6. Existing `communications` rows and `GET /api/communications` remain until a tested data migration to `threads`/`messages` exists.

## Consequences

- We build email first, then one messaging channel, instead of inheriting many channels; the estimated saving from Chatwoot (large for a multi-channel inbox) is given up.
- All message bodies stay out of logs; injection tests must cover inbound content.
- Phase 5 is blocked on a mail provider OAuth app and a test mailbox; no real email integration is claimed until it has been run.
