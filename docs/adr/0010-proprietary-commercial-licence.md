# ADR 0010: Proprietary commercial licence

- Status: Accepted
- Date: 2026-10-19
- Supersedes: [ADR 0009](0009-licence-pending-public-source.md)

## Context

ADR 0009 left the repository public with no licence while the owner decided. On 19 October 2026 the owner chose commercial, protected terms.

## Decision

OPENTRADIE is proprietary commercial software. [LICENSE.md](../../LICENSE.md) reserves all rights to the owner. The public can view the source on GitHub, but use, deployment, modification, redistribution, hosted-service offerings and model training all require a written commercial licence. `package.json` declares `"license": "SEE LICENSE IN LICENSE.md"`. No open-source licence applies to OPENTRADIE's own code.

## Consequences

- External contributions are by invitation only, under a written contributor agreement.
- Third-party dependencies keep their own licences. Adding a dependency still requires a licence check, and copyleft licences (GPL, AGPL, LGPL used in a way that triggers obligations, SSPL) need the owner's explicit approval, because they could conflict with proprietary distribution.
- The repository stays public for now, so the source is visible even though it is not licensed. If the owner treats any part as a trade secret, the repository should be made private again. Visibility does not change the licence.
- The licence text was drafted by an AI assistant, not a lawyer. It should be reviewed by a New Zealand IP lawyer before any commercial agreement relies on it.
