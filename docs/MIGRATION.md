# Migration and backup

Principle: one authoritative writer at all times. Moving an installation (for example Mac mini to cloud, or back) is a guided operational procedure, never a settings toggle.

## Phase 1 scope (v0.1)

| Item                                                  | Status                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| Backup and restore round trip, automated              | Implemented and tested (`pnpm test:backup`)                  |
| restic encrypted backups, retention and restore drill | Implemented and tested (`pnpm test:restore-drill`, ADR 0028) |
| Full migration tooling                                | Planned (milestone 12)                                       |
| Backup scheduling, offsite copy                       | Operator responsibility, documented below, not tested        |

`pnpm test:backup` takes a logical backup (gzip, optionally AES-256-GCM encrypted with a caller-supplied 32-byte key; format `opentradie-logical-v1`), restores it into a clean database and compares per-table row counts and SHA-256 checksums. Where a `pg_dump`/`pg_restore` at least as new as the server is on `PATH` it also round-trips a custom-format dump; locally (embedded PostgreSQL, no `pg_dump`) that path is skipped, and CI sets `REQUIRE_PG_DUMP=true` so it cannot be skipped there. The logical backup is a library function in `packages/platform`; `pnpm backup:run` (below) stores it, with the file store, in an encrypted restic repository. Neither command proves your production backups exist, are encrypted, or restore correctly on your hardware. Test your own restores.

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

## Encrypted backups with restic (ADR 0028)

restic (BSD-2-Clause) is an external binary you install yourself (`apt install restic`, `brew install restic`, or the official release binary after checking its SHA-256). It is not bundled.

Configuration (environment, never committed):

| Variable                                          | Meaning                                                                                                                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                    | database to back up                                                                                                                                                   |
| `BACKUP_RESTIC_REPOSITORY`                        | restic repository, for example a path on an external disk or `s3:...`                                                                                                 |
| `BACKUP_RESTIC_PASSWORD_FILE`                     | file holding the repository password (mode 600, outside the repo and the database). Required: the commands refuse to run without it; there is no unencrypted fallback |
| `BACKUP_RETENTION_DAILY` / `_WEEKLY` / `_MONTHLY` | snapshots to keep (default 7 / 4 / 12)                                                                                                                                |
| `FILE_STORE`, `FILE_STORE_PATH`                   | with the local FS profile the file store directory is included; with S3 it is not (use bucket versioning or replication)                                              |
| `INSTALLATION_ID`                                 | recorded as the `installation:<id>` tag                                                                                                                               |
| `BACKUP_RESTIC_BINARY`                            | optional path to restic (default `restic` on `PATH`)                                                                                                                  |

Backup (initialises the repository if needed, then applies `forget --prune` with the retention policy):

```sh
pnpm backup:run
restic snapshots --tag opentradie   # with RESTIC_REPOSITORY / RESTIC_PASSWORD_FILE set
```

Each snapshot holds `database/opentradie.otbk` (logical backup), `files/` (file store copy) and `manifest.json` (schema version, database artefact SHA-256), tagged `installation:<id>` and `schema:<latest migration>`. Staging needs free temporary disk about the size of the file store.

Restore runbook:

1. Stop the API and worker (one writer only).
2. Create an empty database and run `pnpm db:migrate` against it with the same release that made the backup (the `schema:` tag says which migration it was at).
3. `pnpm backup:restore -- --snapshot <id> --target <dir> --database-url <empty migrated database>`. The artefact is checked against the manifest, the data is restored and every table's row count and checksum is verified. Without `--database-url` only the files are restored to `<dir>`.
4. Copy `<dir>/files/` to `FILE_STORE_PATH`.
5. Run `restic check` periodically (`--read-data` verifies every pack and is slower).
6. Start the target and verify as in step 9 of the migration sequence.

`pnpm test:restore-drill` runs this whole path against a throwaway database and repository (CI backup job). Scheduling the backup (launchd, cron) is not provided or tested.

Optional offsite copy (unverified): `rclone sync <local restic repo> <remote>:<bucket>` (rclone is MIT and operator-installed), or point `BACKUP_RESTIC_REPOSITORY` at an offsite restic backend directly. Neither has been run by the project.
