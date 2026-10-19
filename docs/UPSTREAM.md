# Upstream dependencies and licences

Third-party packages keep their own licences. OPENTRADIE itself has no licence yet ([ADR 0009](adr/0009-licence-pending-public-source.md)). No upstream application code has been copied into this repository.

## Policy

- Versions are pinned exactly in the `catalog:` section of `pnpm-workspace.yaml`; `pnpm-lock.yaml` is committed; CI installs with `--frozen-lockfile`.
- Review the licence of every new direct dependency before adding it. Prefer permissive licences.
- Dependabot opens grouped weekly updates, except `@openclaw/*`, which is upgraded by hand together with the Gateway.
- CI runs `pnpm audit --prod --audit-level high` and CodeQL.

## Key components

| Component                                                           | Role                                                           | Licence (to verify from the lockfile)                                               |
| ------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| OpenClaw (`@openclaw/gateway-client`, `@openclaw/gateway-protocol`) | Agent runtime client; the Gateway itself is a separate install | `@openclaw/gateway-client` reports MIT on npm (checked 2026-10-19 with `pnpm view`) |
| PostgreSQL, pgvector                                                | Database, vector search                                        | PostgreSQL licence; pgvector uses the PostgreSQL licence (verify upstream)          |
| Fastify and plugins, Zod, pg, drizzle-orm                           | API and data access                                            | Mostly MIT; verify                                                                  |
| React, Vite, Tailwind CSS                                           | Web app                                                        | MIT; verify                                                                         |
| Playwright, Vitest, ESLint, Prettier, tsx, tsup, TypeScript         | Tooling                                                        | Mostly MIT/Apache-2.0; verify                                                       |
| MinIO (optional, cloud compose profile)                             | S3-compatible storage                                          | AGPLv3 upstream: review before offering it as a service to others                   |
| Ollama (optional, native)                                           | Local model serving                                            | MIT upstream (verify); individual models carry their own licences                   |

## Regenerating the full list

```sh
pnpm install --frozen-lockfile
pnpm licenses list --prod
```

Paste or attach the output to the release notes; do not hand-maintain a stale table. Flag any copyleft or unknown licence for the owner before release. A generated list was not available when this page was written (dependencies were not installed in the docs worktree).
