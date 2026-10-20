# ADR 0025: Per-customer export and erasure

- Status: Accepted (Feature 12; prompt #2 §8 "Data export and deletion mechanisms"). Builds on [ADR 0017](0017-job-lifecycle-and-append-only-timeline.md) (append-only timeline and the business export).
- Date: 2026-10-20

## Context

The business owner must be able to answer a customer's request for a copy of their data and a request to delete it (New Zealand Privacy Act 2020, information privacy principles 6 and 7, and similar rights elsewhere). The whole-business export (ADR 0017) already walks tables with a secret-column filter. Some records cannot simply be deleted: invoices and quotes that were sent, accepted or posted are tax records, and `job_events` and `quote_decisions` are append-only by trigger.

## Decision

1. **Scope.** One SQL scope per table (`CUSTOMER_SCOPE` in `apps/api/src/services/customer-privacy.ts`) finds every row that belongs to a customer: by `customer_id`, through the customer's jobs, quotes, invoices, threads, communications and voice notes. Export and erasure use the same scope, and every query is also constrained to the session tenant.
2. **Export.** `GET /api/customers/:id/export` (owner, audited as `customer.exported` with counts only) returns `opentradie-customer-export` format version 1 via the same table walker as the business export (`dumpTables`), so the same columns are never exported (password hashes, tokens, credentials, key ids, search vectors). `quote_acceptance_tokens`, audit events and accounting sync attempts are not included. File contents are **not** embedded and there is no zip option: no permissive zip library is in the dependency tree, so documents are metadata plus `sha256`. Another tenant's customer is 404.
3. **Erasure.** `POST /api/customers/:id/erase {confirmName}` (owner, idempotent, audited as `customer.erased` with counts only) requires the customer's current name typed exactly (422 `CONFIRMATION_MISMATCH` otherwise). In one transaction it:
   - pseudonymises the customer (`Erased customer <first 8 of id>`, preferred name, email, phone and address nulled, archived, `erased_at` set) and deletes their contacts;
   - replaces property address line 1 with `[erased]` and nulls the other address fields, label and access notes;
   - redacts job titles (`Erased job`), descriptions and site addresses; job note text; appointment title, notes, location and cancel reason; reminder payloads; action proposal summaries, payloads and reasons;
   - replaces message bodies with `[erased]` and nulls subjects, senders, addresses, threading headers and triage; nulls thread subjects;
   - deletes knowledge items (and embeddings where pgvector exists) derived from the customer;
   - clears voice transcripts, corrections, segments and clarifications;
   - renames erased documents (photos, attachments, voice audio, email attachments) to `[erased]` and, **after commit**, deletes their bytes from the `FileStore` (a rolled-back erasure never loses files);
   - nulls invoice notes and redacts `quote_decisions.signer_name` (to `[erased]`) and `comment`.
     Re-running on an erased customer returns `alreadyErased: true` and changes nothing.
4. **Retained financial records.** Quotes, quote lines, invoices, invoice lines, payment snapshots, external references and quote/invoice PDFs are kept, linked to the pseudonymised customer, with amounts unchanged. **Assumption to confirm with an accountant:** NZ tax law requires business records to be kept for 7 years (Tax Administration Act 1994 s 22, GST Act); we keep these for the life of the installation and do not yet purge them after 7 years. Line descriptions are kept as written and the stored quote/invoice PDFs still show the customer's name as issued; this is deliberate (the issued tax document) and is stated in the privacy notice.
5. **Append-only tables (migration `0012_customer_erasure.sql`).** The `job_events` and `quote_decisions` triggers still refuse DELETE and every UPDATE, except an UPDATE made in a transaction with `opentradie.erasure = 'on'` (set with `set_config(..., true)`, i.e. transaction-local) that changes only the redacted columns, and only to the fixed redaction values (`summary` = "Details erased at the customer's request" and `metadata` = `{"erased": true}`; `signer_name` = `[erased]` and `comment` NULL). Tests check that ordinary updates, deletes and arbitrary updates under the flag still fail.
6. **Drafts are redacted, not deleted.** Deleting draft quotes and invoices would need cascading deletes through approvals, lines, events and proposals; redaction gives the same privacy result with less risk. Revisit if owners ask for it.
7. **PWA.** The customer screen has a Privacy section (owner only) with "Export customer data" (download) and "Erase customer" (dialog; the button stays disabled until the name is typed).

## Consequences

- Audit rows and the idempotency record keep identifiers and counts only. The idempotency record stores a SHA-256 of the request body, which includes the typed name; it expires with the other idempotency records.
- Backups taken before the erasure still contain the data until they rotate out; the privacy notice must say so.
- Other systems are not reached: an invoice already posted to Xero, or an email already sent, keeps the customer's details there.
- Not built: export of file bytes (zip), scheduled purge after the retention period, and erasure requests from the customer themself (the owner acts on them).
