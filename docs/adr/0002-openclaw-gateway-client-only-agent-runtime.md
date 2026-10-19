# ADR 0002: OpenClaw through the Gateway client is the only agent runtime

- Status: Accepted (amended by [ADR 0021](0021-agent-business-tool-gateway.md): business tools now exist, as validated proposals over an MCP endpoint)
- Date: 2026-10-19

## Context

The product needs an agent that interprets requests and proposes work. OpenClaw is an externally versioned runtime that documents a Gateway WebSocket protocol and publishes `@openclaw/gateway-client` and `@openclaw/gateway-protocol`. Its docs state that the Gateway owns OpenClaw state and that external apps should not read or change files under `~/.openclaw`.

## Decision

Integrate only as a Gateway client, behind an `AgentRuntime` interface with `RealOpenClawAgentRuntime` and `MockAgentRuntime`. Pin the client and protocol packages to the same exact version (2026.8.1 at the time of writing) and upgrade them together with the Gateway. Do not use the Plugin SDK, do not read OpenClaw private state, do not fork it, and do not add a second agent framework. The agent receives no business tools in v0.1: it returns a proposal that the backend validates, prices deterministically and presents for owner approval.

## Consequences

- A mock that is never presented as proof of real integration keeps CI free of paid inference.
- Real operation is proven only by the opt-in smoke procedure in docs/OPENCLAW_INTEGRATION.md.
- Upgrades are deliberate and need a compatibility check against a real Gateway.
- If narrow business tools are added later, they go through a documented extension point and the backend remains the authority.
