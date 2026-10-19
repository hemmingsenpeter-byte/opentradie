# ADR 0007: Deterministic integer-cents pricing

- Status: Accepted
- Date: 2026-10-19

## Context

Models must not invent or calculate prices. Floating-point money is error-prone.

## Decision

All amounts are integer cents (`bigint` in PostgreSQL). Prices come only from owner-approved rate records. Quote totals and tax (basis points, configurable, default NZD and Pacific/Auckland) are computed by deterministic code in `@opentradie/core`, with database CHECK constraints as a second line of defence. Missing rates produce 'missing information', never a guessed price.

## Consequences

- Rounding rules must be explicit and tested.
- Tax rates are configuration, not hardcoded policy; verify them against official sources before real use.
