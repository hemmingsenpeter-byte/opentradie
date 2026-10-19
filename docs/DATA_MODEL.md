# Data model

All identifiers are UUIDs. Every domain table carries `tenant_id`; composite foreign keys `(tenant_id, id)` keep related rows inside one tenant. Source of truth: `packages/database/migrations/` (do not trust this page over the SQL).

## Three kinds of data

| Kind                     | What                                                                      | Where                                                                                         | Rule                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A. Authoritative records | Business, users, customers, jobs, quotes, approvals, rates, audit         | PostgreSQL                                                                                    | Changed only by validated API services; audited                                                            |
| B. Searchable knowledge  | Communications, documents, notes, extractions, embeddings with provenance | PostgreSQL (`knowledge_items`, `communications`, `documents`, `job_notes`) and the file store | Retrieval preserves source, tenant scope, timestamp, confidence and verified/inferred/user-supplied status |
| C. Agent runtime state   | OpenClaw sessions, transcripts, memory                                    | Inside the OpenClaw Gateway                                                                   | Private to OpenClaw; never read or modified directly; never a source of truth                              |

Raw LLM history is never the source of truth. Unverified AI output is never automatically converted into authoritative customer or financial records.

## Entities (migration `0001_foundation`)

| Entity             | Table                        | Notes                                                                                        |
| ------------------ | ---------------------------- | -------------------------------------------------------------------------------------------- |
| Business           | `businesses`                 | currency (NZD default), time zone (Pacific/Auckland default), tax basis points               |
| User               | `users`                      | role `owner` or `viewer`; password hash only                                                 |
| Session            | `sessions`                   | stores a token hash, not the token                                                           |
| Customer           | `customers`                  | full-text index on name                                                                      |
| CustomerContact    | `customer_contacts`          |                                                                                              |
| Job                | `jobs`                       | status new, quoted, scheduled, in_progress, completed                                        |
| JobNote            | `job_notes`                  | provenance: user_supplied, verified, inferred                                                |
| Communication      | `communications`             | source, external reference; manual and mock sources in v0.1                                  |
| Document           | `documents`                  | storage key and media type; bytes live in the file store                                     |
| Approved rate      | `approved_rates`             | unit price in cents; only source of prices                                                   |
| Quote / line items | `quotes`, `quote_line_items` | draft or approved, versioned; totals checked by CHECK constraints                            |
| ApprovalRequest    | `approval_requests`          | who decided and when                                                                         |
| ProviderConnection | `provider_connections`       | credentials encrypted (AES-256-GCM key from `CREDENTIAL_ENCRYPTION_KEY`); usage TBD at merge |
| AuditEvent         | `audit_events`               | mutations recorded with request ID                                                           |
| KnowledgeItem      | `knowledge_items`            | searchable knowledge with provenance; pgvector column use TBD at merge                       |
| ScheduledTask      | `scheduled_tasks`            | job queue substrate ([ADR 0008](adr/0008-postgres-backed-job-queue.md))                      |
| Idempotency record | `idempotency_records`        | duplicate-request protection                                                                 |

Hierarchy: Business, then Customers, then Jobs, then Quotes. Communications, notes and documents attach to a customer or a job.

## Not stored on purpose

Prompts, provider responses and message bodies in logs; plaintext credentials; OpenClaw state.
