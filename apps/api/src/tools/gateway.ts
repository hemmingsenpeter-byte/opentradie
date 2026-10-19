import { randomUUID } from 'node:crypto';
import { canonicalHash, parseToolCall, redactToolInput } from '@opentradie/core';
import { transaction, type Database, type Queryable, type Transaction } from '@opentradie/database';
import { HttpError } from '../http.js';
import { createProposal, type ProposalOrigin } from './proposals.js';
import { runReadTool } from './read.js';

export type ToolOutcome =
  | { ok: true; data: Record<string, unknown> }
  | {
      ok: false;
      code: string;
      message: string;
      issues?: Array<{ path: string; message: string }>;
    };

type LoggedOutcome =
  | 'ok'
  | 'proposed'
  | 'auto_executed'
  | 'duplicate'
  | 'invalid_input'
  | 'price_refused'
  | 'unknown_tool'
  | 'not_found'
  | 'conflict'
  | 'error';

export interface ToolInvocation {
  tenantId: string;
  requestId: string;
  sessionId: string | null;
  name: unknown;
  args: unknown;
  origin: Omit<ProposalOrigin, 'sessionId'>;
}

/**
 * The single entry point for agent tool calls (MCP gateway and the in-app assistant planner).
 * Validates with the registry, runs reads tenant-scoped, turns proposals into action proposals,
 * and logs every call to agent_tool_calls with redacted input and no message bodies.
 * Pass `client` to run inside an existing transaction (a savepoint isolates each call).
 */
export async function invokeTool(
  db: Database,
  call: ToolInvocation,
  client?: Transaction,
): Promise<ToolOutcome> {
  const started = Date.now();
  const toolName = typeof call.name === 'string' ? call.name.slice(0, 64) : 'invalid';
  const parsed = parseToolCall(call.name, call.args);
  let outcome: LoggedOutcome = 'error';
  let result: ToolOutcome;
  let proposalId: string | null = null;

  if (!parsed.ok) {
    outcome =
      parsed.code === 'UNKNOWN_TOOL'
        ? 'unknown_tool'
        : parsed.code === 'PRICE_FIELD_REFUSED'
          ? 'price_refused'
          : 'invalid_input';
    result = { ok: false, code: parsed.code, message: parsed.message, issues: parsed.issues };
  } else {
    const run = async (tx: Queryable): Promise<ToolOutcome> => {
      if (parsed.tool.risk === 'read') {
        outcome = 'ok';
        return {
          ok: true,
          data: await runReadTool(tx, call.tenantId, parsed.tool.name, parsed.input),
        };
      }
      const created = await createProposal(tx, {
        tenantId: call.tenantId,
        requestId: call.requestId,
        tool: parsed.tool,
        payload: parsed.input,
        meta: parsed.meta,
        origin: { ...call.origin, sessionId: call.sessionId },
      });
      proposalId = created.proposal.id;
      const executed = created.proposal.status === 'executed';
      outcome = created.duplicate ? 'duplicate' : executed ? 'auto_executed' : 'proposed';
      return {
        ok: true,
        data: {
          proposalId: created.proposal.id,
          status: created.proposal.status,
          duplicate: created.duplicate,
          summary: created.proposal.summary,
          clarifications: created.proposal.clarifications,
          message: executed
            ? 'Executed under the owner’s auto-approval policy for job notes.'
            : created.proposal.status === 'pending'
              ? 'Awaiting owner approval. Nothing has been changed.'
              : `This proposal is already ${created.proposal.status}.`,
        },
      };
    };
    try {
      if (client) {
        const savepoint = `tool_${randomUUID().replace(/-/g, '')}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          result = await run(client);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          throw error;
        }
      } else {
        result = parsed.tool.risk === 'read' ? await run(db.pool) : await transaction(db, run);
      }
    } catch (error) {
      proposalId = null;
      if (error instanceof HttpError) {
        outcome =
          error.statusCode === 404
            ? 'not_found'
            : error.statusCode === 409
              ? 'conflict'
              : error.statusCode === 422 || error.statusCode === 400
                ? 'invalid_input'
                : 'error';
        // Our own HttpError messages are fixed strings or entity labels, never model output.
        result = { ok: false, code: error.code, message: error.message };
      } else {
        outcome = 'error';
        result = {
          ok: false,
          code: 'TOOL_FAILED',
          message: 'The tool could not complete. Nothing was changed.',
        };
      }
    }
  }

  await (client ?? db.pool).query(
    `INSERT INTO agent_tool_calls(id,tenant_id,session_id,request_id,tool,risk,input_sha256,input_redacted,outcome,error_code,proposal_id,duration_ms)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      randomUUID(),
      call.tenantId,
      call.sessionId,
      call.requestId.slice(0, 128),
      toolName,
      parsed.ok ? parsed.tool.risk : null,
      canonicalHash(call.args ?? null),
      JSON.stringify(redactToolInput(call.args ?? {})),
      outcome,
      result.ok ? null : result.code.slice(0, 64),
      proposalId,
      Math.max(0, Date.now() - started),
    ],
  );
  return result;
}
