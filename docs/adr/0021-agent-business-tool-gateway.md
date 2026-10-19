# ADR 0021: Agent business tool gateway (proposals over MCP)

- Status: Accepted
- Date: 2026-10-19
- Amends: [ADR 0002](0002-openclaw-gateway-client-only-agent-runtime.md) ("The agent receives no business tools in v0.1")

## Context

ADR 0002 kept OpenClaw as a Gateway client only and gave the agent no business tools in v0.1, leaving an extension point open. Phase 4 (AI operator foundations) needs the agent to look up customers and jobs and to suggest work records (notes, time, materials, status changes, draft quotes and messages) without weakening the rules in `AGENTS.md`: agents propose, the backend validates, owners approve; no agent send, approve, shell or database tools; prices only from owner-approved rates.

OpenClaw documents an MCP client: `mcp.servers` entries with a Streamable HTTP `url` and `toolFilter.include/exclude`, with MCP tools subject to the normal tool policy ([open-source-assessment.md](../open-source-assessment.md), finding 6). How a remote server's auth header is configured, and how `toolFilter` composes with the global tool policy, are not confirmed.

## Decision

1. **Tools are exposed only through an MCP endpoint hosted by the API**, `POST /agent-tools/mcp` (Streamable HTTP transport, JSON responses, no server-initiated stream; `GET` answers 405). It implements `initialize`, `ping`, `tools/list` and `tools/call`, issues an `Mcp-Session-Id` (stored hashed in `agent_sessions`) and rejects a foreign `Origin`. It is a small in-repo JSON-RPC implementation, not the MCP SDK server, so the runtime adds no web framework (the SDK's server transport pulls in Express and Hono). `@modelcontextprotocol/sdk` 1.32.0 (MIT) is a **dev dependency only**, used by the integration test as the client.
2. **Authentication** is one per-installation bearer secret, `AGENT_TOOL_TOKEN` (>= 32 characters), compared in constant time on SHA-256 digests. Unset means the endpoint answers 503 (disabled). It is never persisted; if it ever is, only a hash is stored. The tenant is the runtime's tenant (ADR 0006), never a tool argument. The route has its own rate limit (120 calls per minute).
3. **Registry** (`packages/core/src/agent-tools.ts`): every tool has a strict Zod input schema, a risk class (`read` or `propose`), a required role, money and customer-facing flags, and an approval policy. Read tools: `customer.find`, `customer.get`, `job.find`, `job.get` (bounded, provenance-labelled context with a timeline summary), `quote.get`, `rates.list` (codes, labels and units, no prices), `payment.status` (always `not_available` until invoices exist). Propose tools: `customer.create`, `job.create`, `job.update_status`, `job.add_note`, `job.record_time`, `job.add_material`, `quote.prepare`, `invoice.prepare`, `communication.draft`, `reminder.create`. `schedule.availability` is not exposed until the scheduling module exists. No tool sends, approves, rejects, deletes, exports, or touches the shell, files or database.
4. **No agent prices.** Any key that looks like money (price, amount, total, cost, tax, GST, discount, markup, cents, fee, charge) is refused with `PRICE_FIELD_REFUSED` at any depth. Labour is an approved hourly rate code and a quantity in thousandths of an hour. A material may carry `reportedUnitCostCents`, a _reported supplier cost_: the sell price is computed by core pricing from that cost and a markup the owner enters when approving. Owner edits to a payload pass the same checks.
5. **Propose tools only create `action_proposals`**, with a server-written summary, clarification questions (from the agent and from server checks), and a per-tenant idempotency key: the agent's `idempotencyKey`, or a hash of tool, payload, session and day. Replays return the existing proposal; the same key with a different payload is a conflict.
6. **Owners approve.** `POST /api/proposals/:id/approve` (owner session, `Idempotency-Key`, optional edited payload) runs the deterministic domain command in one transaction with audit events, a job timeline entry and the proposal marked `executed`. Re-approval returns the same result. A domain refusal (for example a status transition that is no longer valid) rolls back the command and records the proposal as `failed` with its reason. `POST /api/proposals/:id/reject` needs a reason. `invoice.prepare` and `reminder.create` stay pending with `EXECUTOR_NOT_AVAILABLE` until invoicing and scheduling exist.
7. **Approval policy** defaults to owner approval for every proposal. The only exception an owner may enable is auto-execution of `job.add_note` (stored in `agent_tool_policies`; a database CHECK refuses anything else). Auto-executed notes keep `inferred` provenance; notes the owner approves become `verified`.
8. **Logging**: every `tools/call` writes `agent_tool_calls` (tool, outcome, error code, duration, SHA-256 of the input, and a redacted copy where every free-text string is replaced by its length). No message bodies, prompts or model output are logged.

## OpenClaw configuration (not verified against a live Gateway)

The intended Gateway entry, composed from documented keys; the `headers` key and the exact tool-name prefixing are assumptions to verify:

```json5
{
  mcp: {
    servers: {
      opentradie: {
        url: 'http://127.0.0.1:3000/agent-tools/mcp',
        headers: { Authorization: 'Bearer ${AGENT_TOOL_TOKEN}' }, // verify: header support and secret interpolation
        toolFilter: {
          include: [
            'customer.find',
            'customer.get',
            'job.find',
            'job.get',
            'quote.get',
            'rates.list',
            'payment.status',
            'customer.create',
            'job.create',
            'job.update_status',
            'job.add_note',
            'job.record_time',
            'job.add_material',
            'quote.prepare',
            'invoice.prepare',
            'communication.draft',
            'reminder.create',
          ],
        },
      },
    },
  },
}
```

**Live OpenClaw verification: NOT done.** Only the MCP SDK client in `tests/integration/agent-tools.test.ts` has called this endpoint. Before relying on it, prove against a real Gateway: the header configuration, that `toolFilter` composes with the denied built-in tool groups, and that the agent cannot reach any other tool.

## Consequences

- The backend remains the only authority over records and money; the agent's reach is reads and suggestions.
- A second agent channel (the in-app `POST /api/jobs/:id/assistant-actions`, using the mock planner) goes through the same registry and proposals.
- New migration `0007` (sessions, call log, proposals, policies, `job_time_entries`, `job_materials`, three timeline event types). Time and materials feed invoicing later; labour price is resolved from the referenced approved rate at invoicing time.
- The endpoint must stay reachable only from the installation's Gateway (loopback or private network); the bearer token is the only credential.
