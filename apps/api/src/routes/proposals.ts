import type { AgentRuntime } from '@opentradie/agent';
import {
  canSetApproval,
  decideModelUse,
  isToolName,
  PolicyDeniedError,
  resolveApproval,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  type ApprovalMode,
} from '@opentradie/core';
import { recordAudit, type Database } from '@opentradie/database';
import type { PostgresJobQueue, RuntimeConfig } from '@opentradie/platform';
import { z } from 'zod';
import { HttpError, iso, type RouteRegistry } from '../http.js';
import { errorResponse, idParams } from '../schemas.js';
import { agentHealthWithTimeout } from '../services/agent-info.js';
import { loadRates } from '../services/records.js';
import { invokeTool } from '../tools/gateway.js';
import {
  getProposalRow,
  materialMarkupFor,
  listProposals,
  proposalDto,
  revalidatePayload,
  runExecutor,
} from '../tools/proposals.js';

const PROPOSAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'executed',
  'failed',
  'superseded',
] as const;

export const proposalResponse = z.object({
  id: z.string(),
  tool: z.string(),
  toolTitle: z.string(),
  source: z.enum(['agent', 'voice', 'email', 'user']),
  sourceRef: z.string().nullable(),
  status: z.enum(PROPOSAL_STATUSES),
  summary: z.string(),
  payload: z.record(z.string(), z.unknown()),
  clarifications: z.array(z.string()),
  approvalPolicy: z.enum(['owner', 'auto']),
  financial: z.boolean(),
  customerFacing: z.boolean(),
  executable: z.boolean(),
  notExecutableReason: z.string().nullable(),
  jobId: z.string().nullable(),
  customerId: z.string().nullable(),
  createdByType: z.string(),
  createdAt: z.string(),
  decidedByType: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedByName: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
  edited: z.boolean(),
  executedAt: z.string().nullable(),
  result: z.object({ entityType: z.string(), entityId: z.string() }).nullable(),
  failure: z.object({ code: z.string(), reason: z.string().nullable() }).nullable(),
});

const proposalListQuery = z
  .object({
    status: z.enum(PROPOSAL_STATUSES).optional(),
    jobId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

const approveBody = z
  .object({
    /** Owner-edited payload; re-validated with the same rules as agent input. */
    payload: z.record(z.string(), z.unknown()).optional(),
    /** Owner-chosen markup for a material with a reported supplier cost. */
    markupBasisPoints: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();
const rejectBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const policyBody = z
  .object({ tool: z.string().max(64), approval: z.enum(['owner', 'auto']) })
  .strict();
const assistantActionsBody = z.object({ text: z.string().trim().min(1).max(4000) }).strict();

/** Approval inbox for action proposals, tool approval policies and the in-app job assistant. */
export function registerProposalRoutes(
  api: RouteRegistry,
  deps: { db: Database; runtime: AgentRuntime; config: RuntimeConfig; queue: PostgresJobQueue },
) {
  const { db, runtime, config, queue } = deps;

  api.route(
    {
      method: 'GET',
      url: '/api/proposals',
      summary: 'Action proposals from the assistant and agent tools (the approval inbox)',
      tags: ['proposals'],
      auth: 'user',
      query: proposalListQuery,
      responses: {
        200: {
          description: 'Proposals, newest first',
          schema: z.object({ proposals: z.array(proposalResponse) }),
        },
      },
    },
    async ({ user, query }) => ({
      body: { proposals: await listProposals(db.pool, user.tenantId, query) },
    }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/proposals/:id',
      summary: 'One action proposal',
      tags: ['proposals'],
      auth: 'user',
      params: idParams,
      responses: {
        200: { description: 'Proposal', schema: proposalResponse },
        404: { description: 'Not found (including other tenants)', schema: errorResponse },
      },
    },
    async ({ user, params }) => ({
      body: proposalDto(await getProposalRow(db.pool, user.tenantId, params.id)),
    }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/proposals/:id/approve',
      summary:
        'Owner approves a proposal (optionally edited); the backend executes the domain command in one audited transaction',
      tags: ['proposals'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: approveBody,
      responses: {
        200: {
          description: 'Executed (or already executed: the same result is returned)',
          schema: z.object({ proposal: proposalResponse, replayed: z.boolean() }),
        },
        404: { description: 'Not found', schema: errorResponse },
        409: {
          description: 'PROPOSAL_CLOSED or EXECUTOR_NOT_AVAILABLE (proposal stays pending)',
          schema: errorResponse,
        },
        422: {
          description:
            'MARKUP_REQUIRED or PRICE_FIELD_REFUSED (nothing recorded), or PROPOSAL_FAILED (failure recorded on the proposal)',
          schema: errorResponse,
        },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const row = await getProposalRow(client, user.tenantId, params.id, true);
        if (row.status === 'executed')
          return { body: { proposal: proposalDto(row), replayed: true } };
        if (row.status !== 'pending' && row.status !== 'failed')
          throw new HttpError(409, 'PROPOSAL_CLOSED', `This proposal is ${row.status}.`);
        if (!isToolName(row.tool))
          throw new HttpError(409, 'EXECUTOR_NOT_AVAILABLE', 'Unknown proposal tool.');
        const tool = TOOL_DEFINITIONS[row.tool];
        if (!tool.executable)
          throw new HttpError(
            409,
            'EXECUTOR_NOT_AVAILABLE',
            tool.notExecutableReason ?? 'This proposal cannot be executed yet.',
          );
        const payload = body.payload ? revalidatePayload(row.tool, body.payload) : row.payload;
        const edited = body.payload !== undefined;
        if (
          row.tool === 'job.add_material' &&
          payload.reportedUnitCostCents !== undefined &&
          !(await materialMarkupFor(client, user.tenantId, body.markupBasisPoints))
        )
          throw new HttpError(
            422,
            'MARKUP_REQUIRED',
            'This material has a reported supplier cost. Choose the markup (basis points) when approving, or set a default material markup in Settings.',
          );

        await client.query('SAVEPOINT proposal_execution');
        try {
          const result = await runExecutor(client, {
            tenantId: user.tenantId,
            requestId: request.id,
            proposal: row,
            payload,
            actor: { type: 'user', id: user.id },
            ownerInputs: { markupBasisPoints: body.markupBasisPoints },
            queue,
          });
          await client.query('RELEASE SAVEPOINT proposal_execution');
          await client.query(
            `UPDATE action_proposals SET status='executed',payload=$3,edited=$4,decided_by_type='user',decided_by=$5,
               decided_at=now(),executed_at=now(),result_entity_type=$6,result_entity_id=$7,
               failure_code=NULL,failure_reason=NULL,updated_at=now()
             WHERE tenant_id=$1 AND id=$2`,
            [
              user.tenantId,
              row.id,
              JSON.stringify(payload),
              edited || row.edited,
              user.id,
              result.entityType,
              result.entityId,
            ],
          );
          await recordAudit(client, {
            tenantId: user.tenantId,
            actorType: 'user',
            actorId: user.id,
            action: 'proposal.approved',
            entityType: 'action_proposal',
            entityId: row.id,
            requestId: request.id,
            metadata: { tool: row.tool, edited, ...result },
          });
          return {
            body: {
              proposal: proposalDto(await getProposalRow(client, user.tenantId, row.id)),
              replayed: false,
            },
          };
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          // Domain refusal: undo partial work, keep a visible failure on the proposal.
          await client.query('ROLLBACK TO SAVEPOINT proposal_execution');
          await client.query(
            `UPDATE action_proposals SET status='failed',decided_by_type='user',decided_by=$3,decided_at=now(),
               failure_code=$4,failure_reason=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2`,
            [user.tenantId, row.id, user.id, error.code.slice(0, 64), error.message.slice(0, 500)],
          );
          await recordAudit(client, {
            tenantId: user.tenantId,
            actorType: 'user',
            actorId: user.id,
            action: 'proposal.failed',
            entityType: 'action_proposal',
            entityId: row.id,
            requestId: request.id,
            metadata: { tool: row.tool, code: error.code },
          });
          return {
            status: 422,
            body: {
              error: 'PROPOSAL_FAILED',
              message: error.message,
              requestId: request.id,
              failureCode: error.code,
              proposal: proposalDto(await getProposalRow(client, user.tenantId, row.id)),
            },
          };
        }
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/proposals/:id/reject',
      summary: 'Owner rejects a proposal with a reason; nothing is executed',
      tags: ['proposals'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: rejectBody,
      responses: {
        200: { description: 'Rejected', schema: proposalResponse },
        404: { description: 'Not found', schema: errorResponse },
        409: { description: 'PROPOSAL_CLOSED', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const row = await getProposalRow(client, user.tenantId, params.id, true);
        if (row.status !== 'pending' && row.status !== 'failed')
          throw new HttpError(409, 'PROPOSAL_CLOSED', `This proposal is ${row.status}.`);
        await client.query(
          `UPDATE action_proposals SET status='rejected',decided_by_type='user',decided_by=$3,decided_at=now(),
             decision_reason=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2`,
          [user.tenantId, row.id, user.id, body.reason],
        );
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'proposal.rejected',
          entityType: 'action_proposal',
          entityId: row.id,
          requestId: request.id,
          metadata: { tool: row.tool },
        });
        return { body: proposalDto(await getProposalRow(client, user.tenantId, row.id)) };
      }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/agent-tools',
      summary: 'The business tool catalogue with each tool’s effective approval policy',
      tags: ['proposals'],
      auth: 'user',
      responses: { 200: { description: 'Tools and policies' } },
    },
    async ({ user }) => {
      const stored = await db.pool.query<{ tool: string; approval: ApprovalMode; updatedAt: Date }>(
        'SELECT tool,approval,updated_at AS "updatedAt" FROM agent_tool_policies WHERE tenant_id=$1',
        [user.tenantId],
      );
      const byTool = new Map(stored.rows.map((row) => [row.tool, row]));
      return {
        body: {
          gatewayEnabled: Boolean(config.agentToolToken),
          tools: TOOL_NAMES.map((name) => {
            const tool = TOOL_DEFINITIONS[name];
            const row = byTool.get(name);
            return {
              name,
              title: tool.title,
              risk: tool.risk,
              financial: tool.financial,
              customerFacing: tool.customerFacing,
              executable: tool.executable,
              autoApprovalAllowed: tool.autoApprovalAllowed,
              approval: tool.risk === 'propose' ? resolveApproval(name, row?.approval) : null,
              policyUpdatedAt: row ? iso(row.updatedAt) : null,
            };
          }),
        },
      };
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/agent-tool-policies',
      summary:
        'Owner sets a tool’s approval policy. Only job notes can be auto-approved; everything else needs owner approval',
      tags: ['proposals'],
      auth: 'owner',
      idempotent: true,
      body: policyBody,
      responses: {
        200: { description: 'Policy stored' },
        422: { description: 'POLICY_NOT_ALLOWED', schema: errorResponse },
      },
    },
    async ({ user, body, request, idempotent }) =>
      idempotent(async (client) => {
        if (!isToolName(body.tool) || !canSetApproval(body.tool, body.approval))
          throw new HttpError(
            422,
            'POLICY_NOT_ALLOWED',
            'Only job notes can be auto-approved. Every other proposal needs owner approval.',
          );
        await client.query(
          `INSERT INTO agent_tool_policies(tenant_id,tool,approval,updated_by) VALUES($1,$2,$3,$4)
           ON CONFLICT (tenant_id,tool) DO UPDATE SET approval=excluded.approval,updated_by=excluded.updated_by,updated_at=now()`,
          [user.tenantId, body.tool, body.approval, user.id],
        );
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'agent_tool_policy.updated',
          entityType: 'agent_tool_policy',
          requestId: request.id,
          metadata: { tool: body.tool, approval: body.approval },
        });
        return { body: { tool: body.tool, approval: body.approval } };
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/jobs/:id/assistant-actions',
      summary:
        'Give the assistant a job update (e.g. a transcribed voice note); it proposes tool actions for owner approval',
      tags: ['proposals'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: assistantActionsBody,
      responses: {
        201: { description: 'Proposals created (nothing executed unless owner policy allows)' },
        403: { description: 'MODEL_POLICY_DENIED', schema: errorResponse },
        404: { description: 'Job not found', schema: errorResponse },
        501: { description: 'AGENT_PLANNING_UNAVAILABLE', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(
        async (client, planned) => {
          const created = [];
          const refused = [];
          for (const [index, call] of planned.entries()) {
            const args = {
              ...(call.arguments && typeof call.arguments === 'object' ? call.arguments : {}),
              jobId: params.id,
              idempotencyKey: `assistant-${request.id}-${index}`.slice(0, 128),
            };
            const outcome = await invokeTool(
              db,
              {
                tenantId: user.tenantId,
                requestId: request.id,
                sessionId: null,
                name: call.tool,
                args,
                origin: {
                  source: 'agent',
                  sourceRef: `assistant:${request.id}`.slice(0, 200),
                  createdByType: 'agent',
                },
              },
              client,
            );
            if (outcome.ok) created.push(outcome.data);
            else
              refused.push({
                tool: String(call.tool).slice(0, 64),
                error: outcome.code,
                message: outcome.message,
              });
          }
          return { status: 201, body: { proposals: created, refused } };
        },
        async () => {
          const job = await db.pool.query<{ status: string }>(
            'SELECT status FROM jobs WHERE tenant_id=$1 AND id=$2',
            [user.tenantId, params.id],
          );
          if (!job.rows[0]) throw new HttpError(404, 'JOB_NOT_FOUND', 'Job not found.');
          if (!runtime.planJobActions)
            throw new HttpError(
              501,
              'AGENT_PLANNING_UNAVAILABLE',
              'This agent runtime proposes actions through the tool gateway, not this screen.',
            );
          const health = await agentHealthWithTimeout(runtime, 10_000);
          if (!health || health.status !== 'ok')
            throw new HttpError(503, 'AGENT_UNAVAILABLE', 'The assistant is unavailable.');
          const decision = decideModelUse({
            mode: config.privacyMode,
            purpose: 'enquiry_interpretation',
            destination: {
              provider: health.provider,
              location: health.inferenceLocation,
              attestation: health.attestation,
            },
            dataCategories: ['enquiry_text', 'rate_labels'],
          });
          if (!decision.allowed) throw new PolicyDeniedError(decision);
          const rates = await loadRates(db.pool, user.tenantId);
          const calls = await runtime.planJobActions({
            requestId: request.id,
            text: body.text,
            context: {
              jobStatus: job.rows[0].status,
              rates: rates.map(({ code, label, unit }) => ({ code, label, unit })),
            },
          });
          // Untrusted output: bounded here, validated per call by the registry in invokeTool.
          return (Array.isArray(calls) ? calls : []).slice(0, 10);
        },
      ),
  );
}
