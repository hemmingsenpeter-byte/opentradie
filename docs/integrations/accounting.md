# Accounting integration

Code: `packages/integrations/src/accounting` (`@opentradie/integrations`). Decision record: [ADR 0020](../adr/0020-accounting-adapter-contract.md).

## Status

| Component                                                     | Status                                                                                                                                                                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AccountingAdapter` contract and shared contract test suite   | Implemented and tested (`contract.test.ts` runs the same suite against both adapters below)                                                                                                                                        |
| `XeroAccountingAdapter` (official `xero-node` SDK, `20.0.0`)  | **Implemented, not integration-tested.** Tested with a fake SDK, and with the real SDK pointed at a local HTTP server (`xero-sdk-wire.test.ts`). It has never called Xero. Nothing here is evidence that the Xero connection works |
| `FakeAccountingAdapter`                                       | Mock for CI and demos. Never evidence of a real integration                                                                                                                                                                        |
| Credential envelope and `EncryptedTokenStore`                 | Implemented and tested with in-memory stores. Not wired to `provider_connections` in PostgreSQL yet                                                                                                                                |
| `AccountingSyncService` (contact mapping, then draft invoice) | Implemented and tested against the fake adapter. Not wired to API routes or the job queue yet                                                                                                                                      |
| API routes, worker jobs, owner UI for connecting Xero         | Planned                                                                                                                                                                                                                            |

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

- Xero access tokens last about 30 minutes. The adapter refreshes 2 minutes before expiry. Xero refresh tokens rotate on every use, so concurrent refreshes within a process collapse into one (`SingleFlight`). A multi-process deployment also needs a row lock (`SELECT ... FOR UPDATE`) in the PostgreSQL `ConnectionStore`.
- Tokens are sealed with AES-256-GCM (`credentials/envelope.ts`). The envelope is versioned (`0x01 | IV | tag | ciphertext`). The additional authenticated data (AAD) binds tenant id, provider and key id. The ciphertext goes in `provider_connections.encrypted_credentials` and the key id in `encryption_key_id`.
- Keys: `CREDENTIAL_ENCRYPTION_KEY` is the active key (64 hex characters) and `CREDENTIAL_ENCRYPTION_KEY_ID` its id (default `k1`). `CREDENTIAL_ENCRYPTION_RETIRED_KEYS` (`id:hex,...`) keeps old keys so existing rows can still be decrypted. Rows sealed with a retired key are re-encrypted with the active key on their next read.
- Tokens, codes and verifiers are never logged.

## Setup and live verification (not yet performed)

1. Create an app at the Xero developer portal (developer.xero.com, "My Apps"), type **Web app**. Set the redirect URI to the deployment's callback URL exactly, e.g. `https://<APP_ORIGIN>/integrations/xero/callback` (the route is Planned).
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
6. Only after recording those results may the Xero adapter's status move to "Implemented and tested".
