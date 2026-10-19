# Hybrid profile

A local Mac mini is the single authoritative runtime: PostgreSQL, the OpenClaw Gateway and the API all run there, exactly as in [../local](../local/README.md). The cloud may _optionally_ supply inference (OpenClaw configured with a hosted provider under an approving privacy mode), inbound-event relay and off-site backups. Only the local part of this is implemented in v0.1.

## Rules this profile enforces

- Exactly one authoritative database and one Gateway per installation.
- `pnpm deploy:hybrid` refuses to continue if `DATABASE_URL` (or, in `openclaw` mode, `OPENCLAW_URL`) is not loopback, if a `CLOUD_`/`REMOTE_`/`SECONDARY_DATABASE_URL` is set, if `AUTHORITATIVE_RUNTIME` is not `true`, or if `.data/authoritative.lock` was written by a different host.
- That lock is an advisory local file. It does not stop an operator from separately starting a cloud stack. Process discipline and the migration procedure in [docs/MIGRATION.md](../../docs/MIGRATION.md) are what keep a single writer.
- Privacy mode is enforced by the API at request time regardless of profile. `LOCAL_ONLY` blocks hosted model and embedding use.

## Use

```sh
cp deployments/hybrid/hybrid.env.example .env   # then replace every placeholder
pnpm deploy:hybrid                               # validate, build, migrate (does not start)
deployments/local/install-launchd.sh install
```

## Remote access and inbound events

Not built. Options and privacy implications are documented in [docs/RELAY.md](../../docs/RELAY.md). Until a relay exists, remote phone access requires a tunnel you operate yourself; never expose the OpenClaw Gateway or PostgreSQL ports.
