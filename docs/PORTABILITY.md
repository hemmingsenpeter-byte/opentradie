# Portability

Changing where OPENTRADIE runs must not require changing business logic. Differences live behind adapters, configuration and packaging.

## What stays identical across profiles

Repository, domain model, PostgreSQL schema and migrations, API contracts, web app, approval and security rules, and the functional test suite.

## What varies

| Concern            | Local                      | Cloud                                             | Hybrid                                        |
| ------------------ | -------------------------- | ------------------------------------------------- | --------------------------------------------- |
| Packaging          | Node process under launchd | Docker image + Compose                            | Local packaging; optional cloud pieces        |
| PostgreSQL         | Homebrew/Docker on the Mac | Compose service or managed Postgres with pgvector | Local, authoritative                          |
| Files              | Local filesystem           | S3-compatible (MinIO, cloud)                      | Local; optional off-site backup               |
| Agent              | Local OpenClaw Gateway     | Gateway you operate in the cloud                  | Local Gateway                                 |
| Models             | Ollama via OpenClaw        | Hosted via OpenClaw (OpenRouter etc.)             | Local by default; cloud only if policy allows |
| Secrets            | `.env` (0600)              | Environment from your platform                    | `.env`                                        |
| Profile validation | none beyond schema         | HTTPS origin + secure cookies required            | one authoritative DB and Gateway              |

## Adapter contracts

Typed interfaces named in the brief: `AgentRuntime`, `ModelPolicy`, `EmbeddingProvider`, `MemoryStore`, `FileStore`, `MessageProvider`, `EmailProvider`, `AccountingProvider`, `CalendarProvider`, `SpeechToText`, `TextToSpeech`, `JobQueue`, `SecretStore`, `BackupProvider`. Only variants needed for the first slice are implemented; the rest are documented, not coded.

| Interface          | Variants                         | Status                                                                        |
| ------------------ | -------------------------------- | ----------------------------------------------------------------------------- |
| AgentRuntime       | OpenClaw, mock                   | Implemented (real one not integration-tested by default)                      |
| EmbeddingProvider  | policy wrapper in `core`         | Implemented; providers TBD at merge                                           |
| FileStore          | local FS, S3-compatible          | TBD at merge                                                                  |
| AccountingProvider | test adapter; Xero prepared      | Planned; Xero is never claimed working without credentials and real API tests |
| EmailProvider      | mock inbound events; Gmail later | Planned                                                                       |
| JobQueue           | Postgres                         | Scaffolded                                                                    |
| Speech             | contracts only                   | Planned                                                                       |

Adapter rules: typed inputs and outputs, explicit error types, health and capability reporting, and no vendor fields in domain entities. Mocks are never marked production-ready.

## Portability tests

`tests/portability` is intended to run the same behaviours under different adapter configurations (status: TBD at merge). `pnpm test:backup` proves a PostgreSQL backup/restore round trip.

## Moving an installation

Moving between hosts is an operational procedure, not a settings toggle: see [MIGRATION.md](MIGRATION.md). Inbound events for hybrid installations: see [RELAY.md](RELAY.md).
