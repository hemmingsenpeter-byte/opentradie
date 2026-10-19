# OpenClaw integration

OPENTRADIE uses [OpenClaw](https://github.com/openclaw/openclaw) as its only agent runtime, as a **client of the Gateway WebSocket protocol** ([ADR 0002](adr/0002-openclaw-gateway-client-only-agent-runtime.md)). Facts below come from the official docs at docs.openclaw.ai read on 2026-10-19 and from `pnpm view`. OpenClaw changes quickly: re-check the docs for the version you install. Anything marked "verify" was not confirmed.

## Status

| Item                                                             | Status                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `AgentRuntime` interface, `MockAgentRuntime`                     | Implemented; mock is **not** evidence of real integration                      |
| `RealOpenClawAgentRuntime` against an injected fake connection   | Implemented and unit-tested (TBD at merge)                                     |
| `RealOpenClawAgentRuntime` against a real Gateway and real model | **Not verified** until you run the smoke procedure below and record the result |
| Business tools exposed to the agent                              | Not implemented by design (agent returns a proposal only)                      |

## Version pinning

`packages/agent/package.json` pins `@openclaw/gateway-client` and `@openclaw/gateway-protocol` to exactly `2026.8.1`; the official gateway-clients guide currently names `2026.8.1` as the pinned release for these packages and says to upgrade client and Gateway together. On 2026-10-19 npm listed later releases (dist-tag `latest` was `2026.10.5`, `extended-stable` `2026.9.33`; check with `pnpm view @openclaw/gateway-client versions dist-tags`). The packages report licence MIT and `node >=22.19.0`.

Upgrade procedure: read the OpenClaw changelog, install the new Gateway on a staging host, bump both packages together in the pnpm catalog or `packages/agent`, check the protocol version (the docs state wire version `4` and that a bump is breaking), run unit tests, then the smoke procedure. Dependabot ignores `@openclaw/*` on purpose.

## What the adapter does

Connects as `role: operator` with scopes `operator.read` and `operator.write`, advertises no optional capabilities, and uses the documented methods `chat.send`, `chat.abort`, `chat.history` and `health`. Device identity (Ed25519) and device tokens are stored in an OPENTRADIE-owned file (`OPENCLAW_DEVICE_PATH`, mode 0600). It never reads `~/.openclaw`. It treats the model's reply as untrusted text that must parse into a strict proposal schema.

## Run a locked-down Gateway (per business)

OpenClaw's trust model supports **one trust boundary per Gateway** (one operator or a mutually trusting team). Do not share a Gateway between businesses. Operator access is a control-plane role, not tenant isolation, and `sessionKey` is a routing selector, not an authorisation token.

1. Install OpenClaw from the official instructions on a dedicated OS user or host. Keep the Gateway bound to loopback (documented default for host installs; container images default to an exposed bind, so require auth if you containerise).
2. Configure shared authentication with `openclaw configure --section gateway` (documented). Do not hand-edit tokens into `openclaw.json`.
3. Create a dedicated agent with **tools denied**. Documented facts: `tools.profile` accepts `minimal`, `coding`, `messaging`, `full`; allow/deny are evaluated after the profile and deny wins; `*` wildcards are supported; global denies apply even without sandboxing. Defaults are permissive for a trusted single operator (host exec without prompts, `tools.sessions.visibility` of `all`, `tools.agentToAgent.enabled` of `true`). A starting point composed from those documented keys (verify against your version before relying on it):

   ```json5
   {
     tools: {
       profile: 'minimal',
       deny: [
         'group:runtime',
         'group:fs',
         'group:web',
         'group:ui',
         'group:automation',
         'group:messaging',
         'group:nodes',
         'group:plugins',
         'group:agents',
       ],
       sessions: { visibility: 'self' },
       agentToAgent: { enabled: false },
     },
   }
   ```

   `minimal` still lists `session_status` and a gateway update tool per the docs; confirm the effective policy with `openclaw policy` and run `openclaw security audit`, resolving every warning. Do not enable channels (WhatsApp and others) on this Gateway unless you have separately reviewed that exposure.

4. Start the Gateway and keep it local. Never publish its port; reach it only from the OPENTRADIE API host.

## Pair the OPENTRADIE device

1. Set `OPENCLAW_URL=ws://127.0.0.1:18789`, `OPENCLAW_TOKEN=<shared token>`, `OPENCLAW_DEVICE_PATH=.data/openclaw-device.json` and `AGENT_MODE=openclaw`.
2. Start the API (or run the smoke script). The first connection creates the device identity and the Gateway answers `PAIRING_REQUIRED` with a request ID.
3. On the Gateway host: `openclaw devices list`, then `openclaw devices approve <requestId>`.
4. Reconnect. The adapter stores the returned device token in the device file.
5. Rotate or revoke later with `openclaw devices rotate ...` / `openclaw devices revoke --device <id> --role operator`.

## Configure a model provider (on the Gateway, not in OPENTRADIE)

OPENTRADIE hardcodes no model names. The Gateway's configuration decides which provider receives prompts, so it must match the privacy mode ([PRIVACY.md](PRIVACY.md)).

- **Ollama (local).** Use Ollama's native API: base URL `http://127.0.0.1:11434` with **no `/v1` suffix** (the docs say `/v1` breaks tool calling). The config key is `baseUrl`. Exact commands and model-ref format are on docs.openclaw.ai/providers/ollama/setup (verify; not fetched in full). For `LOCAL_ONLY`, configure no hosted fallback models.
- **OpenRouter (hosted).** `openclaw onboard --auth-choice openrouter-api-key` (or `openrouter-oauth`); the key is read from `OPENROUTER_API_KEY`; model refs look like `openrouter/<provider>/<model>`, set with `openclaw models set ...`. Only for installs with `PRIVACY_MODE=APPROVED_CLOUD` and `MODEL_LOCATION=hosted`.

## Repeatable smoke verification

The smoke sends only synthetic fixtures ("Mrs Johnson needs two power points replaced") and never reads the business database. It may cost money with a hosted provider.

Local:

```sh
export OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
export OPENCLAW_GATEWAY_TOKEN=...            # shared Gateway token
export OPENCLAW_DEVICE_STATE_PATH=.data/openclaw-device.json
pnpm test:openclaw
```

Expected output: a `real-gateway-health` line with status `ok` and the Gateway version, then `real-gateway-interpretation` with `passed: true`. Record in your notes: date, OpenClaw Gateway version, client version, provider and model, and the result. Until a run is recorded, describe the integration as "implemented, not integration-tested".

CI: the opt-in `openclaw-smoke` workflow (workflow_dispatch) uses repository secrets `OPENCLAW_URL`, `OPENCLAW_TOKEN` and `OPENCLAW_DEVICE_STATE_JSON` (the contents of an already-approved device file), plus optional `OPENCLAW_AGENT_ID`. It skips with a notice if they are absent. A GitHub-hosted runner must be able to reach your Gateway, which conflicts with keeping it on loopback: use a self-hosted runner on the same network or a tunnel you control, and weigh that exposure. The script's exact variable names are owned by the backend lane (TBD at merge); the workflow exports both the `OPENCLAW_*` and `OPENCLAW_GATEWAY_*` names.

## Embedding option not used

OpenClaw documents embedding by supervising the `openclaw` executable as a child process. OPENTRADIE does not supervise or bundle it: the Gateway is an independently operated service, which keeps its lifecycle and configuration isolated from business services.

## Never

Read or modify OpenClaw's private files, SQLite databases, transcripts or caches; fork or patch it; import Plugin SDK subpaths from the app; give the agent shell, filesystem, database or send/approve tools.
