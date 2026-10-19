# Contributing

Use Node 24.22.0 LTS and pnpm 10.33.4. Run `pnpm install --frozen-lockfile`, then follow README setup. Use Conventional Commits. Submit scoped changes with tests and an ADR for material architecture decisions. `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` are required; CI additionally runs PostgreSQL integration, backup and browser tests. Never commit credentials or real customer data. Dependency updates must verify SDK/Gateway compatibility together; see docs/UPSTREAM.md. The repository is public but has no licence yet (see LICENSE.md and docs/adr/0009), so external contributions are not being accepted until the owner decides terms. Owner approval is required before any release or before adopting a licence. Report vulnerabilities privately (SECURITY.md).

## Pull requests

Open PRs against `main`; the `ci` check must pass. Use the PR template. Documentation must match behaviour: label status honestly and never claim cloud deployment, real OpenClaw operation or Xero/email integration without evidence.
