# ADR 0018: Quote sending and customer acceptance

- Status: Accepted
- Date: 2026-10-19

## Context

Phase 2b must let a tradie prepare, send and have a customer accept a quote with correct totals and a complete approval record (features 7, 9 and 13). ADR 0016 provided the pricing/GST engine and PDF rendering as pure code. There is no email provider yet, and the customer has no account.

## Decision

**Persistence (migration `0005_quotes_gst_acceptance.sql`).**

- Each quote version is a `quotes` row. Versions of one quote share `quote_number` (per-business sequence `Q-0001`, from `businesses.next_quote_number`) and `quote_group_id`; `revision` counts 1, 2, … and `previous_version_id` links back. A partial unique index allows only one non-superseded version per group. This replaces the separate `quote_versions` tables sketched in `architecture-v2.md`: existing rows, approvals and documents already point at `quotes.id`, so a version-per-row model needed no data moves. `quotes.version` stays the optimistic-concurrency counter.
- States: `draft → approved → sent → accepted | rejected | expired | superseded`, plus `draft → rejected` (owner) and `approved → superseded`. `approved` is the owner's internal approval and the only state that can be sent. `decision_source` (`owner | customer`) distinguishes owner rejection from customer decline. The state machine is `packages/core/src/quote-document.ts`; CHECK constraints enforce the timestamps that each state requires.
- Lines store `quantity_milli`, `kind`, `tax_code`, `price_source`, `cost_cents`, `markup_bp`, `discount_bp`, gross, discount and signed amount. CHECK constraints recompute gross, discount, cost-plus-markup sell price and amount with PostgreSQL `round()` (half away from zero), matching `packages/core/src/pricing.ts`. `owner_entered` requires `entered_by` and nothing else may carry it. Old rows were migrated (`quantity_milli = quantity × 1000`, kind from unit); `quantity` is kept, null for fractional quantities.
- Quotes persist subtotal, GST, total and a per-tax-code breakdown (`tax_breakdown`) plus a snapshot of `gst_registered`, `prices_entered` and the rate. Every write path (assistant draft, owner edit, revision) goes through one service (`apps/api/src/services/quotes.ts`) that calls the core engine. Clients never send totals; request schemas are strict.
- Business settings: `gst_registered`, `gst_number` (digits only; the API validates the IRD mod-11 check digit with primary and secondary weights), `prices_entered`, `quote_validity_days`, `default_material_markup_bp`.

**Who may set a price.** Approved-rate lines take the current rate card price. Material lines use recorded cost × markup. `owner_entered` prices are accepted only on owner-authenticated routes and stamped with the session user id. The enquiry (agent) route has no price fields; agent proposals still carry only rate codes and quantities.

**Sending** (`POST /api/quotes/:id/send`, owner, idempotent). In one transaction: render the PDF with `packages/documents` and store it via `FileStore` as a `quote_pdf` document; issue a 32-byte random token whose SHA-256 alone is stored in `quote_acceptance_tokens` (expiry = end of `valid_until` in the business time zone); record an outbound `communications` row with status `draft` containing the link; mark the quote `sent`; enqueue a `quote.expire` task for the expiry instant; audit and add a timeline event. **No email is sent.** The owner copies the link or sends the draft themselves. Sending is refused if GST settings changed since the quote was priced (`QUOTE_TAX_SETTINGS_CHANGED`) or a registered business has no GST number. A repeat send of a sent quote returns the same link; the same Idempotency-Key replays the stored response.

The PDF does not contain the link: a stored file should not be a credential. The plaintext link exists only in the outbound message draft (that is the message the customer receives) and in the idempotency replay record; the token table holds the hash only.

**Customer acceptance** (`/api/public/quotes/:token`, plus `/pdf`, `/accept`, `/decline`). No session. Lookup is by SHA-256 within this runtime's tenant only, followed by a constant-time comparison. Routes are rate limited (30 GET / 10 POST per minute per client) and stay under `/api/`, so the global Origin = `APP_ORIGIN` check applies to the POSTs. Unknown link → 404; superseded or revoked → 410 `QUOTE_SUPERSEDED`; lapsed → the quote is expired (committed) and 410 `QUOTE_EXPIRED`; already decided or token used → 409. A decision writes the quote state, marks the token used, inserts an append-only `quote_decisions` row (typed name as signature, optional comment, quote number, revision, total, PDF SHA-256), an audit event with actor type `customer`, and a timeline event. Nothing else identifying is stored: no IP address or device fingerprint, and the name and comment are not copied into audit metadata. The PWA serves the customer page at `/q/<token>`.

**Revision** (`POST /api/quotes/:id/revise`, owner). Allowed for `approved` and `sent` quotes. Creates revision n + 1 as a draft (approved-rate lines re-priced from the current card; a deactivated rate becomes an open question that blocks approval), supersedes the old version and revokes its link. Drafts are edited in place instead.

**Expiry.** The `quote.expire` queue task and a check on every public read or decision mark sent quotes past their validity as `expired` with a system audit event and timeline entry. If no worker runs, owner screens can show `sent` for a lapsed quote until the customer link is opened or the worker catches up.

## Consequences

- Real email or SMS delivery is Planned; until then "sent" means "link issued and message drafted".
- The job is moved `new → quoted` on send when applicable; scheduling after acceptance is left to the scheduling module.
- Any future change to pricing rules must update both `packages/core/src/pricing.ts` and the `0005` CHECK expressions via a new migration.
- Public routes are a new attack surface: covered by tests for wrong, malformed, other-tenant, replayed, expired and superseded tokens and missing Origin (`tests/integration/quotes-acceptance.test.ts`).
