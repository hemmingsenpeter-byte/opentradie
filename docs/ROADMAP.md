# Roadmap

Phases A to E from the brief are delivered through twelve milestones. Each milestone is a GitHub issue (see `.github/opentradie-issues.json`). Current status is in the README; "TBD at merge" items are reconciled by the integrator.

| #   | Milestone                | Scope                                                                                 | v0.1 status                                                          |
| --- | ------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | Portable foundation      | Workspaces, schema, auth, tenant scope, CI, docs, ADRs                                | In progress; see README                                              |
| 2   | OpenClaw integration     | Gateway client adapter, mock, smoke procedure, tools-denied Gateway guidance          | Adapter written; real operation unproven until the smoke test is run |
| 3   | Business data and memory | Customers, jobs, notes, search, knowledge items with provenance, optional embeddings  | Partly scaffolded                                                    |
| 4   | Quote workflow           | Enquiry, job, deterministic draft quote, approval, audit                              | The first vertical slice; TBD at merge                               |
| 5   | Local deployment         | Mac mini guide, launchd, Ollama                                                       | Scaffolded; unverified on hardware                                   |
| 6   | Cloud deployment         | Image, Compose, managed Postgres, S3, HTTPS                                           | Scaffolded; never deployed                                           |
| 7   | Hybrid connectivity      | Relay contracts, tunnel/relay options, single-authority guards                        | Guards scaffolded; relay Planned                                     |
| 8   | Email integration        | Normalised inbound, drafts, approval before send, Gmail OAuth                         | Planned                                                              |
| 9   | Xero integration         | AccountingProvider, test adapter first, Xero only with credentials and real API tests | Planned                                                              |
| 10  | Speech interface         | Contracts, whisper.cpp, iOS Shortcuts                                                 | Planned                                                              |
| 11  | Security hardening       | Audit of controls, MFA, log-redaction tests, secret scanning, external review         | Planned                                                              |
| 12  | Migration tooling        | Automated version of the 11-step procedure                                            | Planned (backup/restore test only in v0.1)                           |

Not in scope for v0.1: multi-tenant orchestration, billing, public relay, marketplace, mobile apps. Licence: undecided ([ADR 0009](adr/0009-licence-pending-public-source.md)).
