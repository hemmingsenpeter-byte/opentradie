# Privacy

OPENTRADIE holds customer names, contact details, addresses, job notes and messages. This page says where that data can go and how the privacy modes limit it. Status: the modes are implemented in `packages/core` (`decideModelUse`, `assertModelUse`, `embedWithPolicy`) and tested in `tests/security/privacy-and-injection.test.ts` and `tests/integration/queue-and-relay.test.ts`. Nothing here is legal advice; check obligations (for example under the New Zealand Privacy Act 2020) with a qualified adviser before handling real customer data.

## Modes

| Mode                   | Hosted LLM / embedding APIs                                                                                                                       | Behaviour when local inference is unavailable |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `LOCAL_ONLY` (default) | Never                                                                                                                                             | Fails closed. No automatic cloud fallback     |
| `APPROVAL_REQUIRED`    | Only with a single-use owner approval naming the purpose, provider and data categories; it expires after 15 minutes (`POST /api/model-approvals`) | Fails unless an approval covers the request   |
| `APPROVED_CLOUD`       | Allowed via configured providers with secret redaction and least data                                                                             | May use cloud                                 |

Enforcement is server-side in the API: every inference and embedding request passes through one decision (`decideModelUse`) before content leaves the process. A local destination is always allowed; a hosted or `unverified` destination is allowed only as the mode permits. A denied request is never retried against another provider. The decision (destination, data categories, reason) is recorded without retaining prompt content. Background embedding tasks carry no owner approval, so in `APPROVAL_REQUIRED` they cannot use a hosted embedding provider.

## The API does not control OpenClaw's model

The API tells OpenClaw to do work; OpenClaw's own configuration decides which model provider receives the prompt. An operator can configure a Gateway whose default model is hosted. Therefore:

- The API refuses to call the agent when the destination is hosted and the mode does not allow it. For OpenClaw, `OPENCLAW_INFERENCE_LOCATION` (`local` or `hosted`, default `hosted`) is an operator attestation: the Gateway protocol cannot prove where inference runs. If `OPENCLAW_MODEL_PROVIDER` is left at `unconfigured`, the location is reported as `unverified` and is treated like hosted, so `LOCAL_ONLY` blocks it. Embedding providers are classified from their endpoint URL: only a loopback host counts as local.
- Operators must keep the Gateway's configured providers consistent with the mode. In `LOCAL_ONLY`, configure only local providers (Ollama) and no fallback models.
- This consistency is a configuration responsibility and is **not** technically verified by the API in v0.1 (it cannot inspect the Gateway's private config). The mock runtime is local and synthetic.

## Leak channels and controls

| Channel                        | Control                                                                                                                                                                                                                                    | Residual risk                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Hosted LLM prompts             | Mode check before agent calls; minimised context                                                                                                                                                                                           | Misconfigured Gateway providers                                                  |
| Embeddings                     | `embedWithPolicy` refuses hosted providers in `LOCAL_ONLY`                                                                                                                                                                                 | Future providers must go through it                                              |
| Logs and exception traces      | No bodies, prompts or credentials logged; request IDs only                                                                                                                                                                                 | A future logging change; review in PRs                                           |
| Telemetry                      | None built in                                                                                                                                                                                                                              | Third-party tooling the operator adds                                            |
| Background workers / retries   | The `knowledge.embed` task makes the same policy decision and records it                                                                                                                                                                   | New task kinds must do the same                                                  |
| Inbound email (inbox)          | Bodies stored in PostgreSQL only, never logged or put in audit/task metadata; the `inbox.triage` task applies the `message_triage` policy first; the agent gets sender display name, subject, body and attachment names only, no addresses | Sender addresses are stored to match and reply; see [mail](integrations/mail.md) |
| Transcription (speech-to-text) | `transcribeWithPolicy` gate; LOCAL_ONLY refuses non-loopback endpoints                                                                                                                                                                     | Implemented, not integration-tested ([speech](integrations/speech.md))           |
| File processing (OCR)          | Not implemented; would need the same gate                                                                                                                                                                                                  | Planned                                                                          |
| AI fallback                    | Not automatic                                                                                                                                                                                                                              | Gateway-level model fallback lists                                               |
| Backups                        | Encrypt before leaving the machine ([MIGRATION.md](MIGRATION.md))                                                                                                                                                                          | Key management is the operator's                                                 |
| Relay / tunnel                 | See [RELAY.md](RELAY.md)                                                                                                                                                                                                                   | Relay operator sees metadata at least                                            |
| Cloud profile                  | Data is in the operator's cloud account                                                                                                                                                                                                    | Cloud operator and provider access                                               |

## Customer quote acceptance

A sent quote's link (`/q/<token>`) lets anyone holding it view that quote and accept or decline it once, without signing in. Only the SHA-256 of the token is stored as the lookup credential; the plaintext link appears in the outbound message draft and the owner's send response. A decision stores the name the customer typed and an optional comment in `quote_decisions`. No IP address, user agent or device fingerprint is stored, and the name and comment are not copied into audit metadata or logs. Links stop working when the quote is revised (superseded), expires or has been decided. See [ADR 0018](adr/0018-quote-sending-and-customer-acceptance.md).

## Data subjects

Real customer data must not be used in tests, fixtures, CI or issue reports. Seed data is synthetic.
