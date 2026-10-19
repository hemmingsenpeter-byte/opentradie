# ADR 0013: AccountingAdapter with Xero as ledger authority

- Status: Accepted; planned for Phase 3 (not implemented). No Xero integration exists or is claimed.
- Date: 2026-10-19

## Context

Customers in New Zealand commonly keep their books in Xero. OPENTRADIE needs quotes, jobs and invoice preparation, but must not become a second ledger. `provider_connections` already allows provider `xero` but no code uses it. `xero-node` 20.0.0 (MIT; depends on `axios` and `openid-client`) provides a typed client with OAuth2 code flow and token refresh (access tokens 30 minutes, refresh tokens 60 days per its README). `xero-python` is the same API in a runtime we do not have. Xero's API pricing was reported as moving to commercial tiers from 2 March 2026; the official page was not reachable during review, so costs and limits are **unverified**.

## Decision

1. Define an `AccountingAdapter` interface in `packages/integrations/accounting` with an in-memory test implementation and a Xero implementation built on `xero-node`. Business code never imports the Xero SDK.
2. **Authority.** OPENTRADIE is authoritative for quotes, jobs and draft/approved invoices until issue. After a successful push, Xero is authoritative for posted ledger state, payments and reconciliation. Issued invoices are immutable locally; corrections use credit notes or replacement invoices.
3. **Direction.** Outbound: contacts and issued invoices, driven by the outbox ([ADR 0012](0012-durable-workflow-outbox-on-existing-queue.md)). Inbound: invoice status and payments by scheduled pull into read-only `payment_snapshots`.
4. **Conflicts.** Xero wins for payment and ledger fields. A total or status difference marks the invoice `sync_conflict` for the owner; OPENTRADIE never silently overwrites the ledger or auto-edits an issued invoice.
5. **Duplicates.** Look up the stored external id, then invoice number/reference, before creating. Whether Xero supports an idempotency key is unverified.
6. **Credentials.** Tokens are stored encrypted in `provider_connections` with `CREDENTIAL_ENCRYPTION_KEY`; refresh-token rotation is transactional; tokens never appear in logs.
7. **Evidence.** CI uses the test adapter. Real integration is claimed only after an opt-in sandbox test (Xero demo company) has been run, following the pattern of `pnpm test:openclaw`.
8. `xero-python` is rejected (no Python service).

## Consequences

- Phase 3 is blocked on Xero app registration, sandbox credentials and a check of API tier cost.
- Tax-rate and account-code mapping between OPENTRADIE and the customer's Xero organisation needs a settings screen and validation; mismatches are permanent errors shown to the owner.
- OAuth redirect handling differs by profile (a local Mac mini needs a reachable callback or loopback flow); to be documented with the adapter.
