# OPENTRADIE

An AI-assisted business assistant for sole tradespeople (electricians, plumbers, builders and similar), starting in New Zealand. v0.1 delivers one vertical slice: **customer enquiry, job, deterministic draft quote, owner approval**, with a full audit trail.

The same code runs three ways: **local** (a Mac mini, data on the machine), **cloud**, or **hybrid** (local authoritative runtime, optional cloud inference). The AI never invents prices, sends messages or approves anything: it proposes, the backend validates and prices from owner-approved rates, and the owner approves.

> **Licence: none granted yet.** The source is public, but all rights are reserved pending the owner's decision ([LICENSE.md](LICENSE.md), [ADR 0009](docs/adr/0009-licence-pending-public-source.md)).
> **Pre-release.** Not security audited. Do not put real customer data in it.

## Status

Labels: Implemented and tested / Implemented, not integration-tested / Scaffolded / Planned. "TBD at merge" is reconciled by the integrator once the parallel lanes land.

| Area                                                               | Status                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------- |
| Enquiry to approved quote (API + web)                              | TBD at merge                                                  |
| Deterministic integer-cents pricing, approval rule, privacy policy | TBD at merge                                                  |
| Auth, roles, tenant scoping, audit                                 | TBD at merge                                                  |
| PostgreSQL 17 + pgvector schema and migration                      | TBD at merge                                                  |
| Mock agent runtime                                                 | Implemented (not evidence of real integration)                |
| Real OpenClaw Gateway adapter                                      | Implemented, not integration-tested (run the smoke procedure) |
| Backup/restore test                                                | TBD at merge                                                  |
| CI (lint, types, tests, e2e, audit, CodeQL)                        | Written; first green run TBD at merge                         |
| Local deployment (launchd, Homebrew Postgres, Ollama)              | Scaffolded; not run on a Mac mini                             |
| Cloud deployment (Docker image, Compose)                           | Scaffolded; never built or deployed                           |
| Hybrid relay / tunnel                                              | Planned (documented only)                                     |
| Email, Xero, WhatsApp, speech                                      | Planned                                                       |

Details and limitations: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Quickstart (development)

Requires Node 24.22.0 (`.node-version`), pnpm 10.33.4 and a PostgreSQL 17 with the pgvector extension reachable at the `DATABASE_URL` in `.env`.

```sh
pnpm install --frozen-lockfile
pnpm setup:dev        # creates .env with random secrets; prints demo passwords once
pnpm db:migrate
pnpm db:seed          # synthetic demo data
pnpm dev              # API on :3000, web on :5173
```

Open http://127.0.0.1:5173 and sign in with the owner account printed by `setup:dev`.

Checks: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`; also `pnpm test:integration`, `pnpm test:e2e` (Playwright, chromium), `pnpm test:backup`. Real-Gateway check (opt-in, may cost money): `pnpm test:openclaw`, see [docs/OPENCLAW_INTEGRATION.md](docs/OPENCLAW_INTEGRATION.md).

## Deployment profiles

| Profile | Command                            | Guide                                                                                                     |
| ------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Local   | `pnpm deploy:local`                | [deployments/local](deployments/local/README.md)                                                          |
| Cloud   | `pnpm deploy:cloud` (needs Docker) | [deployments/cloud](deployments/cloud/.env.example), [docker-compose.cloud.yml](docker-compose.cloud.yml) |
| Hybrid  | `pnpm deploy:hybrid`               | [deployments/hybrid](deployments/hybrid/README.md)                                                        |

The deploy scripts validate configuration and run only the steps they print; they do not provision hosts, TLS or an OpenClaw Gateway.

## Documentation

[Architecture](docs/ARCHITECTURE.md) · [Portability](docs/PORTABILITY.md) · [Security threat model](docs/SECURITY.md) · [Privacy](docs/PRIVACY.md) · [Data model](docs/DATA_MODEL.md) · [Deployment](docs/DEPLOYMENT.md) · [Migration and backup](docs/MIGRATION.md) · [OpenClaw integration](docs/OPENCLAW_INTEGRATION.md) · [Relay](docs/RELAY.md) · [Roadmap](docs/ROADMAP.md) · [Upstream dependencies](docs/UPSTREAM.md) · [ADRs](docs/adr/) · [Contributing](CONTRIBUTING.md) · [Agent rules](AGENTS.md) · [Security policy](SECURITY.md)

## Known limitations (v0.1)

Single business per installation; owner and viewer roles only; no email, accounting or messaging integrations; no multi-factor authentication; no public relay; Docker and launchd packaging unverified; the OpenClaw Gateway is operated separately and its model configuration cannot be verified by the API.
