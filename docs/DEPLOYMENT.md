# Deployment

Three profiles, one codebase ([ADR 0003](adr/0003-one-product-three-deployment-profiles.md)). Read the verification table first; do not infer more than it says.

## What is verified

| Item                                                   | Status                                                                                                                                                                                   | Evidence                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Format, lint, typecheck, test, build                   | Passed locally on 2026-10-19 (Intel Mac, Node 24.22.0, pnpm 10.33.4); Linux CI configured, see Actions                                                                                   | `.github/workflows/ci.yml` `checks` job            |
| PostgreSQL 17 migrations and tests                     | Passed locally on embedded PostgreSQL 17 (110 backend tests, 12 files). pgvector migration `0003` stays pending locally and is exercised only by the CI `pgvector/pgvector:pg17` service | `tests/integration/migrations.test.ts`             |
| Backup/restore round trip                              | Logical encrypted backup and restore verified locally; the `pg_dump` path was skipped locally (no client) and is required in CI via `REQUIRE_PG_DUMP=true`                               | `pnpm test:backup`, CI `backup` job                |
| Playwright journeys (mobile-emulated chromium)         | 2 of 2 passed locally in real Chrome (`E2E_BROWSER_CHANNEL=chrome`, needed on macOS 12); CI job configured, see Actions                                                                  | `tests/e2e/quote-approval.spec.ts`, CI `e2e` job   |
| Built server smoke                                     | `pnpm test:smoke` passed locally: `dist/api/server.js` serves the slice over HTTP                                                                                                        | `scripts/smoke.ts`, CI `checks` job                |
| `pnpm setup:dev`, `pnpm dev`                           | Run on the authoring Mac (embedded PostgreSQL; the e2e run starts `pnpm dev`)                                                                                                            | `scripts/setup.ts`, `scripts/dev.ts`               |
| `pnpm deploy:local` build + migrate steps              | Implemented, not integration-tested                                                                                                                                                      | `scripts/deploy.mjs`                               |
| launchd agent (restart on failure)                     | Scaffolded; not run on a Mac mini                                                                                                                                                        | `deployments/local/`                               |
| Docker image and Compose stack                         | Scaffolded; **never built or run** (no Docker in the authoring environment)                                                                                                              | `Dockerfile`, `docker-compose.cloud.yml`           |
| Any real cloud deployment, HTTPS, managed Postgres, S3 | Not done                                                                                                                                                                                 | none                                               |
| Real OpenClaw Gateway with a real model                | Not done; the adapter is tested only against a fake gateway and the protocol schema                                                                                                      | [OPENCLAW_INTEGRATION.md](OPENCLAW_INTEGRATION.md) |
| Ollama / OpenRouter provider configuration             | Documented from OpenClaw docs; not run                                                                                                                                                   |                                                    |
| Relay ingress and delivery harness                     | Implemented and tested; no public relay or tunnel                                                                                                                                        | [RELAY.md](RELAY.md)                               |
| Xero, email, WhatsApp, speech                          | Planned                                                                                                                                                                                  |                                                    |

## Prerequisites (all profiles)

Node 24.22.0 (`.node-version`), pnpm 10.33.4 (`packageManager`), PostgreSQL 17. pgvector is optional: without it text search works and migration `0003` stays pending (the API still starts). Optional: Ollama, an OpenClaw Gateway (Node 22.19+ for its client packages; the Gateway has its own requirements), Docker for the cloud profile.

## Local (Mac mini or any macOS/Linux machine)

Step-by-step in [deployments/local/README.md](../deployments/local/README.md): PostgreSQL via Homebrew (or Docker), `pnpm setup:dev`, `pnpm deploy:local`, then the launchd agent, optional native Ollama and optional Gateway. Everything binds to loopback. Works without internet when `AGENT_MODE=mock`, or when OpenClaw uses a local Ollama model (not tested offline).

## Cloud

Containerised app plus PostgreSQL (pgvector) and optional MinIO via `docker-compose.cloud.yml`; template in `deployments/cloud/.env.example`.

```sh
cp deployments/cloud/.env.example deployments/cloud/.env   # fill in; no placeholders allowed
pnpm deploy:cloud                                          # validates, then docker compose up --build
```

You must supply: a host with Docker, DNS, an HTTPS reverse proxy or platform load balancer (not included), backups, and, for real agent use, an OpenClaw Gateway you operate and secure (not included). The config loader rejects a cloud profile without an HTTPS `APP_ORIGIN` and `SECURE_COOKIES=true`. A managed PostgreSQL with pgvector can replace the Compose database by setting `DATABASE_URL` and dropping the `postgres` and `migrate` dependencies (untested). No vendor lock-in is intended; none has been tested.

## Hybrid

The Mac mini is the single authoritative runtime (database, Gateway, API); cloud pieces are optional and mostly Planned. See [deployments/hybrid/README.md](../deployments/hybrid/README.md). `pnpm deploy:hybrid` adds guards (loopback database and Gateway, no secondary database settings, `AUTHORITATIVE_RUNTIME=true`, an advisory lock file). The guards do not prevent a determined operator from starting a second writer; follow [MIGRATION.md](MIGRATION.md) when moving.

## Health and diagnostics

`GET /health` returns `status` of `ok`, `degraded` (agent or file store unhealthy) or `unavailable` (database down, HTTP 503), plus the version, deployment profile, installation ID, privacy mode, agent mode and its reported inference location, database status, file store and embedding provider. The Settings screen in the web app shows the real profile and privacy mode from this data. Gateway health comes from the agent adapter (`health` method).

Migrations: `pnpm db:migrate`, or set `MIGRATE_ON_START=true` so the API applies pending migrations when it starts. The API refuses to start with required migrations pending, and claims the database for one `INSTALLATION_ID` (a second installation, a profile change or a different Gateway is refused). `RUN_WORKER=false` disables the in-process worker when `pnpm start:worker` runs separately.

The declared inference location is `OPENCLAW_INFERENCE_LOCATION` (`local` or `hosted`, default `hosted`). It is an operator attestation: the gateway cannot prove where inference runs, so `LOCAL_ONLY` treats anything not declared `local` as hosted and blocks it. `scripts/deploy.mjs` and the `deployments/*` env templates use the same variable.

## Installing for a customer

To set up a cloud install for a customer and hand it over, see the [customer install guide](customer-install/README.md).
