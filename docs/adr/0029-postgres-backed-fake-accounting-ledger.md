# ADR 0029: PostgreSQL-backed fake accounting ledger

Status: Accepted (2026-10-21)

## Context

The fake accounting adapter kept its ledger in the memory of the process that built it. With `RUN_WORKER=false` and a separate `apps/worker`, the worker posted invoices to a different ledger than the one the API's mock payment route and reconciliation read, so demos and e2e setups with a separate worker broke.

## Decision

- The fake adapter takes a `FakeLedgerStore`. `InMemoryFakeLedger` stays the default for unit and contract tests.
- `PostgresFakeLedger` (packages/platform) is used whenever `ACCOUNTING_PROVIDER=fake`. Migration 0018 adds tenant-scoped `fake_accounting_contacts`, `_invoices`, `_payments`, `_idempotency` and a sequence for ids. Idempotent writes are serialised per key with a PostgreSQL advisory lock, so two processes cannot both create the same invoice.
- The tables are demo/test only: not business data, not read by business logic, excluded from the data export. All existing gating is unchanged (fake refused in the cloud profile and with `NODE_ENV=production`; `ACCOUNTING_ALLOW_FAKE=true` required).
- `simulateAuthorise` and `simulatePayment` are now async.
- The shared contract suite also runs against the PostgreSQL-backed fake.

## Consequences

The fake behaves like an external system shared by all processes. It is still a mock: nothing here is evidence that Xero works.
