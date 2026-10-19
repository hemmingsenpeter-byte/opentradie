# ADR 0004: PostgreSQL, pgvector, Drizzle and SQL migrations

- Status: Accepted
- Date: 2026-10-19

## Context

One schema must run locally and in the cloud, support text search without an embedding provider, and keep vectors beside the authoritative data.

## Decision

Use PostgreSQL 17 with the `vector` extension (image `pgvector/pgvector:pg17`). Define table schemas with Drizzle (`packages/database/src/schema.ts`; the API's request handlers currently also use parameterised SQL through the `pg` pool, so Drizzle is not yet the only access path) and ship versioned, hand-reviewed SQL migrations in `packages/database/migrations`. Customer and job search uses PostgreSQL full-text indexes; embeddings are optional and go through an `EmbeddingProvider` that the privacy policy gates.

## Consequences

- Any managed PostgreSQL that offers pgvector can host the cloud profile (not verified against a specific vendor).
- Migrations are plain SQL, so they can be reviewed and run by any tool.
- Schema changes need a migration-compatibility test.
