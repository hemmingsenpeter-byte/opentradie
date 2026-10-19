# Security: threat model

Scope: OPENTRADIE v0.1 (pre-release, no external audit). Vulnerability reporting: see the root [SECURITY.md](../SECURITY.md). Control status uses the labels from [ARCHITECTURE.md](ARCHITECTURE.md); "TBD at merge" means the backend lane's tests decide it.

## Assets

1. Customer personal data: names, phones, emails, addresses, job notes, messages.
2. Business financial data: approved rates, quotes, approvals, later invoices and accounting links.
3. Credentials: user password hashes, session tokens, provider OAuth tokens/API keys, `CREDENTIAL_ENCRYPTION_KEY`, `SESSION_SECRET`, OpenClaw Gateway token and device identity.
4. Audit trail integrity.
5. Availability of the owner's quoting workflow.

## Actors

| Actor                                      | Trust                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| Owner                                      | Authenticated, may approve quotes                                          |
| Viewer                                     | Authenticated, read-only                                                   |
| Unauthenticated internet user              | Untrusted                                                                  |
| Customer / sender of inbound messages      | Untrusted content author                                                   |
| The language model and anything it outputs | Untrusted, manipulable                                                     |
| OpenClaw Gateway process                   | Trusted infrastructure for one business, but its model output is untrusted |
| Hosted model / embedding provider          | External third party                                                       |
| Cloud host, relay or tunnel operator       | External third party (metadata at least)                                   |
| Another business on shared infrastructure  | Untrusted; must have a separate deployment                                 |

## Trust boundaries

1. Browser to API: session cookie, CSRF defences, input validation, rate limiting.
2. API to PostgreSQL: the API holds the only database credentials. The agent never receives them.
3. API to OpenClaw Gateway: authenticated WebSocket (token plus paired device). The Gateway is a **separate process per business**. OpenClaw's trust model supports one trust boundary per Gateway and states that operator access is not per-user tenant isolation and that `sessionKey` is a routing selector, not an authorisation token. OPENTRADIE therefore: one Gateway per business installation, never shared credentials, never a shared Gateway for mutually untrusted businesses.
4. OpenClaw to model provider: governed by the Gateway's configuration and the privacy mode ([PRIVACY.md](PRIVACY.md)).
5. API to third-party providers (Xero, email): Planned; tokens encrypted and business-scoped.
6. Local machine to cloud/relay (hybrid): Planned ([RELAY.md](RELAY.md)).

## Threats and controls

| Threat                                          | Controls                                                                                                                                                                                                                                                                | Status                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Unauthenticated access to data                  | Session auth on protected endpoints; login rate limiting; cookies `HttpOnly`, `Secure` in cloud                                                                                                                                                                         | TBD at merge                                                            |
| Privilege escalation viewer to owner            | Server-side role check on mutating endpoints and approval                                                                                                                                                                                                               | TBD at merge                                                            |
| Cross-tenant access                             | `tenant_id` from session; composite FKs; isolation tests                                                                                                                                                                                                                | TBD at merge                                                            |
| Prompt injection via customer messages or notes | Agent has no tools and no authority; output is a proposal parsed against a strict schema; backend re-validates against real records; prices only from approved rates; owner approves; system prompt tells the model to treat input as untrusted (a hint, not a control) | Implemented; adversarial tests TBD at merge                             |
| Model grants itself capability                  | Capabilities are set in code and Gateway config, never by model text                                                                                                                                                                                                    | Implemented by design                                                   |
| Price manipulation                              | Integer-cents deterministic pricing; DB CHECK constraints                                                                                                                                                                                                               | Implemented; tests TBD at merge                                         |
| Exfiltration to cloud models                    | Privacy modes fail closed; embeddings gated; no automatic fallback                                                                                                                                                                                                      | Implemented in API; Gateway-side consistency is operator responsibility |
| Exfiltration via logs/traces                    | No bodies, prompts or credentials logged; error responses generic                                                                                                                                                                                                       | TBD at merge                                                            |
| Credential theft at rest                        | AES-256-GCM for provider credentials; password hashing; token hashes in `sessions`; `.env` mode 0600                                                                                                                                                                    | TBD at merge                                                            |
| Secrets in the public repo                      | `.gitignore` for env/dumps; `.env.example` placeholders; CI uses throwaway values; secret scanning and push protection should be enabled in repo settings                                                                                                               | Config in repo; settings need owner action                              |
| Exposed Gateway                                 | Loopback binding; never publish the Gateway port; token + paired device; run tools-denied                                                                                                                                                                               | Documented; not enforced by OPENTRADIE                                  |
| Dependency compromise                           | Lockfile, exact catalog versions, `pnpm audit` in CI, Dependabot, CodeQL                                                                                                                                                                                                | Configured                                                              |
| Container escape / misconfiguration             | Non-root user in image; DB not published; app bound to loopback by default                                                                                                                                                                                              | Unverified (image not built here)                                       |
| Lost or stolen backup                           | Encrypt before storing off-machine ([MIGRATION.md](MIGRATION.md))                                                                                                                                                                                                       | Operator responsibility                                                 |

## Agent restrictions

The agent must never get: shell, arbitrary filesystem, production database credentials, cross-customer retrieval, or general send/financial authority. Configure the Gateway with tools denied and a dedicated agent ([OPENCLAW_INTEGRATION.md](OPENCLAW_INTEGRATION.md)); verify with the installed version's own security-audit tooling, because config keys and defaults change between OpenClaw releases. OpenClaw's documented defaults are permissive for a trusted single operator (for example host exec without prompts and session visibility `all`), which is why a dedicated, locked-down Gateway is required here.

## Residual risks

- The language model can still produce a plausible but wrong proposal; the owner is the control.
- The API cannot verify the Gateway's real model configuration or tool policy; a misconfigured Gateway undermines `LOCAL_ONLY`.
- No multi-factor authentication, account recovery, or per-user audit review UI in v0.1.
- Single owner account model; no fine-grained roles beyond owner/viewer.
- Rate limiting is per process; no WAF; TLS and DDoS protection are the host's job in cloud.
- Hybrid relay and webhook signature validation are not built.
- No penetration test or third-party review has been done.
