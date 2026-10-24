# ADR 0030: Tenant provisioning and rate-card management

Status: Accepted (2026-10-24)

## Context

A real tradie business could not be set up without editing the database: `pnpm db:seed` only creates the synthetic demo electrician, and the API exposed the rate card read-only (`GET /api/rates`). Every price must come from an owner-approved rate (AGENTS.md), so the owner needs to manage those rates themselves.

## Decision

- **Provisioning CLI** `pnpm provision:tenant` (`scripts/provision-tenant.ts`, logic in `packages/database/src/provision.ts`). It is also bundled by tsup to `dist/scripts/provision-tenant.js` so the production image can run it with `node`. It validates everything before writing: business name and trade, owner email, GST number (IRD check digit, `packages/core/src/nz-gst-number.ts`), and the rates CSV. Then it creates the business, the owner user (password hashed with the same scrypt `hashPassword` the login route verifies against) and the rates (`approved_by` = the owner) with audit events, in one transaction. No demo customers.
  - The owner password is read from `OWNER_PASSWORD_FILE` or prompted for twice on a TTY with no echo. There is no password option, so it never reaches shell history or the process list. Minimum 12 characters.
  - Tenant id: `--tenant-id`, else `TENANT_ID` from the environment, else generated. The command prints it and tells the operator to set `TENANT_ID`. The API only serves that tenant.
  - Re-running for an existing tenant prints "already provisioned" and changes nothing. It refuses a database holding another real business (one business per installation), and a database holding the demo seed unless `--allow-alongside-demo` is passed. `--dry-run` validates and prints the plan without writing.
- **One CSV validator** (`packages/core/src/rate-card.ts`), shared by provisioning and `POST /api/rates/import`. It reads the template's columns `code, description, unit` plus one price column: `price_excl_gst_nzd`, `price_incl_gst_nzd` or `price_nzd`. A sheet whose GST basis contradicts the business's price-entry mode is rejected. Prices like `$1,234.50`, `85` or `85.5` are parsed to integer cents with string arithmetic (no floats). Negative, malformed, more than two decimals and over $10,000,000.00 are rejected. Units are `each`, `hour` or `visit` and codes follow `rateCodeSchema`. Duplicate codes are rejected. Every problem is reported with its line number, and nothing is usable unless the whole file is valid.
- **Rate history** (migration `0019`): `approved_rates` keeps one current row per code, because quote lines reference `(tenant_id, code)`, and gains `retired_at` and `updated_at`. `approved_rate_history` records every version (created, updated, retired, reactivated, imported) with its effective time and approver. Existing rates are backfilled with a `created` version. This was chosen over effective-dated rate rows because quote and invoice lines already store their own `unit_price_cents` snapshot, so past documents keep the price they were issued with. Re-pricing happens only when the owner edits or revises a draft.
- **Owner-only, audited, idempotent API** (`apps/api/src/routes/rates.ts`):
  - `POST /api/rates`
  - `PATCH /api/rates/:code` (label, unit, price)
  - `POST /api/rates/:code/retire|reactivate`
  - `GET /api/rates?includeRetired=true`
  - `GET /api/rates/:code/history`
  - `POST /api/rates/import` (`mode: preview|apply`; the diff lists creates, updates, unchanged codes, codes missing from the file, which are never retired automatically, and retired codes present in the file, which stay retired)
  - `GET /api/rates/export.csv`

  Prices are sent as text and parsed on the server. Retiring sets `active=false`. Existing loaders already filter on `active`, so a retired rate is rejected on new quote lines (`UNKNOWN_RATE`) and in agent `quote.prepare` proposals (`RATE_NOT_APPROVED`), while existing documents are unaffected. The agent `rates.list` tool still returns codes, labels and units only, never prices.

- **PWA**: Settings › Price list (`#/settings/rates`) shows the table, the add/edit dialog, retire/reactivate, a price-history dialog, CSV import with a preview diff and confirm, and CSV export. Viewers see it read-only.

## Consequences

- An operator can install for a real customer without SQL, and the owner keeps their own prices current.
- Account security (password change/reset, MFA, set-password links) is out of scope and remains a blocker for paying customers (docs/customer-install/README.md).
- Running the bundled CLI inside the published Docker image has not been verified. The bundle was built and run against PostgreSQL locally.
