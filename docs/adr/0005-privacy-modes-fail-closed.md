# ADR 0005: Privacy modes fail closed

- Status: Accepted
- Date: 2026-10-19

## Context

Trades businesses hold customer names, addresses and messages. Cloud inference and embeddings are leak channels. The brief defines three modes.

## Decision

Support `LOCAL_ONLY`, `APPROVAL_REQUIRED` and `APPROVED_CLOUD`, enforced server-side in the API through one decision function in `packages/core` (`decideModelUse` and `assertModelUse`; `embedWithPolicy` wraps it for embeddings). `LOCAL_ONLY` never reaches a hosted model or embedding API and never falls back automatically. Violations raise a policy error rather than degrading. Policy decisions are recorded without storing prompt content. A destination whose location cannot be established is `unverified` and is treated exactly like `hosted`.

## Consequences

- Local-only installs may lose AI features when local inference is down; that is intended.
- The API can enforce only what it controls: OpenClaw's own provider configuration must be set consistently by the operator (docs/PRIVACY.md).
- Tests must prove LOCAL_ONLY blocks hosted model and embedding requests.
- `APPROVAL_REQUIRED` allows hosted use only with an owner-granted, single-use approval that expires after 15 minutes and names the purpose, provider and data categories (`POST /api/model-approvals`, table `model_use_approvals`). `APPROVED_CLOUD` permits hosted use without per-task approval. Background embedding tasks carry no such approval, so in `APPROVAL_REQUIRED` they are denied for hosted providers.
