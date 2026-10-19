# ADR 0020: Accounting adapter contract, Xero via the official SDK

- Status: Accepted; implemented, not integration-tested
- Date: 2026-10-19

## Context

Trades businesses already keep their books in an accounting system, and Xero is the first target. Any accounting integration has to keep the product's rules: money as integer cents, writes that are idempotent and auditable, credentials encrypted at rest, and provider responses treated as untrusted. MYOB and QuickBooks may follow later.

## Decision

- A provider-independent `AccountingAdapter` contract lives in a new workspace package, `@opentradie/integrations` (`packages/integrations`). One shared contract test suite runs against every implementation.
- **Authority:** the accounting provider is the authoritative ledger: its invoice numbers, tax, posting status and payments. OPENTRADIE owns the operational invoice and its sync status. OPENTRADIE pushes contacts and **draft** invoices only and reads back status, totals and payments. It never authorises or voids posted invoices.
- Money crosses the contract only as integer cents and quantities only as integer thousandths. Conversion to provider decimals happens only inside adapters, with exact decimal strings. Where an SDK demands a JS number, the number must serialise back to the same decimal or the write is refused.
- Every write takes a caller-supplied idempotency key. Keys are derived deterministically from tenant, operation, entity and revision.
- Errors are normalised to `AuthExpired`, `ReauthorisationRequired`, `RateLimited(retryAfter)`, `Validation`, `Conflict`, `Transient` and `Permanent`. Error messages never contain tokens or provider bodies.
- The Xero adapter uses the official MIT-licensed `xero-node` SDK, pinned to `20.0.0` (released 2026-09-18), for API calls. The SDK client is injected so tests can use a fake. OAuth (authorize URL with state and PKCE, code exchange, refresh) uses a small client of our own, because the SDK's consent helpers do not support PKCE and do OpenID discovery over the network.
- Provider tokens are sealed in a versioned AES-256-GCM envelope. The additional authenticated data (AAD) binds tenant id, provider and key id. Sealed tokens go in `provider_connections.encrypted_credentials`, with the key id in `encryption_key_id`. Retired keys can still decrypt, and rows are re-encrypted with the active key on read.

## Consequences

- Persistence goes through repository interfaces (`ConnectionStore`, `TokenStore`, `ExternalReferenceStore`) with in-memory implementations. PostgreSQL implementations, API routes and worker jobs are not wired yet.
- `xero-node` brings `axios` and `openid-client` (MIT/ISC) as runtime dependencies.
- The Xero adapter stays "Implemented, not integration-tested" until the live-verification steps in `docs/integrations/accounting.md` have been run against a Xero demo organisation and the results recorded.
