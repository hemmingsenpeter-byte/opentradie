# ADR 0034: OpenClaw 2026.10.8 and client-side slash-command neutralisation

- Status: Accepted
- Date: 2026-10-28
- Amends: ADR 0002 (version pin), ADR 0022 and ADR 0024 (how untrusted text reaches the Gateway)

## Context

The client packages were pinned at 2026.8.1 and `chat.send` set `suppressCommandInterpretation: true`
so that untrusted email, transcript and enquiry text could never be parsed by the Gateway as slash
commands or directives.

From Gateway 2026.9 (checked in `extended-stable` 2026.9.35 and `latest` 2026.10.8),
`chat.send` rejects `suppressCommandInterpretation` (and `systemInputProvenance`,
`systemProvenanceReceipt`, explicit origin fields) unless the client has `operator.admin` scope:
`INVALID_REQUEST: system provenance fields require admin scope`. The OpenClaw changelog does not
mention this; it was found from the Gateway log and the `chat-send` handler source.

Without the flag the Gateway acts on directives anywhere in a message from a paired operator. A
live probe on 2026-10-28 (Gateway 2026.10.8, paired OPENTRADIE device with `operator.read` and
`operator.write`) sent `[alpha /think high beta /whoami gamma /model anthropic/claude-haiku-5-5 delta]`:
the Gateway stripped all three and switched the session model ("Model switched to
anthropic/claude-haiku-5-5"). An email containing `/model`, `/exec` or `/elevated` would therefore
change Gateway behaviour.

Options considered:

1. Stay on 2026.8.1. Safe, but blocks every later Gateway release and its fixes.
2. Grant the device `operator.admin`. Rejected: the application would get full control of the
   Gateway, which breaks the least-privilege design of ADR 0002.
3. Drop the flag and neutralise commands in the client. Chosen.

## Decision

1. Pin `@openclaw/gateway-client` and `@openclaw/gateway-protocol` to exactly `2026.10.8`
   (`OPENCLAW_VERSION`); the wire protocol stays at `4`. The Gateway must run the same version.
2. `chat.send` no longer sends `suppressCommandInterpretation`.
3. Every outbound message passes through `neutralizeSlashCommands` (`packages/agent/src/openclaw.ts`)
   at the single `chat.send` call site. A `/` that starts a word (not preceded by a letter, digit,
   `_`, `/`, `:`, `.` or `-`), or that follows a JSON escape (`\n`, `\r`, `\t`), and is followed by
   a letter becomes U+2215 DIVISION SLASH. The model still reads it as a slash; URLs, paths and
   units (`https://x/y`, `./x`, `m/s`) are unchanged. The same live probe with neutralised text
   reached the model verbatim with no directive applied; JSON-escaped directives (`\n/model`) were
   also not applied.
4. Operators should additionally keep the Gateway lockdown in `OPENCLAW_INTEGRATION.md` (tools
   denied), so that a directive that slipped through would have nothing to escalate to.

## Consequences

- Tests: `packages/agent/src/agent.test.ts` and `openclaw-structured.test.ts` assert the flag is
  absent, that `/model`, `/elevated`, `/exec` and `/status` never reach `chat.send` as directives
  (including from the JSON-encoded interpretation prompt) and that URLs and units survive.
- Live: `pnpm test:openclaw` passed on 2026-10-28 against Gateway 2026.10.8 with the Claude CLI
  runtime (Anthropic `claude-sonnet-5-5`, hosted). Triage, voice extraction and the MCP tool
  gateway remain not integration-tested live.
- Neutralisation is a deny-by-pattern defence that depends on OpenClaw's command grammar. Re-run the
  directive probe (Gateway log or `chat.history` shows whether text was stripped) on every Gateway
  upgrade, and prefer a non-admin suppression option if OpenClaw adds one.
- Customer-visible text is unaffected: neutralisation applies only to the prompt sent to the
  Gateway, never to stored messages or outbound communications.
