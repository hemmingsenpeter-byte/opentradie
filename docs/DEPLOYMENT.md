# Deployment

Three profiles, one codebase ([ADR 0003](adr/0003-one-product-three-deployment-profiles.md)). Read the verification table first; do not infer more than it says.

## What is verified

| Item                                                   | Status                                                                      | Evidence                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------- |
| Install, lint, typecheck, test, build on Linux (CI)    | TBD at merge                                                                | GitHub Actions `ci` job                            |
| PostgreSQL 17 + pgvector migrations and tests          | TBD at merge                                                                | CI service container                               |
| Backup/restore round trip                              | TBD at merge                                                                | `pnpm test:backup` in CI                           |
| Playwright journeys (chromium)                         | TBD at merge                                                                | CI e2e job                                         |
| `pnpm setup:dev`, `pnpm dev`                           | Implemented, run on the authoring Mac only if the coordinator confirms      | scripts in `scripts/`                              |
| `pnpm deploy:local` build + migrate steps              | Implemented, not integration-tested                                         | `scripts/deploy.mjs`                               |
| launchd agent (restart on failure)                     | Scaffolded; not run on a Mac mini                                           | `deployments/local/`                               |
| Docker image and Compose stack                         | Scaffolded; **never built or run** (no Docker in the authoring environment) | `Dockerfile`, `docker-compose.cloud.yml`           |
| Any real cloud deployment, HTTPS, managed Postgres, S3 | Not done                                                                    | none                                               |
| Real OpenClaw Gateway with a real model                | Not done unless the smoke procedure has been run                            | [OPENCLAW_INTEGRATION.md](OPENCLAW_INTEGRATION.md) |
| Ollama / OpenRouter provider configuration             | Documented from OpenClaw docs; not run                                      |                                                    |
| Hybrid relay/tunnel                                    | Planned                                                                     | [RELAY.md](RELAY.md)                               |
| Xero, Gmail, WhatsApp                                  | Planned                                                                     |                                                    |

## Prerequisites (all profiles)

Node 24.22.0 (`.node-version`), pnpm 10.33.4 (`packageManager`), PostgreSQL 17 with the pgvector extension. Optional: Ollama, an OpenClaw Gateway (Node 22.19+ for its client packages; the Gateway has its own requirements), Docker for the cloud profile.

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

`GET /health` returns `ok` and checks the database (503 when unavailable). Settings in the web app should show the real profile and privacy mode (TBD at merge). Gateway health is exposed through the agent adapter.
