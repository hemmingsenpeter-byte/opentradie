# ADR 0012: Durable workflows through a transactional outbox on the existing queue

- Status: Accepted; implemented in migration `0010` as `event_outbox` and `accounting_sync_attempts` (see [ADR 0023](0023-invoices-outbox-and-xero-sync.md); `0006` was not used because the tables reference `0007`)
- Date: 2026-10-19

## Context

Invoice issue, Xero sync, message sending, reminders and follow-ups must survive crashes and must not run inside request transactions. Options reviewed: keep the in-repo `PostgresJobQueue` ([ADR 0008](0008-postgres-backed-job-queue.md)), adopt pg-boss 12.38.0 (MIT, Node >= 22.12.0) or adopt Temporal v1.32.1 (MIT, separate server cluster). The current queue already provides idempotent enqueue per `(tenant_id, kind, idempotency_key)` that can join the caller's transaction, `FOR UPDATE SKIP LOCKED` leasing, lease reclaim, exponential backoff, permanent failures and recorded failure rows, tested in `tests/integration/queue-and-relay.test.ts`.

## Decision

Keep `PostgresJobQueue` and add a **transactional outbox** (`outbox_events`, `sync_attempts`; migration 0006):

- A business change and its outbox row are written in one transaction. A dispatcher task, enqueued with the outbox id as idempotency key, performs the external call through an adapter and records each attempt.
- Handlers are idempotent; a provider's external id is stored and checked before any create.
- Transient errors retry with the existing backoff; permanent errors stop and are shown to the owner as needing attention.
- Long-running flows (dunning, reminders) are sequences of scheduled tasks with state in domain tables, not a workflow engine.

pg-boss is **reference only**: it would duplicate a working, tested queue and add a second migrator and tables. Temporal is **rejected**: a separate stateful cluster per installation contradicts "one authoritative database" and is out of proportion for a sole trader's Mac mini.

## Consequences

- No new infrastructure and no new dependency; backups already include queue tables.
- Throughput is bounded by one PostgreSQL instance, which is ample here (as in ADR 0008).
- We maintain cron-style and rate-limiting features ourselves if they are needed; revisit pg-boss if the queue grows beyond leasing, retries and scheduling.
- Outbox atomicity and idempotent redelivery must be tested against real PostgreSQL.
