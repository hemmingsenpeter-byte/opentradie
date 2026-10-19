# New customer cloud install — operator guide

This is the procedure for setting up OPENTRADIE in the cloud **for** a customer who has no technical knowledge, then handing it over so they run it on their own.

**The model:**

- The customer **owns and pays for** everything that runs, in their own Render and OpenRouter accounts.
- You do the setup inside their accounts, hand over, then **remove your access**.
- They can re-invite you if they want help later, as a paid support job.
- You never handle their card details or keep their API keys.

Each install is a separate, isolated copy of OPENTRADIE: its own web app, OpenClaw gateway, database and secrets. Customers never share anything.

## Readiness: what works today and what doesn't

Some steps depend on code that is not built yet. **Do not onboard a paying customer until every row says Ready.**

| Capability                                                          | Status                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| App runs from the `Dockerfile` with `MIGRATE_ON_START=true`         | Needs verification: the Docker image has never been built          |
| Render Blueprint (`render.yaml`) for web + gateway + database       | Needs build                                                        |
| OpenClaw gateway as a private Render service, using OpenRouter      | Needs build and a first real `pnpm test:openclaw` run              |
| `provision:tenant` that creates the business, owner and their rates | Needs build: today's seed only creates the synthetic demo business |
| Owner set-password / reset link                                     | Needs build: passwords currently come from environment variables   |
| Rates screen, so the owner can change prices                        | Needs build: rates are read-only in the app                        |
| Privacy mode `APPROVED_CLOUD`, real quote workflow                  | Ready in code; not yet run against a real model                    |
| Customer licence template, service agreement                        | Needs a lawyer (see [Paperwork](#paperwork))                       |

## Phase 0 — Before the call (you, 15 min)

1. Send the customer the [onboarding checklist](CUSTOMER_ONBOARDING.md) and the [rates sheet](rates-template.csv).
2. Agree on a subdomain, e.g. `smithelectrical.opentradie.co.nz`, or use their own domain.
3. Send the customer licence and service agreement for signature. **Nothing is installed before both are signed.**
4. Start an [install record](install-record-template.md) for them. It must contain no passwords or keys.

## Phase 1 — Customer creates their accounts (on a screen-share, about 15 min)

They type, you guide. Never take their card details or passwords.

1. **Render:** they sign up at render.com with their business email, add their card under Billing, and turn on **billing alerts**.
2. **Render workspace access:** they invite you as a workspace member (Workspace settings → Members). Check at the time whether Render requires a paid workspace plan to add members; if so, it is their cost.
3. **OpenRouter:** they sign up at openrouter.ai, add credit or a card, and set a **monthly spending limit** they are comfortable with.
4. **OpenRouter key:** they create an API key named `opentradie-gateway` and keep the page open. In Phase 2 they paste it **themselves** into the gateway's secret field in Render, so it goes straight into their account and you never see or copy it.

## Phase 2 — You build their install (about 30 min)

Work in **their** Render workspace.

1. **Deploy the Blueprint:** in Render choose New → Blueprint, connect the OPENTRADIE repository and choose the **release tag** you have tested (e.g. `v0.1.0`), not `main`. This creates:
   - `opentradie-web`: Docker web service, public, HTTPS.
   - `opentradie-gateway`: private service running the OpenClaw gateway with tools denied and its own token.
   - `opentradie-db`: Render Postgres with pgvector.
   - Choose the region at this step and record it. Render has no NZ region; Singapore is usually closest. The customer must be told where their data is stored.
2. **Secrets:** the Blueprint generates `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_KEY` and `OPENCLAW_TOKEN`. The customer pastes their OpenRouter key into the gateway's secret field (Phase 1, step 4).
3. **Settings** on `opentradie-web`:
   - `DEPLOYMENT_PROFILE=cloud`
   - `PRIVACY_MODE=APPROVED_CLOUD`
   - `AGENT_MODE=openclaw`
   - `OPENCLAW_INFERENCE_LOCATION=hosted`
   - `MIGRATE_ON_START=true`
   - `APP_ORIGIN=https://<their subdomain>`
   - `AUTHORITATIVE_RUNTIME=true`
4. **Domain:** add the custom domain to `opentradie-web` in Render, then create the DNS record Render shows you.
5. **Load their business:** run `pnpm provision:tenant` (not built yet) with their business name, GST status, owner email and `rates.csv`. Before you do, check every rate on the sheet with them. **Never fill in a missing price yourself.**
6. **Backups:** on the database, confirm the plan includes daily backups or point-in-time recovery, and record which in the install record.

## Phase 3 — Verify (10 min)

- [ ] `https://<subdomain>/health` shows `status: ok`, profile `cloud`, privacy `APPROVED_CLOUD`, agent mode not `mock`, and database ok.
- [ ] The OpenClaw smoke test passes against their gateway.
- [ ] Sign in with a temporary operator check account, run one test enquiry end to end, and confirm the quote uses **their** rates. Then delete the test quote and the check account.
- [ ] The gateway has no public URL.
- [ ] Render billing alerts are on, and the OpenRouter spending limit is set.

## Phase 4 — Hand over and leave (15 min)

1. Send the owner their **set-password link** (not built yet). They choose their own password; you never know it.
2. Walk them through the [customer guide](CUSTOMER_GUIDE.md): adding the app to their phone, the Mrs Johnson-style workflow, approving quotes.
3. Make sure they know these three things:
   - **Their card pays the hosting.** If payment fails, the app stops.
   - **The spending limit caps AI costs.** If AI replies stop, the limit may have been reached.
   - **Who to contact for help** (you, as a paid job) and how to re-invite you.
4. **Remove yourself** from their Render workspace, or have them remove you while you watch. Record the date.
5. Close the install record: release tag, region, backup plan, handover date, access removed.

## After handover

- **Updates are optional and paid.** The install stays pinned to its release tag and never updates on its own. To update, the customer re-invites you; you change the tag, redeploy, run Phase 3, then leave again.
- **Security fixes:** if a release fixes a security problem, contact every customer and offer the update. Keep a list of customers and their tags (your install records) for this.
- **Offboarding:** the customer owns the accounts. To stop, they export their data (needs an export feature, not built yet), then delete the Render services and the OpenRouter key.

## Paperwork

These are needed before the first customer. They are not code, and a New Zealand lawyer should draft or review them:

- **Customer licence:**
  - grants the right to run OPENTRADIE in the customer's own accounts;
  - non-transferable, for their business only;
  - covers the installed version;
  - updates by separate agreement.
- **Service agreement:**
  - covers your setup fee, optional support and updates;
  - says the customer owns and pays for the infrastructure;
  - says your access ends at handover.
- **Privacy notice for the customer:**
  - where their data is stored (the Render region);
  - that enquiry text goes to an AI model via OpenRouter (privacy mode `APPROVED_CLOUD`);
  - that you do not keep copies.
