# ADR 0003: One product, three deployment profiles via adapters and configuration

- Status: Accepted
- Date: 2026-10-19

## Context

The brief requires cloud, local and hybrid deployments from the same code, with infrastructure differences kept out of business logic.

## Decision

There is one repository, one domain model, one schema and one set of API contracts. A profile (`DEPLOYMENT_PROFILE=local|cloud|hybrid`) selects configuration and adapters (agent runtime, file store, model location) and operational packaging (launchd, Docker Compose). The profile is not a runtime settings toggle and migration between hosts is a separate operational procedure (docs/MIGRATION.md). Hybrid has exactly one authoritative database and one Gateway, on the local machine.

## Consequences

- Portability tests run the same behaviour against different adapter configurations.
- Profile validation (cloud requires HTTPS and secure cookies) lives in configuration loading.
- Cloud and hybrid packaging are unverified until deployed and tested; the docs say so.
