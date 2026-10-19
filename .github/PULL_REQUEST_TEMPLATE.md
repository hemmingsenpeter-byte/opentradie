## What and why

<!-- One short paragraph. Link the milestone issue. -->

## Evidence

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- [ ] PostgreSQL, backup or Playwright checks run where behaviour changed
- [ ] Tests added or updated for changed behaviour (approval, tenant isolation and privacy rules need tests)
- [ ] Docs updated; status wording matches evidence (see AGENTS.md)
- [ ] ADR added in `docs/adr/` for a material architecture decision

## Safety checklist

- [ ] No credentials, customer data or message bodies in code, fixtures, logs or this description
- [ ] No new agent capability (shell, filesystem, database, send, approve)
- [ ] Money is integer cents; prices come from approved rates
- [ ] No claim of real provider, cloud or production operation without evidence

## Not verified

<!-- Anything you could not run or verify. Be explicit. -->
