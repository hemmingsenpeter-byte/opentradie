# Local profile (macOS, for example a Mac mini)

Everything runs on one machine: PostgreSQL, the OPENTRADIE API (which serves the built web app), optional native Ollama and an optional OpenClaw Gateway. Status: configuration and scripts are written; they have been **authored but not run on a Mac mini** by this lane. See [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) for what is verified.

## 1. PostgreSQL with pgvector

Either option gives one authoritative database. Use exactly one.

**Homebrew (suggested):**

```sh
brew install postgresql@17 pgvector
brew services start postgresql@17
createuser opentradie && createdb -O opentradie opentradie
psql -d opentradie -c "ALTER USER opentradie PASSWORD '<value from .env POSTGRES_PASSWORD>'"
```

Check that the `pgvector` formula supports your `postgresql@17` (`brew info pgvector`); the migrations enable the `vector` extension. Keep PostgreSQL listening on loopback only (`listen_addresses = 'localhost'`, the Homebrew default).

**Docker Desktop alternative:** `docker run -d --name opentradie-pg -p 127.0.0.1:5432:5432 -e POSTGRES_USER=opentradie -e POSTGRES_PASSWORD=... -e POSTGRES_DB=opentradie -v opentradie-pg:/var/lib/postgresql/data pgvector/pgvector:pg17`.

## 2. Configure, build, migrate

```sh
pnpm install --frozen-lockfile
pnpm setup:dev          # writes .env with random secrets; refuses to overwrite
pnpm deploy:local       # validates .env, checks PostgreSQL, builds, migrates
pnpm db:seed            # optional synthetic demo data
```

## 3. Run with restart-on-failure

```sh
deployments/local/install-launchd.sh install      # LaunchAgent: restarts on crash, 10 s throttle
curl -fsS http://127.0.0.1:3000/health
deployments/local/install-launchd.sh uninstall
```

A LaunchAgent runs while the user is logged in. For a headless Mac mini, enable automatic login for a dedicated non-admin user, or adapt the plist into a LaunchDaemon with `UserName` set (not provided or tested here). Logs go to `~/Library/Logs/opentradie/`.

There is currently no separate worker process in the repository, so there is no worker plist. Add one when a worker app exists.

## 4. Ollama (optional, native)

Install Ollama natively (not in Docker) so it can use Apple-silicon or Metal acceleration where available, bound to loopback:

```sh
brew install ollama
brew services start ollama          # listens on 127.0.0.1:11434 by default
ollama pull <a model you have chosen and have licence to use>
```

OPENTRADIE never talks to Ollama directly; OpenClaw does. Configure the provider in the Gateway (native API, base URL without `/v1`) as described in [docs/OPENCLAW_INTEGRATION.md](../../docs/OPENCLAW_INTEGRATION.md). Model choice is the operator's and is not hardcoded.

## 5. OpenClaw Gateway (optional)

Run a separate, isolated, tools-denied Gateway on loopback, pair a device, set `AGENT_MODE=openclaw`, then run the smoke procedure. All of that is in [docs/OPENCLAW_INTEGRATION.md](../../docs/OPENCLAW_INTEGRATION.md). Without it, keep `AGENT_MODE=mock`.

## 6. Backups

`pnpm test:backup` proves a backup/restore round trip in CI against a throwaway database. It is not a backup schedule. Schedule your own encrypted `pg_dump` and test restores; see [docs/MIGRATION.md](../../docs/MIGRATION.md).
