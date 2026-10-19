# Privacy

OPENTRADIE holds customer names, contact details, addresses, job notes and messages. This page says where that data can go and how the privacy modes limit it. Status: modes are Implemented in `packages/core` (`enforceModelPolicy`); end-to-end proof depends on tests marked TBD at merge. Nothing here is legal advice; check obligations (for example under the New Zealand Privacy Act 2020) with a qualified adviser before handling real customer data.

## Modes

| Mode                   | Hosted LLM / embedding APIs                                                                                                                                   | Behaviour when local inference is unavailable |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `LOCAL_ONLY` (default) | Never                                                                                                                                                         | Fails closed. No automatic cloud fallback     |
| `APPROVAL_REQUIRED`    | Intended: only with explicit authorisation per task and data category. **In the current scaffold, scoped approvals are not enabled, so hosted use is denied** | Fails                                         |
| `APPROVED_CLOUD`       | Allowed via configured providers with secret redaction and least data                                                                                         | May use cloud                                 |

Enforcement is server-side in the API (`enforceModelPolicy` denies hosted locations unless the mode is `APPROVED_CLOUD`). The decision is recorded without retaining unnecessary prompt content.

## The API does not control OpenClaw's model

The API tells OpenClaw to do work; OpenClaw's own configuration decides which model provider receives the prompt. An operator can configure a Gateway whose default model is hosted. Therefore:

- The API refuses to call the agent when `MODEL_LOCATION=hosted` and the mode is not `APPROVED_CLOUD` (config contradiction). `MODEL_LOCATION` is a declaration by the operator, not something the API observes.
- Operators must keep the Gateway's configured providers consistent with the mode. In `LOCAL_ONLY`, configure only local providers (Ollama) and no fallback models.
- This consistency is a configuration responsibility and is **not** technically verified by the API in v0.1 (it cannot inspect the Gateway's private config).

## Leak channels and controls

| Channel                              | Control                                                           | Residual risk                              |
| ------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------ |
| Hosted LLM prompts                   | Mode check before agent calls; minimised context                  | Misconfigured Gateway providers            |
| Embeddings                           | `embedWithPolicy` refuses hosted providers in `LOCAL_ONLY`        | Future providers must go through it        |
| Logs and exception traces            | No bodies, prompts or credentials logged; request IDs only        | A future logging change; review in PRs     |
| Telemetry                            | None built in                                                     | Third-party tooling the operator adds      |
| Background workers / retries         | Must use the same policy gate                                     | Worker not implemented; design requirement |
| File processing (OCR, transcription) | Not implemented; would need the same gate                         | Planned                                    |
| AI fallback                          | Not automatic                                                     | Gateway-level model fallback lists         |
| Backups                              | Encrypt before leaving the machine ([MIGRATION.md](MIGRATION.md)) | Key management is the operator's           |
| Relay / tunnel                       | See [RELAY.md](RELAY.md)                                          | Relay operator sees metadata at least      |
| Cloud profile                        | Data is in the operator's cloud account                           | Cloud operator and provider access         |

## Data subjects

Real customer data must not be used in tests, fixtures, CI or issue reports. Seed data is synthetic.
