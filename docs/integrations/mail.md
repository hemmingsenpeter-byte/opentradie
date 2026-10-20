# Email (Gmail, Microsoft 365) and messaging

Status: the inbox pipeline, the signed inbound endpoint, the paste route and send-after-approval are **Implemented and tested** with `FakeMailAdapter`, the mock agent and real PostgreSQL (`tests/integration/inbox.test.ts`, `tests/security/inbox-injection.test.ts`, `tests/e2e/inbox.spec.ts`). `GmailMailAdapter` and `MicrosoftGraphMailAdapter` are **Implemented, not integration-tested**: they have only run against a fake HTTP layer (`packages/integrations/src/mail/mail.test.ts`). Connecting a mailbox (Settings › Mail, `MAIL_PROVIDER=gmail|microsoft_graph`) is **Implemented, not integration-tested**: the OAuth connect/callback/status/disconnect routes, sealed token storage in `provider_connections`, refresh under a row lock and the stored-connection send path are tested only against injected fake Google, Microsoft and Gmail/Graph HTTP (`tests/integration/mail-connections.test.ts`); no live Gmail or Microsoft 365 account has been connected. `MAIL_PROVIDER=fake` is a MOCK mailbox (needs `MAIL_ALLOW_FAKE=true`; refused in the cloud profile and with `NODE_ENV=production`) and Settings labels it as such. The OAuth flow is shared with Xero ([ADR 0026](../adr/0026-shared-oauth-connection-flow.md)). WhatsApp is **Planned**. Decision record: [ADR 0022](../adr/0022-unified-inbox-and-email-ingestion.md).

## Authority and sync direction

| Data                              | Authority                        | Direction                                                        |
| --------------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| Message records, threads, links   | OPENTRADIE (PostgreSQL)          | Provider to OPENTRADIE (inbound copy); never written back        |
| Mailbox contents, folders, labels | The mail provider                | Not changed by OPENTRADIE (read scope only)                      |
| Outbound replies                  | OPENTRADIE draft, owner approval | OPENTRADIE to provider, once, after approval                     |
| Delivery identifiers              | Provider (message id, thread id) | Recorded on the message; never used to delete or rewrite records |

Conflict policy: OPENTRADIE never deletes or edits a message because the mailbox changed. A message deleted in Gmail stays in OPENTRADIE. The same message arriving twice (webhook retry, two sync paths, the owner pasting it) is stored once, keyed by `Message-ID`. Customer and job links are made only on exact email address matches or by the owner; anything ambiguous is flagged for review.

## Inbound paths

1. **Signed webhook** `POST /inbound/email/:provider` (`gmail`, `microsoft_graph`, `generic_mime`), enabled by setting `INBOUND_EMAIL_SECRET` (32+ characters, per installation). Body: `{"version":1,"eventId":"…","rawMimeBase64":"…","providerMessageId":"…?","providerThreadId":"…?"}`. Header `x-opentradie-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`, same scheme as the relay ([RELAY.md](../RELAY.md)); constant-time comparison; requests more than 5 minutes old or ahead are refused (401) before anything is written. Duplicate event ids return 200 `duplicate`; the same id with different content returns 409. Any forwarder (a relay, a mail service's inbound webhook bridge, a Gmail Pub/Sub subscriber that fetches `format=raw`) can use it.
2. **Paste or forward** `POST /api/inbox/paste` (owner): fields or raw source; same pipeline. Used for demos and for mail from accounts that are not connected.
3. **Provider sync** (`MailProvider.listChanges` + `fetchMessage`): implemented in both adapters, **not scheduled** yet (Planned); the stored connection is used only for sending approved replies today.

## Routes

`GET /api/integrations/mail/status` (owner or viewer: configured provider, `mock`, connection status), `GET /api/integrations/mail/:provider/status`, `GET /api/integrations/mail/:provider/connect` (owner, 10 per minute: returns the authorize URL), `GET /api/integrations/mail/:provider/callback` (public redirect target bound by the hashed, single-use, 10-minute state; redirects to `/#/settings?mail=connected|denied|invalid_state|failed`) and `POST /api/integrations/mail/:provider/disconnect` (owner, idempotent: deletes the sealed tokens). `:provider` is `gmail`, `microsoft_graph` or `fake`; a provider other than `MAIL_PROVIDER` answers 409 `MAIL_PROVIDER_NOT_CONFIGURED`. Tokens are sealed with `CREDENTIAL_ENCRYPTION_KEY` (AES-256-GCM, AAD bound to tenant and provider); the PKCE verifier is sealed separately. A token response without a refresh token is refused (`failed`), because the connection would die within the hour. Remove the app grant in the Google or Microsoft account as well when disconnecting.

## Gmail setup (not yet run against Google)

1. Google Cloud console: create a project, enable the Gmail API, configure the OAuth consent screen (internal for Workspace, or external with test users).
2. Create an OAuth client (type: web application). Authorised redirect URI: `https://<your host>/api/integrations/mail/gmail/callback` (plain `http://localhost:<port>/…` for local development). Set `MAIL_PROVIDER=gmail`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI` (exactly that URI) and `CREDENTIAL_ENCRYPTION_KEY`.
3. Endpoints used: authorize `https://accounts.google.com/o/oauth2/v2/auth` with `access_type=offline`, `prompt=consent` and PKCE (S256); token and refresh `https://oauth2.googleapis.com/token` (client secret in the form body). Google does not rotate the refresh token; the stored one is kept.
4. Scopes (least privilege): `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/gmail.send` (`GMAIL_SCOPES`). Scope names follow Google's published Gmail scope list but were not re-checked against Google's documentation for this change (unverified). Both are restricted scopes: an external app needs Google verification and may need a security assessment.
5. Push: create a Pub/Sub topic, grant `gmail-api-push@system.gserviceaccount.com` publish rights, call `users.watch` (`GmailMailAdapter.startWatch`) and renew it at least every 7 days. Notifications carry only a history id; fetch changes with `users.history.list` (`listChanges`). A history id older than about a week returns 404: fall back to a fresh start (no backfill is done).

## Microsoft 365 setup (not yet run against Microsoft)

1. Microsoft Entra admin centre › App registrations: register an application (supported account types to match `MS_GRAPH_TENANT`: `common` for any work/school or personal account, `organizations`, or your tenant id), add a **Web** redirect URI `https://<your host>/api/integrations/mail/microsoft_graph/callback`, and create a client secret. Set `MAIL_PROVIDER=microsoft_graph`, `MS_GRAPH_CLIENT_ID`, `MS_GRAPH_CLIENT_SECRET`, `MS_GRAPH_REDIRECT_URI`, optionally `MS_GRAPH_TENANT` (default `common`), and `CREDENTIAL_ENCRYPTION_KEY`.
2. Endpoints used: `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize` (PKCE S256) and `…/oauth2/v2.0/token` for the code exchange and refresh (the refresh sends the scopes; rotated refresh tokens are stored).
3. Delegated Microsoft Graph permissions: `offline_access`, `Mail.Read`, `Mail.Send` (`GRAPH_MAIL_SCOPES`; names not re-checked against Microsoft's permissions reference for this change, unverified). Some tenants require admin consent.
4. Changes: delta query on `/me/mailFolders/inbox/messages/delta` (first sync starts from now); optional change-notification subscriptions must be renewed before they expire (mail subscriptions last at most about 3 days).
5. Replies use `createReply` then `send`, which keeps Outlook's threading.

## Failure modes

| Failure                                    | What happens                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No mailbox connected                       | Approved reply fails with `NO_MAIL_CONNECTION`, shown on the draft; owner re-approves after fixing                                                                 |
| Refresh refused (revoked or expired grant) | `MAIL_REAUTHORISATION_REQUIRED`; the connection shows `error` / reauthorisation required in Settings; nothing is resent until the owner reconnects and re-approves |
| Access token rejected, scopes removed      | `PROVIDER_AUTH_EXPIRED` / `MAIL_REAUTHORISATION_REQUIRED`; no retry until the owner acts                                                                           |
| Provider rate limit or outage              | `PROVIDER_RATE_LIMITED` / `PROVIDER_UNAVAILABLE`; never resent automatically                                                                                       |
| Crash during a send                        | `SEND_OUTCOME_UNKNOWN`; the owner checks the Sent folder before approving again                                                                                    |
| Webhook replay or duplicate delivery       | Acknowledged once (event id and `Message-ID` de-duplication)                                                                                                       |
| Bad signature, stale timestamp             | 401, nothing stored                                                                                                                                                |
| Malformed message                          | 422 and a `rejected` receipt                                                                                                                                       |
| Privacy mode blocks the model              | Message stored and linked; no summary or draft (`policy_denied`), owner replies manually                                                                           |
| Runtime without triage (OpenClaw today)    | `unavailable`; owner replies manually                                                                                                                              |
| Disallowed or mislabelled attachment       | Not stored; listed as rejected on the message                                                                                                                      |

## WhatsApp (Planned)

Recommended approach: WhatsApp Business Cloud API (Meta) behind the `MessagingProvider` contract (`packages/integrations/src/mail/messaging.ts`, interface and `FakeMessagingProvider` only). Inbound webhooks verified with the app secret (`X-Hub-Signature-256`) at the relay, de-duplicated by `wamid`, stored as `communications` with `channel = 'whatsapp'` in the same threads; outbound only after owner approval, using an approved template outside the 24-hour customer-service window. Needs a Meta business account, a verified number and template approval; nothing is built or claimed.
