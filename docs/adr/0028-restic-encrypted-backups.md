# ADR 0028: restic encrypted backups and a restore drill

Status: Accepted (2026-10-20). Implemented and tested locally with the official restic 0.17.3
linux/amd64 release binary (SHA-256 checked against the release's `SHA256SUMS`) and system
PostgreSQL 16. CI installs restic from the Ubuntu archive (a different version) and runs the same
drill; see the PR checks for that run.

## Context

`packages/platform/src/backup.ts` already produced a checksummed logical backup, but nothing
stored backups, applied retention, kept them encrypted at rest, or proved that a stored backup can
be restored. A backup that has never been restored is not evidence of a recovery capability.

## Decision

- Use restic (BSD-2-Clause) as an **external, operator-installed binary**; it is not vendored or
  bundled. `packages/platform/src/restic.ts` is a thin wrapper with an injectable command runner.
  It spawns restic with argument arrays (never a shell string), builds the child environment from
  scratch (`PATH`, `HOME`, `TMPDIR`, `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE` or
  `RESTIC_PASSWORD`) so no other process secret reaches restic, parses `--json` output, and never
  puts the password, repository credentials or restic's stderr in errors or logs. Exit codes 10
  (no repository) and 12 (wrong password) map to typed errors.
- One backup run stages, in a private temporary directory removed afterwards: the logical database
  backup (`database/opentradie.otbk`), a copy of the local file store (`files/`, local FS profile
  only) and `manifest.json` (schema version, SHA-256 of the database artefact). restic encrypts the
  snapshot, so the logical artefact is not double-encrypted. Tags: `opentradie`,
  `installation:<id>`, `schema:<latest migration>`.
- Retention: `forget --prune` with keep-daily 7, keep-weekly 4, keep-monthly 12 by default,
  configurable through `BACKUP_RETENTION_DAILY/WEEKLY/MONTHLY`.
- Fail closed: `pnpm backup:run` and `pnpm backup:restore` refuse to run without
  `BACKUP_RESTIC_REPOSITORY` and `BACKUP_RESTIC_PASSWORD_FILE`. There is no unencrypted fallback.
- Restore applies the logical restore only into an EMPTY database migrated to the same schema, and
  first checks the artefact against the manifest's SHA-256; `restoreLogicalBackup` then verifies
  every table's row count and checksum.
- `pnpm test:restore-drill` (CI backup job, after `pnpm test:backup`) is the acceptance evidence:
  seed, back up to a throwaway repository, drop the source, restore into a fresh database, verify
  row counts per table, a quote total, a stored file's SHA-256, `restic check --read-data`, and that
  a wrong password is refused.

## Consequences

- The S3 file store (cloud profile) is not copied by `backup:run`; its bucket needs its own
  versioning or replication. The staging copy of the file store needs free disk equal to its size.
- An offsite copy with rclone (MIT) is documented as optional and unverified.
- Scheduling (launchd, cron, a cloud job) is the operator's responsibility and is not tested.
- Losing the restic password means losing the backups; keep it outside the repository and the
  database.

## Amendment (2026-10-20)

The first CI run installed Ubuntu's restic 0.16.4, which exits 1 for both a missing repository and a wrong password, so the drill failed at the repository probe. The wrapper now refuses restic older than 0.17.0 (`UNSUPPORTED_VERSION`), and CI installs the official 0.17.3 release verified against its published SHA-256.
