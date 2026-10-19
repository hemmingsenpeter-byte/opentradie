# ADR 0009: Licence pending; repository is public

- Status: Superseded by [ADR 0010](0010-proprietary-commercial-licence.md)
- Date: 2026-10-19

## Context

The repository was made public, but the owner has not chosen a licence. Without a licence, default copyright applies: others may view the source on GitHub but are not granted rights to use, copy, modify or redistribute it.

## Decision

Do not add an open-source or commercial licence autonomously. Keep `LICENSE.md` stating 'public source, no licence granted, all rights reserved pending owner decision' and `package.json` as `UNLICENSED`. The owner decides before any release or external contribution is accepted. Third-party dependencies keep their own licences (docs/UPSTREAM.md).

## Consequences

- External contributions should wait for a licence and contribution terms.
- Public visibility means secret scanning and careful commit hygiene matter more.
- This ADR is superseded when the owner records a licence decision.
