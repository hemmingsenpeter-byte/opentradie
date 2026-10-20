# ADR 0026: One OAuth connection flow for accounting and mail

Status: Accepted (2026-10-20). Amends [ADR 0022](0022-unified-inbox-and-email-ingestion.md) and reuses [ADR 0023](0023-invoices-outbox-and-xero-sync.md)'s token storage.

## Context

Approved email replies failed with `NO_MAIL_CONNECTION` because nothing could connect a mailbox: the Gmail and Microsoft Graph adapters existed, but only Xero had an OAuth connect route, a hashed state table and a sealed token store. Copying that code for two more providers would have left three diverging copies of security-sensitive logic.

## Decision

- `OAuthCodeClient` (`packages/integrations/src/oauth/code-client.ts`) is the single authorization-code + PKCE client. `XeroOAuthClient` is now a thin configuration of it; `createGmailOAuthClient` and `createMicrosoftMailOAuthClient` configure Google and the Microsoft identity platform (client secret in the form body, `access_type=offline` for Google, scopes on refresh for Microsoft). A refresh response without a new refresh token keeps the old one (Google does not rotate).
- `apps/api/src/routes/oauth-flow.ts` holds the shared state handling (`storeAuthorisation`, `claimAuthorisation`): SHA-256 of the state only, the PKCE verifier sealed under its own AAD purpose, single-use, 10-minute expiry, bound to provider. The Xero and mail routes both use it.
- Mail tokens use the same `provider_connections` row format and `EncryptedTokenStore` as Xero. `storedAccessToken` refreshes under `refreshExclusive` (SELECT ... FOR UPDATE) and, on `invalid_grant`, marks the connection `error / reauthorisation_required`.
- `MAIL_PROVIDER=none|gmail|microsoft_graph|fake` selects one mailbox provider per installation. `fake` (stored as `fake_mail`, migration 0013) is a MOCK gated like `ACCOUNTING_PROVIDER=fake`.
- `inbox.send` resolves the provider from the stored connection. At-most-once is unchanged (the row is `sending` before any provider call, including a token refresh). A refused refresh or an errored connection fails the message with `MAIL_REAUTHORISATION_REQUIRED`; it is never resent automatically.

## Consequences

- Live Gmail and Microsoft 365 have not been connected: status is Implemented, not integration-tested.
- Mailbox sync (`listChanges`) and Gmail watch renewal still need scheduling (Planned).
- The connection is per installation; the callback trusts `TENANT_ID` exactly like the Xero callback.
