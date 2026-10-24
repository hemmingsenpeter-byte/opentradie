# ADR 0011: Open-source integration strategy

- Status: Accepted; Phase 0 decision, no code changed
- Date: 2026-10-19

## Context

Twenty-five open-source projects were assessed as candidates to reuse or learn from ([open-source-assessment.md](../open-source-assessment.md), [integration-decision-matrix.md](../integration-decision-matrix.md)). OPENTRADIE is proprietary commercial software that may be run as a hosted service for customers ([ADR 0010](0010-proprietary-commercial-licence.md)). Several useful products are copyleft (OCA/field-service and EspoCRM are AGPL-3.0, ERPNext is GPL-3.0, Twenty is AGPL-3.0 with commercial files). Others are permissive but bring a second application stack (Chatwoot, Temporal, Activepieces).

## Decision

1. **Reference, do not copy, for copyleft and application-sized projects.** OCA/field-service, ERPNext, Twenty, EspoCRM, InvoicePlane and Cal.diy are read for domain concepts only. No code, schema text, templates or translations are copied or paraphrased closely. Ideas are recorded in our own words in design documents.
2. **Keep the dependency set minimal.** A library is added only when it replaces substantial work and fits the existing stack. Accepted for the roadmap: `@react-pdf/renderer` (quote and invoice PDFs), `xero-node` (behind `AccountingAdapter`), FullCalendar standard MIT packages (PWA calendar). Everything else that is needed runs as an external service behind a provider interface: whisper.cpp, optional faster-whisper, restic, optional rclone.
3. **Existing capabilities are not replaced.** The Postgres job queue ([ADR 0008](0008-postgres-backed-job-queue.md)), integer-cents engine ([ADR 0007](0007-integer-cents-deterministic-pricing.md)), hand-written SQL migrations ([ADR 0004](0004-postgres-pgvector-sql-migrations.md)) and the OpenClaw Gateway client ([ADR 0002](0002-openclaw-gateway-client-only-agent-runtime.md)) stay. pg-boss and Dinero.js are reference-only; Temporal and xero-python are rejected.
4. **Deferred, not rejected forever:** Expo and React Native Paper (after the PWA and API are stable), Activepieces (optional, non-critical connectors, never authoritative), PaddleOCR and MarkItDown (Python sidecars; native PDF and email text extraction first).
5. **Rejected on architecture grounds, not licence:** Chatwoot (see [ADR 0015](0015-native-communications-model-no-chatwoot.md)).
6. **Licence gate.** Every new direct dependency is recorded in [licence-inventory.md](../licence-inventory.md) with its licence string before it is merged. GPL, AGPL, LGPL, SSPL and unknown licences are refused without the owner's written approval. Packages with a premium or enterprise tier (FullCalendar Scheduler, Twenty and Chatwoot enterprise directories, Activepieces `ee`) are never installed or copied.
7. **Evidence rule.** Versions and licences are recorded with a review date; anything not read is written as "unverified".

## Consequences

- Some capabilities are built by us (inbox, scheduling model, money rules); the cost is estimated in the matrix and accepted.
- The assessment must be refreshed when a deferred item is picked up or a major version changes licence terms (FullCalendar v7 packaging and Xero API tiering are open items).
- Reviewers can reject a pull request that adds a dependency without a licence-inventory entry.
