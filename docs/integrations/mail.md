# Email (Gmail, Microsoft 365) and messaging

Status: the inbox pipeline, the signed inbound endpoint, the paste route and send-after-approval are **Implemented and tested** with `FakeMailAdapter`, the mock agent and real PostgreSQL (`tests/integration/inbox.test.ts`, `tests/security/inbox-injection.test.ts`, `tests/e2e/inbox.spec.ts`). `GmailMailAdapter` and `MicrosoftGraphMailAdapter` are **Implemented, not integration-tested**: they have only run against a fake HTTP layer (`packages/integrations/src/mail/mail.test.ts`). Connecting a mailbox from the app is **Planned**: there is no OAuth route yet and provider tokens are not yet stored in `provider_connections`, so a real installation has no mail connection and approved replies fail with `NO_MAIL_CONNECTION`. WhatsApp is **Planned**. Decision record: [ADR 0022](../adr/0022-unified-inbox-and-email-ingestion.md).

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
3. **Provider sync** (`MailProvider.listChanges` + `fetchMessage`): implemented in both adapters, **not scheduled** yet because no tokens are stored.

## Gmail setup (for when connecting is built; not yet run)

1. Google Cloud console: create a project, enable the Gmail API, configure the OAuth consent screen (internal for Workspace, or external with test users).
2. Create an OAuth client (web application) with the OPENTRADIE callback URL.
3. Scopes (least privilege): `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/gmail.send` (`GMAIL_SCOPES`). Both are restricted scopes: an external app needs Google verification and may need a security assessment.
4. Push: create a Pub/Sub topic, grant `gmail-api-push@system.gserviceaccount.com` publish rights, call `users.watch` (`GmailMailAdapter.startWatch`) and renew it at least every 7 days. Notifications carry only a history id; fetch changes with `users.history.list` (`listChanges`). A history id older than about a week returns 404: fall back to a fresh start (no backfill is done).

## Microsoft 365 setup (for when connecting is built; not yet run)

1. Microsoft Entra admin centre: register an application, add a web redirect URI, create a client secret or certificate.
2. Delegated Microsoft Graph permissions: `offline_access`, `Mail.Read`, `Mail.Send` (`GRAPH_MAIL_SCOPES`). Some tenants require admin consent.
3. Changes: delta query on `/me/mailFolders/inbox/messages/delta` (first sync starts from now); optional change-notification subscriptions must be renewed before they expire (mail subscriptions last at most about 3 days).
4. Replies use `createReply` then `send`, which keeps Outlook's threading.

## Failure modes

| Failure                                  | What happens                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| No mailbox connected                     | Approved reply fails with `NO_MAIL_CONNECTION`, shown on the draft; owner re-approves after fixing |
| Token expired or revoked, scopes removed | `PROVIDER_AUTH_EXPIRED` / `PROVIDER_REAUTHORISATION_REQUIRED`; no retry until the owner acts       |
| Provider rate limit or outage            | `PROVIDER_RATE_LIMITED` / `PROVIDER_UNAVAILABLE`; never resent automatically                       |
| Crash during a send                      | `SEND_OUTCOME_UNKNOWN`; the owner checks the Sent folder before approving again                    |
| Webhook replay or duplicate delivery     | Acknowledged once (event id and `Message-ID` de-duplication)                                       |
| Bad signature, stale timestamp           | 401, nothing stored                                                                                |
| Malformed message                        | 422 and a `rejected` receipt                                                                       |
| Privacy mode blocks the model            | Message stored and linked; no summary or draft (`policy_denied`), owner replies manually           |
| Runtime without triage (OpenClaw today)  | `unavailable`; owner replies manually                                                              |
| Disallowed or mislabelled attachment     | Not stored; listed as rejected on the message                                                      |

## WhatsApp (Planned)

Recommended approach: WhatsApp Business Cloud API (Meta) behind the `MessagingProvider` contract (`packages/integrations/src/mail/messaging.ts`, interface and `FakeMessagingProvider` only). Inbound webhooks verified with the app secret (`X-Hub-Signature-256`) at the relay, de-duplicated by `wamid`, stored as `communications` with `channel = 'whatsapp'` in the same threads; outbound only after owner approval, using an approved template outside the 24-hour customer-service window. Needs a Meta business account, a verified number and template approval; nothing is built or claimed.
