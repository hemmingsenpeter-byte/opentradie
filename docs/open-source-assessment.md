# Open-source assessment

Phase 0 research for the OPENTRADIE roadmap. Status: **Planned** work is assessed here; nothing in this document is integrated yet unless it says so. This page records decisions and evidence, not product claims.

## How this was reviewed

- Review date: **2026-10-19**. Evidence came from the public GitHub web pages (`LICENSE` files read from each default branch, the releases or tags page) and the npm registry metadata. The GitHub REST API and the vendor documentation sites were not reachable from the review environment, so no commit hashes were recorded. Where a version or fact could not be read it is marked **unverified**.
- GitHub release pages show dates without a year for the current year. Dates below are written as shown (for example `13 Oct`) and are read as 2026. `faster-whisper` shows `31 Oct`, which is later than the review date, so that release must be from an earlier year (the page does not say which).
- "Licence" is the licence text or `license` field that was read, not legal advice. "Custom development avoided" is qualitative (S/M/L) and rests on the assumptions in the next section. "Mac mini resources" is quoted only where upstream publishes a figure; nothing was measured on hardware.
- OPENTRADIE is proprietary commercial software ([ADR 0010](adr/0010-proprietary-commercial-licence.md)) and may be offered to customers as a hosted service. Copyleft code must therefore never be linked, bundled or copied into it (see [ADR 0011](adr/0011-oss-integration-strategy.md)).

### Assumptions behind the build-versus-adapt estimates

1. One experienced TypeScript developer plus AI assistance, working in this repository.
2. The existing pieces stay: integer-cents pricing ([ADR 0007](adr/0007-integer-cents-deterministic-pricing.md)), the Postgres job queue ([ADR 0008](adr/0008-postgres-backed-job-queue.md)), hand-written SQL migrations ([ADR 0004](adr/0004-postgres-pgvector-sql-migrations.md)), one Gateway and one database per installation.
3. "S" is days, "M" is one to three weeks, "L" is more than a month of focused work. These are judgement ranges, not measurements.
4. Avoided effort counts only work that would otherwise be written; integration, hardening and maintenance of the adopted component are not free and are noted under risk.

## Summary of decisions

| Repository                   | Decision                | Licence read                                 | Reviewed version                            |
| ---------------------------- | ----------------------- | -------------------------------------------- | ------------------------------------------- |
| openclaw/openclaw            | USE (existing)          | MIT                                          | v2026.10.8 (repo pins 2026.10.8)            |
| timgit/pg-boss               | REFERENCE               | MIT                                          | 12.38.0                                     |
| temporalio/temporal          | REJECT                  | MIT                                          | v1.32.1                                     |
| ggml-org/whisper.cpp         | SERVICE                 | MIT                                          | v1.9.5                                      |
| SYSTRAN/faster-whisper       | SERVICE (opt.)          | MIT                                          | v1.2.1                                      |
| OCA/field-service            | REFERENCE only          | AGPL-3.0                                     | no releases (branch per Odoo version)       |
| frappe/erpnext               | REFERENCE only          | GPL-3.0                                      | v16.51.1                                    |
| twentyhq/twenty              | REFERENCE only          | AGPL-3.0 plus commercial files; MIT packages | sdk/v2.48.0 (latest release marker)         |
| espocrm/espocrm              | REFERENCE only          | AGPL-3.0                                     | 10.0.10                                     |
| InvoicePlane/InvoicePlane    | REFERENCE only          | MIT-style text plus trademark notice         | v1.7.2                                      |
| diegomura/react-pdf          | USE                     | MIT                                          | @react-pdf/renderer 4.9.0                   |
| dinerojs/dinero.js           | REJECT/REFERENCE        | MIT                                          | v2.0.2                                      |
| XeroAPI/xero-node            | USE (adapter)           | MIT                                          | 20.0.0                                      |
| XeroAPI/xero-python          | REJECT                  | MIT                                          | 15.2.0                                      |
| expo/expo                    | DEFER                   | MIT                                          | expo-template-tabs@58.0.23 (SDK unverified) |
| callstack/react-native-paper | DEFER                   | MIT                                          | v5.15.3                                     |
| chatwoot/chatwoot            | REJECT/DEFER            | MIT outside `enterprise/`                    | v4.18.0                                     |
| activepieces/activepieces    | DEFER                   | MIT outside `packages/ee/`                   | 0.92.3                                      |
| postgres/postgres            | USE (authoritative)     | PostgreSQL Licence                           | REL_18_6 (stable), REL_19_RC1               |
| restic/restic                | SERVICE                 | BSD-2-Clause                                 | v0.19.1 (2026-07-05)                        |
| rclone/rclone                | SERVICE (opt.)          | MIT                                          | v1.75.2                                     |
| fullcalendar/fullcalendar    | USE (MIT packages only) | MIT (standard); premium differs              | @fullcalendar/react 7.1.3; v6.1.22 plugins  |
| calcom/cal.diy               | REFERENCE only          | MIT                                          | no release listed                           |
| PaddlePaddle/PaddleOCR       | DEFER                   | Apache-2.0                                   | v3.7.0 (2026-06-11)                         |
| microsoft/markitdown         | DEFER                   | MIT                                          | v0.1.8                                      |

## Findings that need the lead's attention

1. **pg-boss URL.** The brief's `github.com/kinker5/pg-boss` is not the project. The maintained repository is `github.com/timgit/pg-boss` (npm package `pg-boss`, MIT, 12.38.0, requires Node >= 22.12.0). `kinker5/pg-boss` was not reviewed.
2. **FullCalendar v7 packaging.** `@fullcalendar/core` and `@fullcalendar/react` are 7.1.3 (MIT), but `@fullcalendar/daygrid` and `@fullcalendar/timegrid` still report 6.1.22 as `latest` (MIT) and `@fullcalendar/resource-timeline` 6.1.22 reports `SEE LICENSE IN LICENSE.md` (premium). The v7 package split was not understood from the metadata alone. Before adding it, pin a combination whose every package reports `MIT` and whose version ranges are mutually compatible; verify with a throwaway install. Status: **unverified**.
3. **Xero API is now commercially tiered.** Secondhand sources (Codat, Apideck, Truto blog posts found by search; the Xero pricing page itself was unreachable) say Xero moved to connection-and-usage tiers from 2 March 2026, with a free Starter tier of about five connections and per-GB charges beyond allowances. These figures are **unverified**. This does not contradict using `xero-node`, but a sole-trader product with many customer connections must check the tier and cost model before the Xero adapter ships. See [ADR 0013](adr/0013-accounting-adapter-xero-ledger-authority.md).
4. **Cal.diy, Chatwoot and Activepieces are not copyleft.** Cal.diy is plain MIT; Chatwoot and Activepieces are MIT outside their `enterprise/` or `ee` directories. The REFERENCE, REJECT and DEFER decisions stand on architecture and operations grounds (a second large stack, duplicated data model), not on licence. Copying MIT code would be legally possible with notice, but the decisions here still say "concepts, no code".
5. **Twenty** is AGPL-3.0 with commercial-licence files and MIT-licensed sub-packages (SDK, UI library). The MIT sub-packages were not reviewed for use and are not needed.
6. **OpenClaw MCP.** OpenClaw documents `mcp.servers` entries with a Streamable HTTP `url`, `toolFilter.include/exclude`, and says MCP tools pass through the normal tool policy. The exact shape of authentication headers and the interaction between `toolFilter` and global tool policy are not documented in the page read. The tool-gateway plan in [architecture-v2.md](architecture-v2.md) depends on this and must be proven against a live Gateway (blocker, see the roadmap).
7. **No evidence contradicting a lead decision** was found. Items 2, 3 and 6 are risks to the decisions to USE FullCalendar, xero-node and the OpenClaw tool gateway.

## Per-repository assessment

### 1. openclaw/openclaw

| Point                         | Assessment                                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable functionality        | Agent runtime: sessions, model routing, channels, MCP client, tool policy. Reached only through the Gateway WebSocket protocol (`@openclaw/gateway-client`, `@openclaw/gateway-protocol`).      |
| Stack compatibility           | TypeScript; client packages already in the catalog at 2026.10.8 and used by `packages/agent`.                                                                                                   |
| Version reviewed              | Latest release `v2026.10.8`, adopted 2026-10-28 with a live Gateway smoke ([ADR 0034](adr/0034-openclaw-2026-10-client-side-command-neutralisation.md), [UPSTREAM.md](UPSTREAM.md)).            |
| Licence and SaaS implications | MIT ("Copyright (c) 2026 OpenClaw Foundation"). No copyleft concern.                                                                                                                            |
| Cloud, local or hybrid        | Runs per business installation, local or cloud; inference location is an operator attestation ([OPENCLAW_INTEGRATION.md](OPENCLAW_INTEGRATION.md)).                                             |
| Mac mini resources            | Gateway footprint unmeasured. Model inference dominates and depends on the configured provider.                                                                                                 |
| Security and maintenance risk | Fast release cadence; built-in tools (shell, filesystem, browser) must stay denied for the business agent. MCP header and policy interplay unverified (finding 6).                              |
| Custom development avoided    | L: an agent loop, session handling, model routing and channel plumbing.                                                                                                                         |
| Integration method            | Gateway client behind `AgentRuntime` (exists). New: an MCP tool server hosted by the API, listed under `mcp.servers` on the Gateway with `toolFilter.include` set to the OPENTRADIE tools only. |
| Phase                         | Existing (Phase 0 baseline); tool gateway in Phase 4.                                                                                                                                           |
| Decision                      | **USE (sole agent runtime)**, ADR 0002 unchanged; tool exposure is a new, separately documented extension.                                                                                      |

### 2. timgit/pg-boss (not kinker5/pg-boss)

| Point                         | Assessment                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reusable functionality        | Postgres job queue with scheduling, retries, cron, rate limiting, dead letters, `SKIP LOCKED` leasing.                                                                                                                               |
| Stack compatibility           | Node.js on `pg`; same driver version family (`pg ^8.23.1`). Runs in its own schema.                                                                                                                                                  |
| Version reviewed              | 12.38.0, release marked Latest (shown `13 Oct`). Requires Node >= 22.12.0 (repo runs Node 24). Peer dependency `@opentelemetry/api ^1.9.0`.                                                                                          |
| Licence and SaaS implications | MIT ("Copyright (c) 2016 Tim Jones").                                                                                                                                                                                                |
| Cloud, local or hybrid        | Any Postgres. No extra process.                                                                                                                                                                                                      |
| Mac mini resources            | No extra daemon; uses the same Postgres. Not measured.                                                                                                                                                                               |
| Security and maintenance risk | Creates and migrates its own tables, which would be a second migration mechanism next to ADR 0004 and a second set of tables in backups. Active upstream.                                                                            |
| Custom development avoided    | S to M. The in-repo `PostgresJobQueue` already provides idempotent enqueue in the caller's transaction, `SKIP LOCKED` leasing, lease reclaim, backoff and recorded failures, covered by `tests/integration/queue-and-relay.test.ts`. |
| Integration method            | None. Use as a design reference for cron-style scheduling and for dead-letter semantics.                                                                                                                                             |
| Phase                         | n/a                                                                                                                                                                                                                                  |
| Decision                      | **REFERENCE.** Adopting it would duplicate a working, tested queue. Add a transactional outbox on the existing queue ([ADR 0012](adr/0012-durable-workflow-outbox-on-existing-queue.md)).                                            |

### 3. temporalio/temporal

| Point                         | Assessment                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Reusable functionality        | Durable workflow execution, timers, sagas.                                                                                    |
| Stack compatibility           | Server is Go and needs its own persistence (not read from the page); TypeScript SDK exists separately (not reviewed).         |
| Version reviewed              | v1.32.1 (shown `08 Oct 21:56`).                                                                                               |
| Licence and SaaS implications | MIT ("Copyright (c) 2025 Temporal Technologies Inc.").                                                                        |
| Cloud, local or hybrid        | Needs a separate server cluster; cloud service is a hosted alternative with a commercial relationship (not evaluated).        |
| Mac mini resources            | A second stateful service per installation. Not measured.                                                                     |
| Security and maintenance risk | Adds an authoritative-looking second store of workflow state, against the "one authoritative database per installation" rule. |
| Custom development avoided    | M for dunning and approval timers, but those are a handful of queue tasks and outbox rows here.                               |
| Integration method            | None.                                                                                                                         |
| Phase                         | n/a                                                                                                                           |
| Decision                      | **REJECT.** An extra cluster for a one-person business installation is unacceptable operational complexity.                   |

### 4. ggml-org/whisper.cpp

| Point                         | Assessment                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reusable functionality        | Local speech-to-text. `whisper-cli` and `whisper-server` (HTTP `POST /inference`, multipart `file`, `response_format=json`, `prompt` for vocabulary hints).                                                                                                                                                  |
| Stack compatibility           | C/C++ binary; called over HTTP or as a subprocess from the worker. No Node dependency.                                                                                                                                                                                                                       |
| Version reviewed              | v1.9.5 (shown `06 Oct 17:39`).                                                                                                                                                                                                                                                                               |
| Licence and SaaS implications | MIT ("Copyright (c) 2023-2026 The ggml authors"). Model weights have their own terms (not reviewed).                                                                                                                                                                                                         |
| Cloud, local or hybrid        | Local-first; also runs on a Linux host.                                                                                                                                                                                                                                                                      |
| Mac mini resources            | Upstream table: tiny 75 MiB disk / ~273 MB memory, base 142 MiB / ~388 MB, small 466 MiB / ~852 MB, medium 1.5 GiB / ~2.1 GB, large 2.9 GiB / ~3.9 GB. Runs on Apple Silicon GPU via Metal; optional Core ML encoder on the Neural Engine (first run slow). Latency on NZ-accented site audio is unmeasured. |
| Security and maintenance risk | The server has no authentication and expects 16-bit WAV (ffmpeg via `--convert`). Upstream warns to sandbox it. Bind to `127.0.0.1` only, never expose, convert audio in the API before upload.                                                                                                              |
| Custom development avoided    | L: speech recognition itself. The adapter, queueing and transcript storage still have to be written (S to M).                                                                                                                                                                                                |
| Integration method            | `SpeechToText` adapter calling a local `whisper-server`, run as an external service the operator installs ([ADR 0014](adr/0014-speech-to-text-adapter.md)).                                                                                                                                                  |
| Phase                         | Phase 4                                                                                                                                                                                                                                                                                                      |
| Decision                      | **SERVICE.** Model file downloads are an operator step and a blocker for CI; CI uses a mock adapter.                                                                                                                                                                                                         |

### 5. SYSTRAN/faster-whisper

| Point                         | Assessment                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable functionality        | Faster Whisper inference on CTranslate2; VAD (Silero), batched transcription, int8 CPU mode.                                                                  |
| Stack compatibility           | Python >= 3.9; PyAV bundles FFmpeg. GPU needs NVIDIA CUDA 12 and cuDNN 9. Apple Silicon support is **not stated** in the README.                              |
| Version reviewed              | v1.2.1 ("faster-whisper 1.2.1", shown `31 Oct`, year not shown).                                                                                              |
| Licence and SaaS implications | MIT ("Copyright (c) 2023 SYSTRAN").                                                                                                                           |
| Cloud, local or hybrid        | Best on a Linux host with an NVIDIA GPU (hosted option). Not the primary local path.                                                                          |
| Mac mini resources            | Upstream CPU benchmark: small model, int8, 8 threads on an Intel i7-12700K, 1m42s and about 1477 MB RAM (their test audio). Not representative of a Mac mini. |
| Security and maintenance risk | Python service to package, patch and secure; wrap with an authenticated HTTP wrapper (the library itself has no server).                                      |
| Custom development avoided    | M relative to whisper.cpp alone: faster batch hosted transcription. Needs a wrapper service written in Python.                                                |
| Integration method            | Optional second `SpeechToText` implementation behind the same adapter, in a container, cloud and hybrid profiles only.                                        |
| Phase                         | Phase 4 (optional)                                                                                                                                            |
| Decision                      | **SERVICE (optional).** `LOCAL_ONLY` privacy mode must block the hosted variant (fail closed).                                                                |

### 6. OCA/field-service

| Point                         | Assessment                                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable functionality        | Odoo addon set for field service orders, workers, locations, stages, equipment. Useful as a concept checklist.                                                          |
| Stack compatibility           | Python and Odoo; incompatible with this stack.                                                                                                                          |
| Version reviewed              | GitHub shows no releases; versions are Odoo-version branches (branch names not read).                                                                                   |
| Licence and SaaS implications | AGPL-3.0 (GNU Affero General Public License, Version 3, 19 November 2007). Network use triggers source-offer obligations; unusable inside a proprietary hosted product. |
| Cloud, local or hybrid        | Needs a full Odoo.                                                                                                                                                      |
| Mac mini resources            | Not applicable.                                                                                                                                                         |
| Security and maintenance risk | Licence risk only if code were copied.                                                                                                                                  |
| Custom development avoided    | None directly (concepts only): saves design time (S).                                                                                                                   |
| Integration method            | None. Read for domain concepts (order stages, locations); write original code.                                                                                          |
| Phase                         | Phase 1 and 6 concept input                                                                                                                                             |
| Decision                      | **REFERENCE only.**                                                                                                                                                     |

### 7. frappe/erpnext

| Point                         | Assessment                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Reusable functionality        | Quotation, invoice, payment-entry and tax-template concepts; NZ localisation concepts.                                       |
| Stack compatibility           | Python and the Frappe framework with MariaDB and Redis; incompatible.                                                        |
| Version reviewed              | v16.51.1 (shown `15 Oct 17:09`).                                                                                             |
| Licence and SaaS implications | GPL-3.0 (`license.txt`: GNU General Public License, Version 3, 29 June 2007). Copied code would taint a proprietary product. |
| Cloud, local or hybrid        | Full ERP stack; far beyond a sole trader's needs.                                                                            |
| Mac mini resources            | Not applicable.                                                                                                              |
| Security and maintenance risk | Licence risk only if code were copied.                                                                                       |
| Custom development avoided    | None directly; concept input for tax and payment states (S).                                                                 |
| Integration method            | None.                                                                                                                        |
| Phase                         | Phase 3 concept input                                                                                                        |
| Decision                      | **REFERENCE only.**                                                                                                          |

### 8. twentyhq/twenty

| Point                         | Assessment                                                                                                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable functionality        | CRM data model ideas: objects, views, timelines, activity.                                                                                                                                                                                                                                        |
| Stack compatibility           | TypeScript (NestJS and React), separate Postgres and Redis stack. Compatible language, wrong product shape.                                                                                                                                                                                       |
| Version reviewed              | Latest release marker `sdk/v2.48.0` (shown `16 Oct 11:55`); the product tag was not separately read.                                                                                                                                                                                              |
| Licence and SaaS implications | "Mostly" AGPL-3.0; files marked `@license Enterprise` are under a commercial licence and need a subscription for production use; `twenty-sdk`, `twenty-ui` and a few other packages are MIT; an AGPL section 7 exception covers apps built on published interfaces. Core code must not be copied. |
| Cloud, local or hybrid        | Self-host stack of its own.                                                                                                                                                                                                                                                                       |
| Mac mini resources            | Not measured.                                                                                                                                                                                                                                                                                     |
| Security and maintenance risk | Licence risk if core code is copied.                                                                                                                                                                                                                                                              |
| Custom development avoided    | None; concept input for customer timelines (S).                                                                                                                                                                                                                                                   |
| Integration method            | None.                                                                                                                                                                                                                                                                                             |
| Phase                         | Phase 1 concept input                                                                                                                                                                                                                                                                             |
| Decision                      | **REFERENCE only.**                                                                                                                                                                                                                                                                               |

### 9. espocrm/espocrm

| Point                         | Assessment                                                                 |
| ----------------------------- | -------------------------------------------------------------------------- |
| Reusable functionality        | CRM entities, stream/timeline, email handling concepts.                    |
| Stack compatibility           | PHP; incompatible.                                                         |
| Version reviewed              | 10.0.10 (shown `14 Oct 15:47`).                                            |
| Licence and SaaS implications | AGPL-3.0 (GNU Affero General Public License, Version 3, 19 November 2007). |
| Cloud, local or hybrid        | Own PHP and database stack.                                                |
| Mac mini resources            | Not measured.                                                              |
| Security and maintenance risk | Licence risk if code were copied.                                          |
| Custom development avoided    | None; concept input for communications timeline (S).                       |
| Integration method            | None.                                                                      |
| Phase                         | Phase 5 concept input                                                      |
| Decision                      | **REFERENCE only.**                                                        |

### 10. InvoicePlane/InvoicePlane

| Point                         | Assessment                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable functionality        | Invoice and quote layout, recurring invoice and numbering concepts.                                                                                                                                                       |
| Stack compatibility           | PHP (CodeIgniter); incompatible.                                                                                                                                                                                          |
| Version reviewed              | v1.7.2 (shown `28 Aug 09:00`).                                                                                                                                                                                            |
| Licence and SaaS implications | `LICENSE.txt` opens with a trademark notice and then contains an MIT-style licence (2012-2014) plus EllisLab's CodeIgniter licence. Exact SPDX identifier **unverified**; the trademark notice restricts use of the name. |
| Cloud, local or hybrid        | Self-hosted PHP app.                                                                                                                                                                                                      |
| Mac mini resources            | Not measured.                                                                                                                                                                                                             |
| Security and maintenance risk | None for a concept-only review.                                                                                                                                                                                           |
| Custom development avoided    | None; layout ideas for invoice documents (S).                                                                                                                                                                             |
| Integration method            | None.                                                                                                                                                                                                                     |
| Phase                         | Phase 3 concept input                                                                                                                                                                                                     |
| Decision                      | **REFERENCE only.**                                                                                                                                                                                                       |

### 11. diegomura/react-pdf

| Point                         | Assessment                                                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable functionality        | Render PDF documents from React components, in Node (`renderToBuffer`/stream) or the browser.                                                                                                              |
| Stack compatibility           | npm `@react-pdf/renderer` 4.9.0; peer dependency `react ^16.8                                                                                                                                              |     | ^17 |     | ^18 |     | ^19`, so React 19.3.1 is in range. The API workspace has no React dependency today; adding it is a deliberate dependency decision. Pure JS (uses `pdfkit`), no browser needed. |
| Version reviewed              | @react-pdf/renderer 4.9.0 (shown `27 Aug 22:57`; registry `latest`). Release is more than two weeks old.                                                                                                   |
| Licence and SaaS implications | MIT ("Copyright (c) 2017-present Diego Muracciole"). Transitive dependency licences (pdfkit, fontkit and friends) are **not yet reviewed**; run `pnpm licenses list --prod` after the dependency is added. |
| Cloud, local or hybrid        | Runs in the API process on any profile; no cloud call.                                                                                                                                                     |
| Mac mini resources            | CPU and memory per document unmeasured; documents are small.                                                                                                                                               |
| Security and maintenance risk | Renders owner-approved data only; escape and length-limit customer text. Fonts must be bundled (do not fetch at render time). Layout bugs on long tables possible.                                         |
| Custom development avoided    | M: PDF layout engine. Template design and NZ tax-invoice wording are still ours.                                                                                                                           |
| Integration method            | `packages/documents` (new, planned) with pure functions from approved quote/invoice snapshots to a PDF buffer; stored through the existing `FileStore`.                                                    |
| Phase                         | Phase 2 (quote PDF), Phase 3 (invoice PDF)                                                                                                                                                                 |
| Decision                      | **USE.**                                                                                                                                                                                                   |

### 12. dinerojs/dinero.js

| Point                         | Assessment                                                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable functionality        | Immutable money values, allocation, currency formatting, bigint-capable.                                                                                                                  |
| Stack compatibility           | TypeScript, no runtime dependencies.                                                                                                                                                      |
| Version reviewed              | v2.0.2 stable (shown `13 Mar 15:39`); pre-release `v2.0.0-alpha.17` also listed.                                                                                                          |
| Licence and SaaS implications | MIT ("Copyright (c) 2018-present Sarah Dayan").                                                                                                                                           |
| Cloud, local or hybrid        | Library.                                                                                                                                                                                  |
| Mac mini resources            | Negligible.                                                                                                                                                                               |
| Security and maintenance risk | A second money abstraction beside `packages/core/src/money.ts` risks two rounding rules. The repo states one rounding rule (half-up once on the subtotal) as a shown business assumption. |
| Custom development avoided    | S. The only gap Dinero would fill is allocation of a total across parts, which the engine can add in a few lines with tests.                                                              |
| Integration method            | None. Reference its allocation algorithm if line-level tax allocation is needed.                                                                                                          |
| Phase                         | n/a                                                                                                                                                                                       |
| Decision                      | **REJECT as a dependency; REFERENCE for allocation.** Extend `money.ts` for fractional quantities (see [architecture-v2.md](architecture-v2.md)).                                         |

### 13. XeroAPI/xero-node

| Point                         | Assessment                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reusable functionality        | Typed Xero API client: OAuth2 code flow, token refresh, accounting endpoints (contacts, invoices, payments, accounts), client-credentials for Custom Connections.                                                                                                                                            |
| Stack compatibility           | TypeScript; dependencies `axios ^1.7.7` and `openid-client ^5.7.0`; no `engines` field in the package metadata.                                                                                                                                                                                              |
| Version reviewed              | 20.0.0 (shown `18 Sep 03:50`).                                                                                                                                                                                                                                                                               |
| Licence and SaaS implications | MIT ("Copyright (c) 2019 Xero"). Using the Xero API is governed separately by Xero's developer terms and the new commercial tiering (finding 3, unverified).                                                                                                                                                 |
| Cloud, local or hybrid        | Outbound HTTPS to Xero. Hybrid and cloud profiles work directly; a local Mac mini needs a reachable OAuth redirect URI (relay or tunnel; local callback `127.0.0.1` is also possible for the owner's own browser).                                                                                           |
| Mac mini resources            | Negligible.                                                                                                                                                                                                                                                                                                  |
| Security and maintenance risk | Access tokens last 30 minutes and refresh tokens 60 days (README); refresh-token rotation requires transactional storage in `provider_connections` using the existing `CREDENTIAL_ENCRYPTION_KEY`. README does not cover rate limits, idempotency keys or NZ GST behaviour; those need testing in a sandbox. |
| Custom development avoided    | M to L: typed models, OAuth plumbing, token refresh.                                                                                                                                                                                                                                                         |
| Integration method            | Behind `AccountingAdapter` in a new `packages/integrations` workspace; outbound work is driven by outbox rows ([ADR 0013](adr/0013-accounting-adapter-xero-ledger-authority.md)).                                                                                                                            |
| Phase                         | Phase 3                                                                                                                                                                                                                                                                                                      |
| Decision                      | **USE behind an adapter.** Blocked on sandbox credentials (a Xero demo company and an app registration).                                                                                                                                                                                                     |

### 14. XeroAPI/xero-python

| Point                         | Assessment                                      |
| ----------------------------- | ----------------------------------------------- |
| Reusable functionality        | Same API surface as xero-node in Python.        |
| Stack compatibility           | Python; the repo has no Python service.         |
| Version reviewed              | 15.2.0 (shown `04 Sep 03:28`).                  |
| Licence and SaaS implications | MIT ("Copyright (c) 2020, Xero Developer API"). |
| Cloud, local or hybrid        | Would force a Python sidecar.                   |
| Mac mini resources            | Not measured.                                   |
| Security and maintenance risk | Second runtime to patch.                        |
| Custom development avoided    | None beyond xero-node.                          |
| Integration method            | None.                                           |
| Phase                         | n/a                                             |
| Decision                      | **REJECT.**                                     |

### 15. expo/expo

| Point                         | Assessment                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Reusable functionality        | React Native toolchain for iOS and Android apps.                                                                                 |
| Stack compatibility           | React and TypeScript; separate native build and distribution pipeline.                                                           |
| Version reviewed              | Latest release listing is `expo-template-tabs@58.0.23` (shown `16 Oct 19:50`); the SDK version itself was not read (unverified). |
| Licence and SaaS implications | MIT ("Copyright (c) 2015-present 650 Industries, Inc.").                                                                         |
| Cloud, local or hybrid        | Client app only.                                                                                                                 |
| Mac mini resources            | Not applicable.                                                                                                                  |
| Security and maintenance risk | App-store review, native upgrades, a second UI codebase.                                                                         |
| Custom development avoided    | None until a native app is justified (push, background audio, offline).                                                          |
| Integration method            | None now. The PWA must reach feature parity first.                                                                               |
| Phase                         | Deferred (after Phase 7)                                                                                                         |
| Decision                      | **DEFER.**                                                                                                                       |

### 16. callstack/react-native-paper

| Point                         | Assessment                                       |
| ----------------------------- | ------------------------------------------------ |
| Reusable functionality        | Material Design components for React Native.     |
| Stack compatibility           | Only relevant if Expo/React Native is adopted.   |
| Version reviewed              | v5.15.3 (released 2026-05-26 per its changelog). |
| Licence and SaaS implications | MIT ("Copyright (c) 2017 Callstack").            |
| Cloud, local or hybrid        | Client library.                                  |
| Mac mini resources            | Not applicable.                                  |
| Security and maintenance risk | None while unused.                               |
| Custom development avoided    | None while unused.                               |
| Integration method            | None.                                            |
| Phase                         | Deferred with Expo                               |
| Decision                      | **DEFER.**                                       |

### 17. chatwoot/chatwoot

| Point                         | Assessment                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable functionality        | Shared inbox, channel connectors (email, WhatsApp, web chat), agent assignment.                                                                                |
| Stack compatibility           | Ruby on Rails with Redis and Sidekiq plus Postgres; the Rails/Redis/Sidekiq stack is stated in the lead's brief and was not re-read from the repository.       |
| Version reviewed              | v4.18.0 (shown `18 Sep 00:02`).                                                                                                                                |
| Licence and SaaS implications | "MIT Expat" outside the `enterprise/` directory, which has its own licence (`enterprise/LICENSE`, not read).                                                   |
| Cloud, local or hybrid        | Own multi-process stack per installation.                                                                                                                      |
| Mac mini resources            | Three extra services (app, worker, Redis); not measured.                                                                                                       |
| Security and maintenance risk | Creates a second authoritative message store, which breaks "OPENTRADIE owns canonical communications". Webhook and API sync would be another conflict surface. |
| Custom development avoided    | L for multi-channel inbox, but OPENTRADIE needs only email and one messaging channel at first, tied to jobs and approvals.                                     |
| Integration method            | None. Reference its conversation, inbox and delivery-status model.                                                                                             |
| Phase                         | n/a                                                                                                                                                            |
| Decision                      | **REJECT/DEFER** ([ADR 0015](adr/0015-native-communications-model-no-chatwoot.md)).                                                                            |

### 18. activepieces/activepieces

| Point                         | Assessment                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable functionality        | No-code automation with many connectors.                                                                                                                              |
| Stack compatibility           | TypeScript; separate server and database.                                                                                                                             |
| Version reviewed              | 0.92.3 (shown `12 Oct`).                                                                                                                                              |
| Licence and SaaS implications | "MIT Expat" outside `packages/ee/` and `packages/server/api/src/app/ee`, which follow `packages/ee/LICENSE` (not read).                                               |
| Cloud, local or hybrid        | Own self-hosted service.                                                                                                                                              |
| Mac mini resources            | Not measured.                                                                                                                                                         |
| Security and maintenance risk | Third-party flows could write into business records if allowed; if ever used, it may only call narrow, authenticated OPENTRADIE endpoints and never be authoritative. |
| Custom development avoided    | S to M for rare connectors.                                                                                                                                           |
| Integration method            | None now. Possible later for non-critical notifications.                                                                                                              |
| Phase                         | Deferred                                                                                                                                                              |
| Decision                      | **DEFER.**                                                                                                                                                            |

### 19. postgres/postgres

| Point                         | Assessment                                                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable functionality        | Authoritative database: transactions, constraints, `SKIP LOCKED`, full-text search, row-level features.                                                                                                                                 |
| Stack compatibility           | Already used (`pg` 8.23.1, hand-written SQL migrations).                                                                                                                                                                                |
| Version reviewed              | Tags page: `REL_18_6` (2026-08-11) newest stable, `REL_17_11`, `REL_16_15` (2026-08-10); `REL_19_RC1` (2026-10-12) is a release candidate. Repo development uses embedded PostgreSQL 17.6; CI PostgreSQL versions are not re-read here. |
| Licence and SaaS implications | PostgreSQL Licence (permissive; "Portions Copyright (c) 1996-2026, PostgreSQL Global Development Group").                                                                                                                               |
| Cloud, local or hybrid        | All profiles.                                                                                                                                                                                                                           |
| Mac mini resources            | Light for a sole-trader dataset; unmeasured.                                                                                                                                                                                            |
| Security and maintenance risk | Minor-version patching and major-version upgrades are an operator task. Migration checksums prevent edits to applied files.                                                                                                             |
| Custom development avoided    | Not applicable (already in use).                                                                                                                                                                                                        |
| Integration method            | Existing.                                                                                                                                                                                                                               |
| Phase                         | Existing                                                                                                                                                                                                                                |
| Decision                      | **USE (authoritative).**                                                                                                                                                                                                                |

### 20. restic/restic

| Point                         | Assessment                                                                                                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable functionality        | Encrypted, deduplicated, incremental backups to local disk, SFTP, S3 and others (via rclone).                                                                                                                                |
| Stack compatibility           | Single Go binary, run by the operator or a scheduled job; no library coupling.                                                                                                                                               |
| Version reviewed              | v0.19.1 (changelog date 2026-07-05).                                                                                                                                                                                         |
| Licence and SaaS implications | BSD-2-Clause ("Copyright (c) 2014, Alexander Neumann").                                                                                                                                                                      |
| Cloud, local or hybrid        | All.                                                                                                                                                                                                                         |
| Mac mini resources            | Light; unmeasured.                                                                                                                                                                                                           |
| Security and maintenance risk | Repository password loss means data loss; keep it outside the repository and the database. Restore tests are needed. Existing in-repo logical backup (`packages/platform/src/backup.ts`) remains the application-level path. |
| Custom development avoided    | M for encrypted incremental file backup and retention.                                                                                                                                                                       |
| Integration method            | Operator-run service via a script in `deployments/`; backs up a logical dump plus the file-store directory. Not linked into the API.                                                                                         |
| Phase                         | Phase 7                                                                                                                                                                                                                      |
| Decision                      | **SERVICE.**                                                                                                                                                                                                                 |

### 21. rclone/rclone

| Point                         | Assessment                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| Reusable functionality        | Sync to many cloud storages; usable as a restic backend.                                      |
| Stack compatibility           | Go binary run by the operator.                                                                |
| Version reviewed              | v1.75.2 (shown `09 Oct 11:03`).                                                               |
| Licence and SaaS implications | MIT ("Copyright (C) 2012 by Nick Craig-Wood").                                                |
| Cloud, local or hybrid        | Optional offsite copy.                                                                        |
| Mac mini resources            | Light; unmeasured.                                                                            |
| Security and maintenance risk | Credentials for remotes live in the operator's rclone config, not in the repository.          |
| Custom development avoided    | S (S3 is already supported natively by the file store; rclone helps for non-S3 destinations). |
| Integration method            | Optional operator-run script.                                                                 |
| Phase                         | Phase 7 (optional)                                                                            |
| Decision                      | **SERVICE (optional).**                                                                       |

### 22. fullcalendar/fullcalendar

| Point                         | Assessment                                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable functionality        | Day, week, month and list calendar views with drag and drop in the PWA.                                                                                                           |
| Stack compatibility           | React 19 in range (`@fullcalendar/react` peer `^17                                                                                                                                |     | ^18 |     | ^19`). v7 core packages have peer dependencies on `temporal-polyfill ^1.0.1`and`@full-ui/headless-calendar` (both observed in metadata). |
| Version reviewed              | `@fullcalendar/react` and `core` 7.1.3 (repo release v7.1.3 shown `16 Oct 03:03`); `daygrid` and `timegrid` 6.1.22 (MIT); `resource-timeline` 6.1.22 `SEE LICENSE IN LICENSE.md`. |
| Licence and SaaS implications | MIT ("Copyright (c) 2026 Adam Shaw") for the standard packages. The Scheduler/resource views are premium and must not be used. v7 premium split **unverified** (finding 2).       |
| Cloud, local or hybrid        | Client-side only.                                                                                                                                                                 |
| Mac mini resources            | None (browser).                                                                                                                                                                   |
| Security and maintenance risk | Bundle size on mobile and timezone handling (store UTC, render Pacific/Auckland). A mobile-first agenda list may be sufficient for phone; the calendar grid may be desktop-only.  |
| Custom development avoided    | M: calendar grid, drag and drop, recurrence display.                                                                                                                              |
| Integration method            | npm packages in `apps/web`; events from `appointments` via the API.                                                                                                               |
| Phase                         | Phase 6                                                                                                                                                                           |
| Decision                      | **USE (MIT packages only).** Pin only after a licence check of every transitive `@fullcalendar/*` package.                                                                        |

### 23. calcom/cal.diy

| Point                         | Assessment                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable functionality        | Booking-page and availability concepts. README describes it as a self-hosted fork of Cal.com with enterprise and commercial code removed. |
| Stack compatibility           | Next.js, tRPC, Prisma, Turborepo, Yarn. Not compatible with Fastify plus SQL migrations.                                                  |
| Version reviewed              | No release listed on the page; the last commit date was not shown. Unverified.                                                            |
| Licence and SaaS implications | MIT ("Copyright (c) 2020-present Cal.com, Inc."). Permissive, though Daily.co integration and other services have their own terms.        |
| Cloud, local or hybrid        | Own application stack.                                                                                                                    |
| Mac mini resources            | Not measured.                                                                                                                             |
| Security and maintenance risk | Large, fast-moving codebase; adopting it would add a second scheduler.                                                                    |
| Custom development avoided    | None; concept input for availability rules (S).                                                                                           |
| Integration method            | None.                                                                                                                                     |
| Phase                         | Phase 6 concept input                                                                                                                     |
| Decision                      | **REFERENCE only.**                                                                                                                       |

### 24. PaddlePaddle/PaddleOCR

| Point                         | Assessment                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| Reusable functionality        | OCR for photographed supplier invoices and receipts.                                                     |
| Stack compatibility           | Python and PaddlePaddle; heavy. Sidecar only.                                                            |
| Version reviewed              | v3.7.0 (2026.6.11).                                                                                      |
| Licence and SaaS implications | Apache-2.0.                                                                                              |
| Cloud, local or hybrid        | Local or hosted sidecar.                                                                                 |
| Mac mini resources            | Not measured; the Python and model footprint is large relative to the value at this stage.               |
| Security and maintenance risk | Untrusted images into a native-code Python parser; needs sandboxing.                                     |
| Custom development avoided    | L for OCR, but not needed for the first slices; native PDF/email text extraction covers the first cases. |
| Integration method            | Future `DocumentExtractor` adapter.                                                                      |
| Phase                         | Deferred (after Phase 7)                                                                                 |
| Decision                      | **DEFER.**                                                                                               |

### 25. microsoft/markitdown

| Point                         | Assessment                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| Reusable functionality        | Convert Office files, PDFs and other documents to Markdown for model input.                          |
| Stack compatibility           | Python package.                                                                                      |
| Version reviewed              | v0.1.8 (shown `21 Sep 21:22`).                                                                       |
| Licence and SaaS implications | MIT ("Copyright (c) Microsoft Corporation").                                                         |
| Cloud, local or hybrid        | Sidecar.                                                                                             |
| Mac mini resources            | Not measured.                                                                                        |
| Security and maintenance risk | Pre-1.0 (0.x) API; parses untrusted files; converts to model input, so treated as untrusted content. |
| Custom development avoided    | S to M for document-to-text; plain PDF text and email parsing are enough initially.                  |
| Integration method            | Future `DocumentExtractor` adapter.                                                                  |
| Phase                         | Deferred                                                                                             |
| Decision                      | **DEFER.**                                                                                           |

All 25 candidates named in the task are covered (the task text says 24, but its list has 25 entries).
