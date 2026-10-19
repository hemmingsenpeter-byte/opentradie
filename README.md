# OPENTRADIE

An AI-assisted business assistant for sole tradespeople (electricians, plumbers, builders and similar), starting in New Zealand. v0.1 delivers one vertical slice: **customer enquiry, job, deterministic draft quote, owner approval**, with a full audit trail.

The same code runs three ways: **local** (a Mac mini, data on the machine), **cloud**, or **hybrid** (local authoritative runtime, optional cloud inference). The AI never invents prices, sends messages or approves anything: it proposes, the backend validates and prices from owner-approved rates, and the owner approves.

> **Licence: none granted yet.** The source is public, but all rights are reserved pending the owner's decision ([LICENSE.md](LICENSE.md), [ADR 0009](docs/adr/0009-licence-pending-public-source.md)).
> **Pre-release.** Not security audited. Do not put real customer data in it.

## Status

Verified on 2026-10-19 on an Intel Mac (embedded PostgreSQL 17, no pgvector, no `pg_dump`): `pnpm format:check`, `lint`, `typecheck` and `build` pass; `pnpm test` runs 110 backend tests (12 files) and 3 web component tests, all passing; `pnpm test:backup`, `pnpm test:smoke` and the Playwright journeys (2 of 2, real Chrome) pass. **GitHub Actions CI is configured; see Actions** for its results. This page does not claim CI passes.

| Category                            | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implemented and tested              | Enquiry to owner-approved quote (API, web, Playwright); deterministic integer-cents quote maths with GST in basis points; owner and viewer roles; tenant isolation; idempotency keys; audit events; three privacy modes for inference and embeddings; prompt-injection resistance at the tool boundary; Postgres job queue (leasing, retries, recorded failures); relay harness (HMAC-signed `POST /relay/v1/events`, idempotent, retry); checksummed SQL migrations; logical encrypted backup and restore; local/cloud/hybrid profile configuration; single-authoritative-installation claim; log redaction; `MockAgentRuntime` |
| Implemented, not integration-tested | `RealOpenClawAgentRuntime` (tested against a fake gateway and the protocol schema, never a live Gateway); S3 file store (in-memory fake only); Ollama and OpenAI-compatible embeddings (injected `fetch`); pgvector path and `pg_dump` restore (the CI pgvector service and `REQUIRE_PG_DUMP=true` are meant to cover them); launchd packaging                                                                                                                                                                                                                                                                                   |
| Scaffolded only                     | `Dockerfile` and `docker-compose.cloud.yml` (never built, no Docker locally); `pnpm deploy:*` scripts validate and print steps only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Planned                             | Accounting (Xero), email, WhatsApp and speech adapters; a public multi-customer relay; full deployment migration tooling. No cloud deployment has been performed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Details and limitations: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Quickstart (development)

Requires Node 24.22.0 (`.node-version`) and pnpm 10.33.4. No separate PostgreSQL is needed for development: `pnpm setup:dev` starts an embedded PostgreSQL 17 in `.data/postgres` (`DEV_EMBEDDED_POSTGRES=true`). Edit `DATABASE_URL` in `.env` to use your own server instead. The embedded server has no pgvector, so semantic search stays off; text search works.

```sh
pnpm install --frozen-lockfile
pnpm setup:dev        # writes .env with random secrets, migrates, seeds the synthetic demo business
pnpm dev              # embedded Postgres (if configured), API on :3000 with the in-process worker, web on :5173
```

Open http://localhost:5173 and sign in as `OWNER_EMAIL` with `OWNER_PASSWORD` from `.env`.

| Command                                     | Purpose                                                                                                                                                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                 | Backend tests (vitest) and web component tests                                                                                                                                                                                                |
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | ESLint (no warnings), TypeScript, web build plus API/worker bundles in `dist/`                                                                                                                                                                |
| `pnpm format:check`                         | Prettier                                                                                                                                                                                                                                      |
| `pnpm test:e2e`                             | Playwright against `pnpm dev` (needs `pnpm setup:dev` first). On macOS 12 the bundled Chromium is unsupported: run `E2E_BROWSER_CHANNEL=chrome pnpm test:e2e` with Google Chrome installed                                                    |
| `pnpm test:smoke`                           | Serves the built `dist/api/server.js` and exercises the slice over HTTP (run `pnpm build` first)                                                                                                                                              |
| `pnpm test:backup`                          | Logical encrypted backup and restore round trip; `pg_dump` is checked only when a matching client is on `PATH` (CI sets `REQUIRE_PG_DUMP=true`)                                                                                               |
| `pnpm test:openclaw`                        | Opt-in smoke against a real OpenClaw Gateway; exits 0 with SKIPPED unless `OPENCLAW_URL` and `OPENCLAW_TOKEN` are set (`OPENCLAW_SMOKE_REQUIRED=true` makes that a failure). See [docs/OPENCLAW_INTEGRATION.md](docs/OPENCLAW_INTEGRATION.md) |

`pnpm test:integration` runs only the `tests/` directory. Other scripts: `pnpm db:migrate`, `pnpm db:seed`, `pnpm start`, `pnpm start:worker`.

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

Single business per installation; owner and viewer roles only; no email, accounting or messaging integrations; no multi-factor authentication; no public relay; Docker and launchd packaging unverified; the OpenClaw Gateway is operated separately and where it runs inference is an operator attestation (`OPENCLAW_INFERENCE_LOCATION`) the API cannot verify, so an unconfigured Gateway counts as unverified and `LOCAL_ONLY` blocks it.
