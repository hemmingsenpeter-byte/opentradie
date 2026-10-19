# Migration and backup

Principle: one authoritative writer at all times. Moving an installation (for example Mac mini to cloud, or back) is a guided operational procedure, never a settings toggle.

## Phase 1 scope (v0.1)

| Item                                                | Status                                       |
| --------------------------------------------------- | -------------------------------------------- |
| PostgreSQL backup and restore round trip, automated | TBD at merge (`pnpm test:backup`, run in CI) |
| Full migration tooling                              | Planned (milestone 12)                       |
| Backup scheduling, encryption, retention            | Operator responsibility, documented below    |

Passing `pnpm test:backup` shows the database can be dumped and restored into a clean database in CI. It does not prove your production backups exist, are encrypted, or restore correctly on your hardware. Test your own restores.

## What a complete migration must cover

PostgreSQL data (including pgvector embeddings and embedding metadata), files, secrets and provider connections, OpenClaw runtime state, pending jobs, webhook deliveries, audit records.

## The 11-step sequence

1. Enter maintenance mode.
2. Stop or queue inbound mutations (webhooks, relay events, UI writes).
3. Drain or checkpoint background jobs.
4. Take encrypted backups (database, files; plus OpenClaw state through supported mechanisms only).
5. Transfer the backups to the target.
6. Verify schema versions and checksums on the target.
7. Restore runtime state using supported mechanisms. Never read or edit OpenClaw's private databases, transcripts or caches. If supported export/import for the installed OpenClaw version is not available, re-provision the Gateway and re-pair devices instead; OpenClaw memory is not the business database.
8. Rotate or rebind credentials: session secret, Gateway token and device pairing, provider OAuth tokens as required.
9. Start the target and verify (`/health`, login, a read of known records, audit continuity).
10. Reconcile queued events and deduplicate by idempotency key.
11. Resume traffic, then decommission the source so only one writer remains. Keep the source read-only and stopped until the target is verified.

Status: documented only. Steps 1 to 3 and 7 to 8 have no tooling in v0.1.

## Manual database backup recipe (operator)

```sh
pg_dump --format=custom --no-owner "$DATABASE_URL" > opentradie-$(date +%F).dump
# encrypt before storing off the machine, for example with age or gpg
```

Use a `pg_dump` at least as new as the server (17). Restore into an empty database with `pg_restore --no-owner`. `.dump` and `.enc` files are git-ignored; never commit backups.
