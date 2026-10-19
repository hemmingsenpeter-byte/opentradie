# ADR 0008: Postgres-backed job queue

- Status: Accepted (design); implementation status TBD at merge
- Date: 2026-10-19

## Context

Scheduled and retried work needs durability, leasing, idempotency and failure recording, without adding a message bus.

## Decision

The intended design is PostgreSQL tables (`scheduled_tasks`, `idempotency_records`) with row-level leasing (`FOR UPDATE SKIP LOCKED`), attempt counts and recorded failures behind a `JobQueue` interface and no external broker. At the time of writing the `scheduled_tasks` and `idempotency_records` tables exist in the schema; no leasing worker was found in the repository.

## Consequences

- Jobs survive restarts and are included in backups.
- Throughput is limited to what one PostgreSQL instance can lease, which is ample for this product.
- The state of the worker implementation is recorded in docs/ROADMAP.md and README; do not assume it exists from this ADR.
