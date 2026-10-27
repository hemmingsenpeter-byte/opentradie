# Self-install guide (for technical customers)

This guide is for customers comfortable with Git, Docker, environment variables, DNS and a cloud dashboard who want to install and run OPENTRADIE themselves, end to end. If that's not you, ask us to set it up for you instead ([operator guide](README.md)).

You'll end up with your own isolated install:

- the OPENTRADIE web app and API;
- a private OpenClaw gateway that runs the AI agent;
- PostgreSQL with pgvector.

It all runs in accounts you own and pay for.

## 0. Before you start

**Licence.** OPENTRADIE is proprietary software ([LICENSE.md](../../LICENSE.md)). Running it requires a signed customer licence from us. Being able to read the source on GitHub is not permission to deploy it.

**Readiness.** v0.1 is a pilot release. Check these before relying on it for real work:

| Piece                                                       | Status                                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Enquiry → job → draft quote → approval workflow             | Tested in CI with a mock agent                                                    |
| Real OpenClaw agent                                         | Adapter built; **not yet verified against a live gateway**                        |
| Docker image (`Dockerfile`) and `docker-compose.cloud.yml`  | Image built and smoke-tested in CI; Compose stack started locally, never deployed |
| One-click Render Blueprint                                  | Not built: use Route A's manual steps                                             |
| `provision:tenant` (your business, owner login, your rates) | Not built: `pnpm db:seed` only creates a **synthetic demo business**              |
| Rates screen, data export                                   | See ARCHITECTURE.md for current status                                            |

Until `provision:tenant` exists, an install can only run the synthetic demo. Treat everything below as an evaluation install until those rows are done.

**You need:**

- [ ] Git, Node 24.22.0 and pnpm 10.33.4 locally, to run migrations, provisioning and smoke tests.
- [ ] Docker, for Route B or to test the image locally.
- [ ] A domain or subdomain you control.
- [ ] An **OpenRouter** account with a spending limit set, or another model provider that OpenClaw supports.
- [ ] A host: **Render** (Route A) or **any Docker host** with an HTTPS reverse proxy (Route B).

## 1. Get the code at a release tag

```sh
git clone https://github.com/hemmingsenpeter-byte/opentradie.git
cd opentradie
git checkout <release tag>      # e.g. v0.1.0; never deploy main
pnpm install --frozen-lockfile
pnpm test                       # optional: confirms your toolchain
```

## 2. Generate secrets

`pnpm setup:dev` writes a `.env` with random values for `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_KEY` and demo passwords. Use it as a starting point, or generate your own with `openssl rand -hex 32`.

Keep secrets in your host's secret store. Never commit them.

## 3. Run the OpenClaw gateway (both routes)

Follow [docs/OPENCLAW_INTEGRATION.md](../OPENCLAW_INTEGRATION.md). In short:

1. Run **one gateway for your business only**, with tools denied and a strong `OPENCLAW_TOKEN`.
2. Configure the model provider **on the gateway**: put your OpenRouter key there, not in OPENTRADIE.
3. Pair the OPENTRADIE device as that doc describes.
4. **Keep the gateway private.** On Render it's a private service; on Docker it sits on an internal network. Never expose it to the internet.

The OPENTRADIE client is pinned to OpenClaw `2026.10.8` and refuses any other Gateway version. Install exactly that Gateway version (`npm install -g openclaw@2026.10.8`, which needs Node 24.22.1 or newer), or wait for a tested release before upgrading the Gateway.

## 4a. Route A — Render (manual, until the Blueprint exists)

1. **Postgres:** New → PostgreSQL. Pick a region and note it: that's where your data lives. Render has no NZ region; Singapore is usually closest. Choose a plan with backups. Then enable pgvector:

   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```

   This is optional: text search works without it.

2. **Gateway:** New → **Private Service** for the OpenClaw gateway, configured as in step 3.
3. **Web app:** New → Web Service → your repository at the release tag → runtime **Docker** (uses the root `Dockerfile`). Health check path: `/health`.
4. **Environment** on the web service (see [Environment reference](#environment-reference)): set `DATABASE_URL` to the Postgres **internal** URL, and `OPENCLAW_URL` to the gateway's private address.
5. **Custom domain:** add it on the web service, then create the DNS record Render shows. Render issues the HTTPS certificate.

## 4b. Route B — Any Docker host

```sh
cp deployments/cloud/.env.example deployments/cloud/.env   # fill in every value
docker compose -f docker-compose.cloud.yml --env-file deployments/cloud/.env config   # validate
pnpm deploy:cloud                                          # validates env, then runs compose
```

- **Services:** `postgres` (pgvector), a one-off `migrate` job, and `app` (restart: unless-stopped). Add `--profile s3` to include MinIO for S3-compatible file storage, or point the `S3_*` variables at your own bucket.
- **Port binding:** the app listens on `127.0.0.1:3000` only. Put a reverse proxy in front of it to terminate HTTPS (Caddy, nginx, Traefik or your platform's load balancer). The cloud profile needs an `https://` `APP_ORIGIN` and secure cookies.
- **Gateway:** run it on the same private Docker network and set `OPENCLAW_URL` to its internal address.
- **Backups:** handle them yourself. Schedule `pg_dump` (encrypted, stored off the host) and test a restore. `pnpm test:backup` shows the restore check we use.

## 5. Load your business

Fill in [rates-template.csv](rates-template.csv) with **your** prices. Any service you don't price stays out of quotes: OPENTRADIE never invents a price, and it reports missing rates instead. The price column is `price_excl_gst_nzd` (or `price_incl_gst_nzd` if you enter prices including GST, or `price_nzd` if you are not GST registered). Prices may be written `85`, `85.5` or `$1,234.50`. Units are `each`, `hour` or `visit`. Delete any row you don't charge for: an empty price is an error, not zero.

```sh
DATABASE_URL=<your database URL> pnpm db:migrate
DATABASE_URL=<your database URL> pnpm provision:tenant \
  --business "Kauri Electrical Ltd" --trade electrician --owner-email you@example.co.nz \
  --gst-registered yes --gst-number 12-345-678 --prices-entered exclusive \
  --rates rates.csv --dry-run          # check the plan; nothing is written
# then run the same command without --dry-run
```

- **Owner password:** you are asked for it twice (it is not shown as you type). For a non-interactive run, put it in a file and set `OWNER_PASSWORD_FILE=/path/to/file`. It is never a command-line argument. At least 12 characters.
- **Checks before anything is written:** the GST number's IRD check digit, every row of the rates file (codes, units, prices, duplicates; all problems are listed with line numbers), and that this database holds no other business. The business, owner and rates are created in one transaction with audit events, and every rate is recorded as approved by the owner. No demo customers are created.
- **Tenant id:** pass `--tenant-id <uuid>`, or set `TENANT_ID` in the environment, or let the command generate one. It prints the id; set `TENANT_ID=<that id>` in the installation's `.env` (or platform secrets) and restart the app and worker. The API only serves the business whose id matches `TENANT_ID`.
- **Re-running** for a tenant that already exists prints "already provisioned" and changes nothing. The command refuses a database that holds the synthetic demo business (from `pnpm db:seed`) unless you pass `--allow-alongside-demo`, which is for test installations only.
- **Docker image:** the production image contains the command as `dist/scripts/provision-tenant.js`:
  ```sh
  docker run --rm -it --env-file .env -v "$PWD/rates.csv:/rates.csv:ro" <image> \
    node dist/scripts/provision-tenant.js --rates /rates.csv --business "..." ...
  ```
  The bundled command was built and run against PostgreSQL locally; running it inside the published image is not yet verified.

After provisioning, the owner manages prices in the app under **Settings › Price list** (add, edit, retire, price history, CSV export and import). `pnpm db:seed` still creates only the **synthetic demo business** for evaluation; don't use it for real customers.

## 6. Verify

```sh
curl https://<your domain>/health
OPENCLAW_URL=... OPENCLAW_TOKEN=... OPENCLAW_DEVICE_PATH=... OPENCLAW_SMOKE_REQUIRED=true pnpm test:openclaw
```

- [ ] `/health` shows:
  - `status: ok`;
  - profile `cloud`;
  - your privacy mode;
  - agent mode `openclaw`, **not** `mock`;
  - database `ok`.
- [ ] The smoke test passes. With `OPENCLAW_SMOKE_REQUIRED=true` it fails rather than skips.
- [ ] Sign in, send one test enquiry, and check the draft quote uses your rates. Approve it, then reject a second one.
- [ ] The gateway is unreachable from the public internet.
- [ ] The OpenRouter spending limit and your host's billing alerts are on.

## Environment reference

| Variable                                               | Value for a cloud install                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `DEPLOYMENT_PROFILE`                                   | `cloud`                                                                         |
| `DATABASE_URL`                                         | Your Postgres URL (internal/private where possible)                             |
| `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`          | Random, 32+ bytes; unique per install                                           |
| `TENANT_ID`                                            | A UUID you generate once and never change                                       |
| `APP_ORIGIN`                                           | `https://<your domain>`                                                         |
| `PRIVACY_MODE`                                         | `APPROVED_CLOUD` to use a hosted model. `LOCAL_ONLY` blocks hosted AI entirely. |
| `AGENT_MODE`                                           | `openclaw` (`mock` is for testing only)                                         |
| `OPENCLAW_URL`, `OPENCLAW_TOKEN`                       | Your private gateway address and token                                          |
| `OPENCLAW_DEVICE_PATH` or `OPENCLAW_DEVICE_STATE_JSON` | The paired device identity                                                      |
| `OPENCLAW_INFERENCE_LOCATION`                          | `hosted` for OpenRouter. This is your declaration of where inference runs.      |
| `AUTHORITATIVE_RUNTIME`                                | `true` on exactly one running install                                           |
| `MIGRATE_ON_START`                                     | `true` to apply migrations when the container starts                            |
| `FILE_STORE`, `S3_*`                                   | `local` (persistent disk) or `s3` with your bucket                              |

The full list, with comments, is in [.env.example](../../.env.example).

## Running it

- **Updates:** read the release notes, test the new tag on a copy (a separate database), then switch your deploy to the new tag. Migrations apply on start. Never run two writable installs against one database.
- **Backups:** confirm they run, and **test a restore** at least quarterly.
- **Secrets:** rotate `OPENCLAW_TOKEN` and your OpenRouter key if anyone who had access leaves. Changing `SESSION_SECRET` signs everyone out.
- **Monitoring:** watch `/health` with an uptime checker. Logs are structured JSON, and message bodies, credentials and prompts are redacted.
- **Security:** read [docs/SECURITY.md](../SECURITY.md). The short version: one gateway per business, never public; agents can't send, approve or touch the database; you approve every quote.

## Getting help

Support is a paid service. Contact us with your release tag, the `/health` output, and relevant log lines. Never send passwords or keys.

## Forgotten passwords and two-factor sign-in

- **Reset a forgotten password (no email needed):** on the machine running OPENTRADIE, run `pnpm owner:reset-password --email owner@example.co.nz` (in the Docker image: `docker run --rm -it --env-file .env <image> node dist/scripts/owner-reset-password.js --email …`). Type the new password twice (it is not shown), or set `NEW_PASSWORD_FILE=/path/to/file` for a non-interactive run. It is never a command-line argument. Every session is signed out. Two-factor stays on unless you add `--disable-mfa` (use that only when the authenticator and recovery codes are both lost).
- **Emailed reset link:** "Forgot password?" on the sign-in screen sends a 30-minute, single-use link only when a mailbox is connected (Settings › Email). The screen gives the same answer either way.
- **Two-factor sign-in:** each user turns it on in Settings › Security. It needs `CREDENTIAL_ENCRYPTION_KEY` to be set (the secret is stored encrypted). To require it for owners, set `REQUIRE_OWNER_MFA=true` (recommended for the cloud profile; default off). See [ADR 0031](../adr/0031-account-security-password-and-totp.md).
