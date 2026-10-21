# OpenClaw integration

OPENTRADIE uses [OpenClaw](https://github.com/openclaw/openclaw) as its only agent runtime, as a **client of the Gateway WebSocket protocol** ([ADR 0002](adr/0002-openclaw-gateway-client-only-agent-runtime.md)). Facts below come from the official docs at docs.openclaw.ai read on 2026-10-19 and from `pnpm view`. OpenClaw changes quickly: re-check the docs for the version you install. Anything marked "verify" was not confirmed.

## Status

| Item                                                                                                            | Status                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentRuntime` interface, `MockAgentRuntime`                                                                    | Implemented; mock is **not** evidence of real integration                                                                                                                                                                                                                                       |
| `RealOpenClawAgentRuntime` against a fake gateway and the protocol schema                                       | Implemented and tested (`packages/agent/src/agent.test.ts`)                                                                                                                                                                                                                                     |
| `RealOpenClawAgentRuntime` against a real Gateway and real model                                                | **Not verified** until you run the smoke procedure below and record the result                                                                                                                                                                                                                  |
| Message triage (`triageMessage`, ADR 0022) and voice extraction (`extractVoiceNote`, ADR 0024) over the Gateway | Implemented and tested against a fake Gateway (`packages/agent/src/openclaw-structured.test.ts`, `tests/security/inbox-injection.test.ts`, `tests/integration/voice-notes.test.ts`); **Implemented, not integration-tested** with a live Gateway and model: live verification has not been done |
| Business tool gateway (`/agent-tools/mcp`, [ADR 0021](adr/0021-agent-business-tool-gateway.md))                 | Implemented and tested with the MCP SDK client (`tests/integration/agent-tools.test.ts`); **not verified with a live OpenClaw Gateway**. Propose tools only create owner-approved proposals                                                                                                     |
| Inference location                                                                                              | An operator attestation (`OPENCLAW_INFERENCE_LOCATION`); the Gateway cannot prove where inference runs. With `OPENCLAW_MODEL_PROVIDER` left at `unconfigured` the location is `unverified` and `LOCAL_ONLY` blocks it                                                                           |

## Version pinning

`packages/agent/package.json` pins `@openclaw/gateway-client` and `@openclaw/gateway-protocol` to exactly `2026.8.1`; the official gateway-clients guide currently names `2026.8.1` as the pinned release for these packages and says to upgrade client and Gateway together. On 2026-10-19 npm listed later releases (dist-tag `latest` was `2026.10.5`, `extended-stable` `2026.9.33`; check with `pnpm view @openclaw/gateway-client versions dist-tags`). The packages report licence MIT and `node >=22.19.0`.

Upgrade procedure: read the OpenClaw changelog, install the new Gateway on a staging host, bump both packages together in the pnpm catalog or `packages/agent`, check the protocol version (the docs state wire version `4` and that a bump is breaking), run unit tests, then the smoke procedure. Dependabot ignores `@openclaw/*` on purpose.

## What the adapter does

Selected with `AGENT_MODE=openclaw` (requires `OPENCLAW_TOKEN`; `OPENCLAW_URL`, `OPENCLAW_DEVICE_PATH`, `OPENCLAW_AGENT_ID`, `OPENCLAW_MODEL_PROVIDER` and `OPENCLAW_INFERENCE_LOCATION` configure it). Connects as an operator WebSocket client with `role: operator` with scopes `operator.read` and `operator.write`, advertises no optional capabilities, and uses the documented methods `chat.send`, `chat.abort`, `chat.history` and `health`. Device identity (Ed25519) and device tokens are stored in an OPENTRADIE-owned file (`OPENCLAW_DEVICE_PATH`, mode 0600). It never reads `~/.openclaw`. It treats the model's reply as untrusted text that must parse into a strict proposal schema.

The same client also runs message triage and voice note extraction. Each sends one prompt whose untrusted email or transcript sits between unguessable boundary markers with an instruction that it is data, in a fresh session (`agent:<id>:opentradie:<triage|voice>:<requestId>:<nonce>`). The final reply must be one JSON object (a single fenced block spanning the whole reply is tolerated) and is validated with the same Zod schema as the mock path; anything else is `INVALID_OUTPUT`, nothing partial is used and nothing is retried. The run timeout (`timeoutMs`) applies and aborts the remote run. The calling service applies the privacy policy first, so a denial makes no Gateway call. Prompts, bodies and replies are never logged.

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
- **OpenRouter (hosted).** `openclaw onboard --auth-choice openrouter-api-key` (or `openrouter-oauth`); the key is read from `OPENROUTER_API_KEY`; model refs look like `openrouter/<provider>/<model>`, set with `openclaw models set ...`. Only for installs with `PRIVACY_MODE=APPROVED_CLOUD` (or per-task owner approvals in `APPROVAL_REQUIRED`) and `OPENCLAW_INFERENCE_LOCATION=hosted`.

## Repeatable smoke verification

The smoke sends only synthetic fixtures ("Mrs Johnson needs two power points replaced") and never reads the business database. It may cost money with a hosted provider.

Local:

```sh
export OPENCLAW_URL=ws://127.0.0.1:18789
export OPENCLAW_TOKEN=...                    # shared Gateway token
export OPENCLAW_DEVICE_PATH=.data/openclaw-device.json   # or OPENCLAW_DEVICE_STATE_JSON with the file contents
# optional: OPENCLAW_AGENT_ID, OPENCLAW_MODEL_PROVIDER
pnpm test:openclaw
```

If `OPENCLAW_URL` or `OPENCLAW_TOKEN` is unset the script prints `OpenClaw smoke SKIPPED` and exits 0, which is not evidence of a working integration; set `OPENCLAW_SMOKE_REQUIRED=true` to make that a failure. Expected output on a real run: an `openclaw-gateway-health` JSON line with status `ok` and the Gateway version, then an `openclaw-interpretation` line with `passed: true`. Record in your notes: date, OpenClaw Gateway version, client version, provider and model, and the result. No live-Gateway run has been recorded for this repository. Until one is, describe the integration as "implemented, not integration-tested".

CI: the opt-in `openclaw-smoke` workflow (workflow_dispatch) uses repository secrets `OPENCLAW_URL`, `OPENCLAW_TOKEN` and `OPENCLAW_DEVICE_STATE_JSON` (the contents of an already-approved device file), plus optional `OPENCLAW_AGENT_ID`. It skips with a notice if they are absent. A GitHub-hosted runner must be able to reach your Gateway, which conflicts with keeping it on loopback: use a self-hosted runner on the same network or a tunnel you control, and weigh that exposure. The script reads `OPENCLAW_URL`, `OPENCLAW_TOKEN`, `OPENCLAW_DEVICE_PATH` or `OPENCLAW_DEVICE_STATE_JSON`, and `OPENCLAW_AGENT_ID`. `OPENCLAW_MODEL_PROVIDER` is not passed by the workflow.

## Business tools over MCP (not verified live)

The API hosts a minimal MCP server at `POST /agent-tools/mcp` (Streamable HTTP, JSON responses) for this installation's Gateway ([ADR 0021](adr/0021-agent-business-tool-gateway.md)). Read tools return tenant-scoped, field-minimised data; propose tools create action proposals that the owner approves in the PWA approval inbox (`#/approvals`). No tool sends, approves or sets prices.

1. Generate a random secret of at least 32 characters and set `AGENT_TOOL_TOKEN` for the API. Unset, the endpoint answers 503.
2. Keep the API reachable from the Gateway host only (loopback or private network).
3. Add the server to the Gateway configuration with an allow-list of exactly the OPENTRADIE tools. The snippet in ADR 0021 uses the documented `mcp.servers.<name>.url` and `toolFilter.include`; the `headers` key for the bearer token and how secrets are interpolated are **assumptions to verify** for your OpenClaw version.
4. Keep the tool deny list from the section above. Verify with `openclaw policy` that the business agent sees the OPENTRADIE tools and none of the denied built-in groups (this interplay is unverified).
5. Check the endpoint by hand: `initialize` (returns an `Mcp-Session-Id` header), then `tools/list` with that header and `Authorization: Bearer <token>`.

Record the date, Gateway version and result when you first verify it live. Until then describe the tool gateway as "implemented, not integration-tested" with OpenClaw.

## Embedding option not used

OpenClaw documents embedding by supervising the `openclaw` executable as a child process. OPENTRADIE does not supervise or bundle it: the Gateway is an independently operated service, which keeps its lifecycle and configuration isolated from business services.

## Never

Read or modify OpenClaw's private files, SQLite databases, transcripts or caches; fork or patch it; import Plugin SDK subpaths from the app; give the agent shell, filesystem, database or send/approve tools, or any tool that sets prices.
