# ADR 0001: Modular monolith with pnpm workspaces

- Status: Accepted
- Date: 2026-10-19

## Context

OPENTRADIE v0.1 serves a single tradesperson's business. The brief rules out Kubernetes, microservices, event sourcing and message buses, and asks for one codebase that runs in three deployment profiles.

## Decision

Build one deployable API process (Fastify) that also serves the built web app. Organise code as pnpm workspaces (`apps/api`, `apps/web`, `packages/core`, `packages/database`, `packages/agent`, `packages/platform`) with a committed lockfile and a dependency catalog in `pnpm-workspace.yaml`. Do not add Turborepo or another task runner: the root scripts and pnpm filters are enough at this size. Bundle the API with tsup.

## Consequences

- One image and one process are simple to run on a Mac mini and in a container.
- Package boundaries are enforced by workspace dependencies, not by network calls, so they are cheap to change.
- Revisit a task runner if build or test times become a problem. Revisit process splitting only if a concrete need (for example a separate worker) appears; any split must not change domain code.
