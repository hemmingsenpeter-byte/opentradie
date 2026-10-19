# ADR 0004: PostgreSQL, optional pgvector and checksummed SQL migrations

- Status: Accepted. Amended 2026-10-19: supersedes the original decision to define the schema with Drizzle. The backend lane removed Drizzle before merge.
- Date: 2026-10-19

## Context

One schema must run locally and in the cloud, support text search without an embedding provider, and keep vectors beside the authoritative data.

## Decision

Use PostgreSQL 17. The schema is hand-written, versioned SQL in `packages/database/migrations` (`0001_foundation`, `0002_queue_relay_policy`, `0003_knowledge_embeddings`). There is no ORM and no schema DSL: all data access is parameterised SQL through the `pg` pool (`packages/database/src/db.ts`).

`packages/database/src/migrations.ts` applies migrations in filename order, each in a transaction, under a Postgres advisory lock so concurrent starts are safe. It records a SHA-256 checksum per file in `schema_migrations` and refuses to start if an applied file has been edited.

pgvector is optional. A migration that begins with `-- requires-extension: vector` (currently only `0003`) is applied only where the extension is available on the server; otherwise it stays pending and is reported, and the API still starts. Customer, job and knowledge search use PostgreSQL full-text indexes and work without it. Embeddings go through an `EmbeddingProvider` that the privacy policy gates and are stored in `knowledge_embeddings` (768 dimensions, HNSW index) when pgvector exists.

## Consequences

- Any managed PostgreSQL that offers pgvector can host semantic search (not verified against a specific vendor). The CI `pgvector/pgvector:pg17` service container exercises migration `0003`; the embedded PostgreSQL used for local development and tests has no pgvector.
- Migrations are plain SQL, so they can be reviewed and run by any tool. Fixing a mistake means adding a new migration, never editing an applied one.
- There is no generated type layer: row shapes are typed by hand next to each query.
- Schema changes need a migration-compatibility test (`tests/integration/migrations.test.ts`).
