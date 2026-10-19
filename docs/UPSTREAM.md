# Upstream dependencies and licences

Third-party packages keep their own licences. OPENTRADIE itself is proprietary commercial software ([LICENSE.md](../LICENSE.md), [ADR 0010](adr/0010-proprietary-commercial-licence.md)). No upstream application code has been copied into this repository.

## Policy

- Versions are pinned exactly in the `catalog:` section of `pnpm-workspace.yaml`; `pnpm-lock.yaml` is committed; CI installs with `--frozen-lockfile`.
- Review the licence of every new direct dependency before adding it. Prefer permissive licences.
- Dependabot opens grouped weekly updates, except `@openclaw/*`, which is upgraded by hand together with the Gateway.
- CI runs `pnpm audit --prod --audit-level high` and CodeQL.

## Production dependency licences

Generated on 2026-10-19 from `pnpm licenses list --prod` (120 packages, including transitive dependencies; versions are those in `pnpm-lock.yaml` at that date). Regenerate it for every release (see below).

| Licence       | Packages | Notes                                                                                                                                                                    |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MIT           | 79       | Includes fastify 5.12.7, `@fastify/*`, pg 8.23.1, react and react-dom 19.3.1, zod 4.6.7, ws 8.21.3, `@openclaw/gateway-client` and `@openclaw/gateway-protocol` 2026.8.1 |
| Apache-2.0    | 24       | AWS SDK v3 (`@aws-sdk/client-s3` and its `@aws-sdk/*`, `@smithy/*` and `@aws/lambda-invoke-store` dependencies)                                                          |
| ISC           | 6        | fastq, inherits, pg-int8, semver, setprototypeof, split2                                                                                                                 |
| BlueOak-1.0.0 | 5        | glob, lru-cache, minimatch, minipass, path-scurry (permissive)                                                                                                           |
| BSD-3-Clause  | 3        | fast-uri, light-my-request, secure-json-parse                                                                                                                            |
| 0BSD          | 1        | tslib                                                                                                                                                                    |
| OFL-1.1       | 2        | `@fontsource/barlow`, `@fontsource/barlow-condensed` (web fonts)                                                                                                         |

Flags for the owner:

- **No copyleft (GPL, LGPL, AGPL, MPL) and no unknown or missing licence** appears in the production dependency tree.
- **OFL-1.1 (SIL Open Font License)** is not MIT-style but is permissive for bundling and serving fonts with an application. The fonts cannot be sold on their own; keep their licence text with the distributed assets. This is the only non-standard licence in the list; confirm it is acceptable before release.
- Development-only tools (Vite, Tailwind CSS, Vitest, Playwright, ESLint, Prettier, tsx, tsup, TypeScript, `embedded-postgres`) are not in the production tree and were not part of this scan. `embedded-postgres` downloads PostgreSQL binaries for development and tests only.
- This is a licence-string summary from package metadata, not legal advice or a review of licence texts.

## Key components

| Component                                                           | Role                                                           | Licence                                                                                          |
| ------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| OpenClaw (`@openclaw/gateway-client`, `@openclaw/gateway-protocol`) | Agent runtime client; the Gateway itself is a separate install | MIT for both client packages at 2026.8.1 (from the lockfile scan above)                          |
| PostgreSQL, pgvector                                                | Database, vector search                                        | PostgreSQL licence; pgvector uses the PostgreSQL licence (not part of the scan; verify upstream) |
| Fastify and plugins, Zod, pg                                        | API and data access                                            | MIT (scan above)                                                                                 |
| React, Vite, Tailwind CSS                                           | Web app                                                        | React MIT (scan above); Vite and Tailwind CSS are build-time only, MIT upstream (verify)         |
| AWS SDK for JavaScript v3 (S3 client)                               | S3-compatible file store                                       | Apache-2.0 (scan above)                                                                          |
| Playwright, Vitest, ESLint, Prettier, tsx, tsup, TypeScript         | Tooling                                                        | Development only; not scanned. Mostly MIT/Apache-2.0; verify                                     |
| MinIO (optional, cloud compose profile)                             | S3-compatible storage                                          | AGPLv3 upstream: review before offering it as a service to others                                |
| Ollama (optional, native)                                           | Local model serving                                            | MIT upstream (verify); individual models carry their own licences                                |

## Regenerating the full list

```sh
pnpm install --frozen-lockfile
pnpm licenses list --prod
```

Compare the result with the table above, attach it to the release notes, and flag any copyleft or unknown licence for the owner before release.

## OpenClaw version

The client packages are pinned at 2026.8.1. npm `latest` was 2026.10.5 on 2026-10-19; it has not been adopted (upgrade client and Gateway together, see [OPENCLAW_INTEGRATION.md](OPENCLAW_INTEGRATION.md)).
