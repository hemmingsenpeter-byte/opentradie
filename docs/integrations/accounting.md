# Accounting integration

Code: `packages/integrations/src/accounting` (`@opentradie/integrations`), PostgreSQL stores and worker handlers in `packages/platform/src/accounting`, routes in `apps/api/src/routes/{invoices,accounting}.ts`. Decision records: [ADR 0020](../adr/0020-accounting-adapter-contract.md), [ADR 0023](../adr/0023-invoices-outbox-and-xero-sync.md).

## Status

| Component                                                                                | Status                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AccountingAdapter` contract and shared contract test suite                              | Implemented and tested (`contract.test.ts` runs the same suite against both adapters below)                                                                                                                                                                                                                                                                                                                                   |
| `XeroAccountingAdapter` (official `xero-node` SDK, `20.0.0`)                             | **Implemented, not integration-tested.** Tested with a fake SDK, and with the real SDK pointed at a local HTTP server (`xero-sdk-wire.test.ts`). It has never called Xero. Nothing here is evidence that the Xero connection works                                                                                                                                                                                            |
| `FakeAccountingAdapter`                                                                  | Mock for CI and demos. Never evidence of a real integration                                                                                                                                                                                                                                                                                                                                                                   |
| Credential envelope and `EncryptedTokenStore`                                            | Implemented and tested; stored in `provider_connections` through the PostgreSQL `ConnectionStore`, with token refresh under a row lock (`refreshExclusive`)                                                                                                                                                                                                                                                                   |
| `AccountingSyncService` (contact mapping, then draft invoice)                            | Implemented and tested; driven by the `accounting.post_invoice` worker job through the outbox (ADR 0023)                                                                                                                                                                                                                                                                                                                      |
| Fake ledger storage                                                                      | **Implemented and tested.** With `ACCOUNTING_PROVIDER=fake` the mock ledger is PostgreSQL-backed (`fake_accounting_*`, migration 0018, ADR 0029) so the API and a separate worker (`RUN_WORKER=false`) share it (`tests/integration/invoices-accounting.test.ts`, `fake-ledger-contract.test.ts`). Demo and test only; still a mock, not evidence of a real integration. Unit and contract tests can use the in-memory ledger |
| Posting, recovery and reconciliation (`accounting.post_invoice`, `accounting.reconcile`) | Implemented and tested with the fake adapter only (`tests/integration/invoices-accounting.test.ts`)                                                                                                                                                                                                                                                                                                                           |
| Xero OAuth routes (`/api/integrations/xero/*`) and owner UI (Settings › Accounting)      | **Implemented, not integration-tested**: exercised end to end with the fake adapter (`tests/e2e/invoicing.spec.ts`); the Xero consent screen, code exchange and refresh have never been run                                                                                                                                                                                                                                   |

## Authority and sync direction

- **Xero is the authoritative ledger.** It owns the invoice number it assigns, the tax it calculates, the posted invoice, payments and the amount due.
- **OPENTRADIE owns the operational invoice** (built from approved quote lines and owner-approved rates) and its sync status.
- **Outbound (OPENTRADIE to Xero):** contacts and **draft** invoices only. OPENTRADIE never authorises, emails or posts an invoice in Xero. The owner reviews and approves the draft in Xero.
- **Inbound (Xero to OPENTRADIE):** invoice status, amount due, amount paid and payments, read with `listInvoiceChangesSince` and `listPaymentsSince` (Xero `If-Modified-Since`). OPENTRADIE stores the provider figures and never recalculates them.
- **Withdrawal:** `voidDraftInvoice` deletes an invoice only while it is still `DRAFT` or `SUBMITTED` (Xero status `DELETED`). An authorised invoice is refused with `ConflictError`, because voiding a posted invoice is an owner action in Xero.

## Contract

`AccountingAdapter` in `types.ts`:

- `beginAuthorisation`: returns the authorize URL, `state`, and a PKCE `codeVerifier` (S256). Store `state` and `codeVerifier` server-side, bound to the owner's session. Never send the verifier to the browser.
- `completeAuthorisation`: exchanges the code and stores the tokens through a `TokenStore`.
- `refreshTokens` refreshes on demand. `listOrganisations` and `listTaxRates` support setup.
- `upsertContact`: uses our customer id, which Xero stores as `ContactNumber`, and the known external contact id from `ExternalReferenceStore`.
- `createDraftInvoice`: lines carry `description`, `quantityMilli` (integer thousandths), `unitAmountCents`, `accountCode` and `taxCode` (`standard`, `zero_rated` or `exempt`). The line amount mode is `exclusive`, `inclusive` or `no_tax`.
- `getInvoice`, `listInvoiceChangesSince`, `listPaymentsSince`, `voidDraftInvoice`.

**Money:** amounts cross the contract only as integer cents and quantities only as integer thousandths. Conversion to Xero's decimals happens inside the adapter (`decimal.ts`) with bigint and string formatting. `xero-node` requires JS numbers, so each value is produced from its exact decimal string and checked to serialise back to the same decimal. Values that fail the check are rejected, not rounded. Amounts read back from Xero are parsed from their decimal form into cents.

**Tax mapping:** `XeroTaxTypeMap` maps our tax codes to the organisation's Xero tax types. Presets `XERO_TAX_PRESETS.NZ` (`OUTPUT2`, `ZERORATED`, `NONE`) and `.AU` (`OUTPUT`, `EXEMPTOUTPUT`, `INPUTTAXED`) are only starting points: the NZ `ZERORATED` code could not be re-verified against Xero's documentation. During setup the owner must confirm the mapping against `listTaxRates` (Xero `GET /TaxRates`) for their organisation.

**Invoice mapping:** `Type=ACCREC`, `Status=DRAFT`, `LineAmountTypes` set to `Exclusive`, `Inclusive` or `NoTax`, `Reference` set to our invoice number. Xero returns the `InvoiceID`, which the caller stores through `ExternalReferenceStore`. Xero assigns its own `InvoiceNumber`.

## Idempotency

- Every write takes an `idempotencyKey` (1 to 128 characters of `[A-Za-z0-9_.:-]`). The Xero adapter passes it to the SDK's `idempotencyKey` parameter, which sends the `Idempotency-Key` header (checked on the wire in `xero-sdk-wire.test.ts`).
- `deriveIdempotencyKey(tenant, operation, entity, revision)` is deterministic, so a retry after a crash or timeout reuses the same key. `AccountingSyncService` derives its keys this way.
- Xero keeps idempotency keys only for a limited period, which we have not verified. For that reason the sync service also checks `ExternalReferenceStore` before creating, and callers should persist the provider id in the same transaction as the sync status.
- The fake adapter rejects reuse of a key with a different payload (`ConflictError`, code `idempotency_key_reuse`). We have not verified what Xero does in that case.

## Failure modes (normalised errors, `errors.ts`)

| Error                          | When                                                                                               | Caller action                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `AuthExpiredError`             | HTTP 401                                                                                           | Refresh once and retry                                       |
| `ReauthorisationRequiredError` | No connection; refresh token rejected (`invalid_grant`); HTTP 403                                  | Mark the connection `error` and ask the owner to reconnect   |
| `RateLimitedError`             | HTTP 429. `retryAfterSeconds` from `Retry-After`, default 60. Code includes `X-Rate-Limit-Problem` | Retry after the delay, with the same idempotency key         |
| `ValidationError`              | Our pre-flight validation, Xero `ValidationException` (400), or a rejected authorization code      | Do not retry. Show `issues` to the owner, but never log them |
| `ConflictError`                | Duplicate (e.g. contact name already used), 409/412, voiding a non-draft                           | Do not retry. Needs an owner decision                        |
| `TransientError`               | Network failure, timeout, 5xx                                                                      | Retry with backoff, with the same idempotency key            |
| `PermanentError`               | 404 (`not_found`), malformed response, other 4xx                                                   | Do not retry                                                 |

Error messages are written by us and never include tokens, request bodies or provider response bodies. Xero validation messages can contain business data, such as a contact name, so they are kept only in `issues`.

## Conflict policy

- Ledger figures (status, totals, tax, amount due, payments) always win. OPENTRADIE displays them and never overwrites them.
- After a draft is pushed, OPENTRADIE does not edit it in Xero. If the operational invoice changes, the caller withdraws the draft (only while it is still a draft) and pushes a new revision with a new idempotency key. If the draft is already authorised, the owner resolves the difference in Xero.
- Duplicate contact names surface as `ConflictError` for the owner to resolve. The adapter never merges contacts.

## Tokens and credentials

- Xero access tokens last about 30 minutes. The adapter refreshes 2 minutes before expiry. Xero refresh tokens rotate on every use, so concurrent refreshes within a process collapse into one (`SingleFlight`), and across processes the PostgreSQL `ConnectionStore` holds `SELECT ... FOR UPDATE` on the connection row while refreshing: a waiting worker re-reads and uses the rotated tokens instead of spending the refresh token again (tested in `tests/integration/invoices-accounting.test.ts`).
- Tokens are sealed with AES-256-GCM (`credentials/envelope.ts`). The envelope is versioned (`0x01 | IV | tag | ciphertext`). The additional authenticated data (AAD) binds tenant id, provider and key id. The ciphertext goes in `provider_connections.encrypted_credentials` and the key id in `encryption_key_id`.
- Keys: `CREDENTIAL_ENCRYPTION_KEY` is the active key (64 hex characters) and `CREDENTIAL_ENCRYPTION_KEY_ID` its id (default `k1`). `CREDENTIAL_ENCRYPTION_RETIRED_KEYS` (`id:hex,...`) keeps old keys so existing rows can still be decrypted. Rows sealed with a retired key are re-encrypted with the active key on their next read.
- Tokens, codes and verifiers are never logged.

## Configuration

| Variable                                                                                          | Meaning                                                                                             |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ACCOUNTING_PROVIDER`                                                                             | `none` (default), `xero`, or `fake` (MOCK for demos and CI)                                         |
| `ACCOUNTING_ALLOW_FAKE`                                                                           | must be `true` to use `fake`; `fake` is refused in the cloud profile and with `NODE_ENV=production` |
| `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`                                                            | from the Xero app; required for `xero`. Never commit them                                           |
| `XERO_REDIRECT_URI`                                                                               | HTTPS (HTTP only on loopback), path `/api/integrations/xero/callback`                               |
| `XERO_TAX_PRESET`                                                                                 | `NZ` (default) or `AU`; confirm against `listTaxRates` before go-live                               |
| `XERO_PKCE`                                                                                       | `true` (default); set `false` if Xero's web-app flow rejects PKCE (unverified)                      |
| `CREDENTIAL_ENCRYPTION_KEY`, `CREDENTIAL_ENCRYPTION_KEY_ID`, `CREDENTIAL_ENCRYPTION_RETIRED_KEYS` | required with any accounting provider; see Tokens and credentials                                   |

The business setting `accounting_sales_account_code` (default `200`, Xero NZ "Sales") is the account code on posted lines; `payment_terms_days` (default 20) sets invoice due dates.

## Posting flow (ADR 0023)

1. The owner approves an invoice. The same transaction stores the PDF and an `event_outbox` row (`accounting.post_invoice`).
2. The worker loop dispatches the row into the job queue (task idempotency key `outbox:<id>`).
3. The handler looks for an existing ledger invoice (stored reference, then the provider `Reference` = our invoice number) and only then creates the contact and draft with idempotency keys derived from the invoice id and version.
4. Success stores the external id and moves the invoice to `posted`; failures move it to `sync_failed` with the reason (reconnect, validation issues, etc.) or reschedule it (rate limit, transient). The owner can retry from the invoice or Settings.
5. `accounting.reconcile` (hourly while invoices are open, or "Sync now") reads status and payments into `payment_snapshots` and sets `part_paid` or `paid`.

## Setup and live verification (not yet performed)

1. Create an app at the Xero developer portal (developer.xero.com, "My Apps"), type **Web app**. Set the redirect URI to the deployment's callback URL exactly, e.g. `https://<APP_ORIGIN>/api/integrations/xero/callback`, and set the same value in `XERO_REDIRECT_URI`.
2. Scopes: Xero now uses granular scopes. Apps created on or after 2 March 2026 can request only these, and they are available from April 2026. Default `XERO_GRANULAR_SCOPES`: `offline_access accounting.contacts accounting.invoices accounting.payments.read accounting.settings.read`. Apps created before that date may use `XERO_LEGACY_SCOPES` (`offline_access accounting.transactions accounting.contacts accounting.settings.read`) until Xero retires the broad scopes (announced for September 2027). Check the current names on Xero's scopes page before go-live. They come from Xero's developer blog post "Upcoming changes to Xero Accounting API scopes", because Xero's documentation site could not be reached from this environment.
3. PKCE is sent by default (`code_challenge_method=S256`). We have not verified whether Xero's web-app flow accepts PKCE together with the client secret. If Xero rejects it, construct `XeroOAuthClient` with `pkce: false`.
4. Connect the **Demo Company (NZ)** organisation, which you can create or reset from the Xero developer portal.
5. Verify, and record the results before changing any status label:
   - The authorize URL and code exchange succeed, `listOrganisations` returns the demo company, and the granted scopes match.
   - `listTaxRates` returns the NZ tax types. Confirm the mapping (`OUTPUT2`, `ZERORATED`, `NONE`).
   - `upsertContact`, then `createDraftInvoice` with fractional quantities (e.g. `quantityMilli` 1500) and each tax code. The draft appears in Xero with the expected totals, and `Reference` holds our invoice number.
   - Repeating `createDraftInvoice` with the same idempotency key creates no second draft.
   - Approve the draft in Xero and record a payment. `getInvoice` and `listPaymentsSince` show it.
   - `voidDraftInvoice` deletes a draft and refuses an authorised invoice.
   - Expire the access token by waiting 30 minutes or clearing it. The adapter refreshes, and revoking the connection gives `ReauthorisationRequiredError`.
   - Through OPENTRADIE itself: Settings › Accounting › Connect Xero completes the consent and returns to Settings as connected (choose the organisation if several were authorised); approve an invoice and confirm it appears in Xero as a draft with `Reference` = the OPENTRADIE invoice number, exactly once even after "Retry sync"; approve and pay it in Xero, then "Sync now" shows it paid; revoke the app in Xero and confirm the next post shows "reconnect" and the connection shows `error`.
6. Only after recording those results may the Xero adapter's status move to "Implemented and tested".
