# ADR 0006: Single-tenant runtime, tenant_id derived from authentication

- Status: Accepted
- Date: 2026-10-19

## Context

Each business is its own security boundary, and OpenClaw's trust model supports one trust boundary per Gateway. Full multi-tenant orchestration is out of scope for Phase 1.

## Decision

Each installation serves one business, but every domain table carries `tenant_id`, composite foreign keys keep related rows in one tenant, and queries take the tenant from the authenticated session, never from client input. Mutually untrusted customers get separate deployments and separate Gateways. The expected progression is single-tenant pilot, then multiple isolated deployments, then a control plane that does not bypass into customer agent runtimes.

## Consequences

- Cross-tenant isolation tests are required even though a deployment has one tenant.
- A future multi-business deployment is a new decision, not an extension of this one.
