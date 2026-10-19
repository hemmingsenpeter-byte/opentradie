# OPENTRADIE engineering instructions

Build the enquiry → job → quote → approval vertical slice before adding integrations.
Use one codebase, one PostgreSQL schema, one authoritative database and one isolated OpenClaw Gateway per business installation. Never modify private OpenClaw runtime state.
All prices come from owner-approved rate records. Integer money arithmetic, server authorisation, tenant-scoped queries and auditable mutations are mandatory.
Treat all model output and incoming content as untrusted. Agents propose; backend validates; owners approve. No agent send, approval, shell or database tools.
LOCAL_ONLY fails closed for hosted inference and embeddings. No automatic fallback. Never log message bodies, credentials, prompts, or provider responses.
Run pnpm format:check, lint, typecheck, test, build and PostgreSQL/Playwright checks for changed behaviour. Ordinary CI uses mock inference, real PostgreSQL.
Do not claim real provider integration, production readiness or cloud deployment without evidence. Record significant decisions in docs/adr/. Keep docs accurate.
This repository is proprietary pending the owner's licence decision; do not add a public distribution licence autonomously.
