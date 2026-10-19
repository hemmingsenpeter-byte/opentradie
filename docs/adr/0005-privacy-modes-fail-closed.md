# ADR 0005: Privacy modes fail closed

- Status: Accepted
- Date: 2026-10-19

## Context

Trades businesses hold customer names, addresses and messages. Cloud inference and embeddings are leak channels. The brief defines three modes.

## Decision

Support `LOCAL_ONLY`, `APPROVAL_REQUIRED` and `APPROVED_CLOUD`, enforced server-side in the API (`enforceModelPolicy`, `embedWithPolicy`). `LOCAL_ONLY` never reaches a hosted model or embedding API and never falls back automatically. Violations raise a policy error rather than degrading. Policy decisions are recorded without storing prompt content.

## Consequences

- Local-only installs may lose AI features when local inference is down; that is intended.
- The API can enforce only what it controls: OpenClaw's own provider configuration must be set consistently by the operator (docs/PRIVACY.md).
- Tests must prove LOCAL_ONLY blocks hosted model and embedding requests.
- Current scaffold: `APPROVAL_REQUIRED` denies hosted use because scoped approvals are not yet enabled; only `APPROVED_CLOUD` permits it.
