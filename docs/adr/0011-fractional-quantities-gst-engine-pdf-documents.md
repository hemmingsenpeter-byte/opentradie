# ADR 0011: Fractional quantities, NZ GST engine and PDF documents

- Status: Accepted
- Date: 2026-10-19

## Context

ADR 0007 fixed integer cents and whole-number quantities with one tax rate on the subtotal. Tradies bill fractional hours (1.5 h), sell materials at cost plus markup, apply discounts, may or may not be GST-registered, may enter prices GST-inclusive, and must issue New Zealand taxable supply information (TSI) under the rules in force since 1 April 2023. Quotes are revised and must stay reproducible.

## Decision

- Quantities are fixed-point thousandths (`quantityMilli`, 1.5 h = 1500). Line amount = round-half-away-from-zero(quantityMilli × unit price / 1000), computed with BigInt and checked into ±NZD 10 billion. Money stays integer cents; no money library.
- Line kinds `labour | material | fee | discount`. Discount lines are explicit and negative; line discounts are basis points. Material may be priced at cost × (10000 + markup) / 10000, rounded half away from zero.
- Every line records its price source: `approved_rate`, `cost_plus_markup` or `owner_entered`. `owner_entered` carries the owner's user ID and must only be set by the API from an authenticated owner session; agent proposals still carry no prices.
- GST (`packages/core/src/tax.ts`): per-business `gstRegistered`, `pricesEntered: exclusive | inclusive`, configurable standard rate (default 1500 bp) and per-line `standard | zero_rated | exempt`. GST is computed once per tax-code group (exclusive: round(net × r / 10000); inclusive: round(gross × r / (10000 + r))). The invariant total = subtotal + GST is asserted. Not registered → no GST anywhere.
- Quote documents are versioned with states `draft → sent | superseded`, `sent → accepted | rejected | expired | superseded`; the rest are terminal. Revising creates version n + 1 and supersedes the previous one. Validity is a calendar date in the business time zone (default Pacific/Auckland).
- `taxableSupplyInformationRequirements` encodes the IRD TSI tiers ($200 / $1,000, GST-inclusive). Only a GST-registered business's invoice is titled "Tax invoice"; quotes are titled "Quote".
- PDFs are rendered by a new `packages/documents` workspace with `@react-pdf/renderer` 4.9.0 (MIT; transitive dependencies MIT, ISC or Apache-2.0), base-14 Helvetica only (no network font fetches). The renderer refuses an invoice whose TSI check fails.

## Consequences

- `calculateQuote` keeps its API and results for whole quantities but totals through the new engine.
- The database still stores whole-number quantities and a single quote status set; persistence of `quantityMilli`, line kinds, price sources, tax codes, versions and the new states needs a new migration (planned as `0005`) and API wiring. Until then the new engine and documents are Implemented and tested as pure code only.
- Exclusive and inclusive entry can differ by one cent for the same economic price; this is documented and tested.
- TSI rules are encoded from public IRD guidance and are not tax advice.
