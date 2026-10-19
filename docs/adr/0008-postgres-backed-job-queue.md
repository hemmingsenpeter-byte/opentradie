# ADR 0008: Postgres-backed job queue

- Status: Accepted; implemented
- Date: 2026-10-19

## Context

Scheduled and retried work needs durability, leasing, idempotency and failure recording, without adding a message bus.

## Decision

Durable work lives in PostgreSQL tables with no external broker: `scheduled_tasks` (with `scheduled_task_failures`, one row per failed attempt) for queued work, `relay_inbox` for relayed events, and `idempotency_records` for duplicate-request protection on API mutations. `PostgresJobQueue` (`packages/platform/src/job-queue.ts`) provides at-least-once delivery: enqueue is idempotent per `(tenant_id, kind, idempotency_key)` and can join the caller's transaction; leasing uses `FOR UPDATE SKIP LOCKED` and also reclaims tasks whose lease expired (a crashed worker); retries use exponential backoff (1 s base, 5 min cap, 5 attempts by default); a `PermanentTaskError` skips remaining retries. Handlers must be idempotent. Current task kinds are `relay.process` and `knowledge.embed`.

The worker loop runs inside the API process by default (`RUN_WORKER`, on unless set to `false`) or as the separate `apps/worker` process (`pnpm start:worker`).

## Consequences

- Jobs survive restarts and are included in backups.
- Throughput is limited to what one PostgreSQL instance can lease, which is ample for this product.
- Behaviour is covered by `tests/integration/queue-and-relay.test.ts` (leasing, retries, permanent failures, expired leases).
