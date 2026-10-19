# Architecture

OPENTRADIE is a modular monolith: one TypeScript codebase, one API process, one PostgreSQL schema. The same code runs in three deployment profiles (local, cloud, hybrid); only configuration, adapters and packaging differ ([ADR 0003](adr/0003-one-product-three-deployment-profiles.md)).

## Status vocabulary

Every doc uses these four labels. "TBD at merge" means the answer depends on parallel work that had not landed when this was written; the integrator reconciles it.

| Label                               | Meaning                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| Implemented and tested              | Code exists and automated tests exercise it              |
| Implemented, not integration-tested | Code exists; no test against the real external system    |
| Scaffolded                          | Structure, config or contract only; behaviour incomplete |
| Planned                             | Not started                                              |

## Shape

```text
Channels         PWA / dashboard (apps/web)          future: WhatsApp, email, Shortcuts, voice
                          |
OPENTRADIE API   apps/api (Fastify + Zod)
                 authn/authz, tenant scope, customers, jobs, quotes, approvals,
                 audit, privacy-policy enforcement, business-tool boundary
                          |
Agent adapter    packages/agent: AgentRuntime
                 MockAgentRuntime | RealOpenClawAgentRuntime (Gateway WebSocket client)
                          |
Portable infra   PostgreSQL + pgvector (packages/database), file store (local FS | S3),
                 job tables, secrets from environment
```

Workspaces: `apps/api`, `apps/web`, `packages/core` (pricing, approval rules, privacy policy), `packages/database` (schema, SQL migrations, seed), `packages/agent` (runtime adapters), `packages/platform` (shared platform helpers; contents TBD at merge).

## Rules that shape the code

- Agents propose; the backend validates; owners approve. The agent has no tools in v0.1 and no send, approve, shell, filesystem or database access.
- All material side effects go through validated API services and are audited.
- Money is integer cents; prices come from approved rate records ([ADR 0007](adr/0007-integer-cents-deterministic-pricing.md)).
- `tenant_id` comes from the authenticated session, never from client input ([ADR 0006](adr/0006-single-tenant-runtime-tenant-id-from-auth.md)).
- Privacy mode is enforced server-side and fails closed ([ADR 0005](adr/0005-privacy-modes-fail-closed.md)).
- OpenClaw is an external runtime reached only through its Gateway protocol ([ADR 0002](adr/0002-openclaw-gateway-client-only-agent-runtime.md)).

## Request flow: enquiry to approved quote

1. The owner submits an enquiry (`POST /api/enquiries`).
2. The API gathers tenant-scoped context (customers, notes, approved rates) and calls `AgentRuntime.interpret`. Under the current privacy mode the policy check runs first.
3. The agent returns a proposal (customer query, rate code, quantity). The backend validates it against real records, asks for clarification if ambiguous, and never trusts agent-supplied prices.
4. `calculateQuote` prices the draft from approved rates with integer arithmetic and records assumptions and missing information.
5. The owner reviews and approves (`POST /api/quotes/:id/approve`); only the `owner` role can, and an audit event is written in the same transaction.

Endpoint names are read from the current scaffold and may change; the OpenAPI document at `/api/openapi.json` is authoritative.

## Component status

| Component                                                | Status                                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Pricing, approval rule, privacy policy (`packages/core`) | TBD at merge (unit tests owned by the backend lane)                                                                              |
| Schema and SQL migration `0001_foundation`               | Implemented; migration run in CI against PostgreSQL 17 (TBD at merge)                                                            |
| API with auth, tenant scope, audit, rate limiting        | TBD at merge                                                                                                                     |
| `MockAgentRuntime`                                       | Implemented; never evidence of real integration                                                                                  |
| `RealOpenClawAgentRuntime`                               | Implemented, not integration-tested unless the smoke procedure has been run ([OPENCLAW_INTEGRATION.md](OPENCLAW_INTEGRATION.md)) |
| Web app (PWA)                                            | TBD at merge                                                                                                                     |
| Postgres-backed job worker                               | Scaffolded (tables only)                                                                                                         |
| Local FS file store / S3 adapter                         | TBD at merge                                                                                                                     |
| Email, Xero, WhatsApp, speech, relay                     | Planned (contracts at most)                                                                                                      |

## Observability

Structured JSON logs (Fastify/pino) with a request ID returned to clients, a `/health` endpoint that checks the database, and log redaction rules: never log message bodies, credentials, prompts or provider responses. Metrics endpoint: Planned.
