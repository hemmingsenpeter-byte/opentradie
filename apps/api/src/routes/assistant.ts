import { randomUUID } from 'node:crypto';
import type { AgentRuntime } from '@opentradie/agent';
import {
  calculateQuote,
  decideModelUse,
  parseWorkProposal,
  PolicyDeniedError,
  resolveCustomer,
  type CustomerCandidate,
  type DataCategory,
  type ModelUseApproval,
} from '@opentradie/core';
import { knowledge, recordAudit, type Database } from '@opentradie/database';
import type { PostgresJobQueue, RuntimeConfig } from '@opentradie/platform';
import { z } from 'zod';
import { HttpError, iso, type RouteRegistry, type UserContext } from '../http.js';
import { enquiryBody, enquiryResponse, errorResponse, modelApprovalBody } from '../schemas.js';
import { agentHealthWithTimeout, agentInfo } from '../services/agent-info.js';
import { getQuote, loadBusiness, loadRates, quotePolicy, writeQuoteLines } from '../services/records.js';

const ENQUIRY_DATA: DataCategory[] = ['enquiry_text', 'customer_names', 'rate_labels'];

export function registerAssistantRoutes(api: RouteRegistry, deps: { db: Database; runtime: AgentRuntime; config: RuntimeConfig; queue: PostgresJobQueue }) {
  const { db, runtime, config, queue } = deps;

  async function destination() {
    const health = await agentHealthWithTimeout(runtime, 10_000);
    if (!health || health.status !== 'ok') throw new HttpError(503, 'AGENT_UNAVAILABLE', 'The assistant is unavailable. Your enquiry was not processed; create the job manually or retry.');
    return { health, destination: { provider: health.provider, location: health.inferenceLocation, attestation: health.attestation } };
  }

  /** Single-use approvals are consumed atomically before any content is sent. */
  async function consumeApproval(user: UserContext, approvalId: string): Promise<ModelUseApproval | null> {
    const result = await db.pool.query<{ id: string; purpose: ModelUseApproval['purpose']; provider: string; dataCategories: DataCategory[]; expiresAt: Date }>(
      `UPDATE model_use_approvals SET consumed_at=now()
       WHERE tenant_id=$1 AND id=$2 AND consumed_at IS NULL AND expires_at > now()
       RETURNING id,purpose,provider,data_categories AS "dataCategories",expires_at AS "expiresAt"`,
      [user.tenantId, approvalId],
    );
    const row = result.rows[0];
    return row ? { ...row, consumedAt: null } : null;
  }

  api.route(
    {
      method: 'GET',
      url: '/api/model-policy',
      summary: 'Explain where enquiry interpretation would send data under the current privacy mode',
      tags: ['assistant'],
      auth: 'user',
      responses: { 200: { description: 'Policy decision preview (no content is sent)' } },
    },
    async () => {
      const health = await agentHealthWithTimeout(runtime);
      const target = health ? { provider: health.provider, location: health.inferenceLocation, attestation: health.attestation } : { provider: 'unavailable', location: 'unverified' as const, attestation: 'runtime' as const };
      const decision = decideModelUse({ mode: config.privacyMode, purpose: 'enquiry_interpretation', destination: target, dataCategories: ENQUIRY_DATA });
      return { body: { privacyMode: config.privacyMode, enquiryInterpretation: decision, approvalAvailable: config.privacyMode === 'APPROVAL_REQUIRED' } };
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/model-approvals',
      summary: 'Owner grants a single-use, 15-minute approval to send named data categories to a named model provider',
      tags: ['assistant'],
      auth: 'owner',
      idempotent: true,
      body: modelApprovalBody,
      responses: { 201: { description: 'Approval granted' }, 409: { description: 'Not applicable in this privacy mode', schema: errorResponse } },
    },
    async ({ body, user, request, idempotent }) => {
      if (config.privacyMode !== 'APPROVAL_REQUIRED') throw new HttpError(409, 'APPROVAL_NOT_APPLICABLE', `Model-use approvals only apply in APPROVAL_REQUIRED mode (current: ${config.privacyMode}).`);
      return idempotent(async (client) => {
        const id = randomUUID();
        const created = await client.query<{ expiresAt: Date }>(
          "INSERT INTO model_use_approvals(id,tenant_id,purpose,provider,data_categories,approved_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,now() + interval '15 minutes') RETURNING expires_at AS \"expiresAt\"",
          [id, user.tenantId, body.purpose, body.provider, body.dataCategories, user.id],
        );
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'model.approval_granted',
          entityType: 'model_use_approval',
          entityId: id,
          requestId: request.id,
          metadata: { purpose: body.purpose, provider: body.provider, dataCategories: body.dataCategories },
        });
        return { status: 201, body: { id, ...body, expiresAt: iso(created.rows[0]!.expiresAt) } };
      });
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/enquiries',
      summary: 'Interpret a customer enquiry, resolve the customer, propose a job and draft a quote from approved rates',
      tags: ['assistant'],
      auth: 'owner',
      idempotent: true,
      body: enquiryBody,
      responses: {
        200: { description: 'Clarification required: the customer is ambiguous or unknown', schema: enquiryResponse },
        201: { description: 'Job proposed and quote drafted for owner approval', schema: enquiryResponse },
        403: { description: 'MODEL_POLICY_DENIED: privacy policy blocks the configured model', schema: errorResponse },
        409: { description: 'MODEL_APPROVAL_REQUIRED or IDEMPOTENCY_CONFLICT', schema: errorResponse },
        502: { description: 'AGENT_INVALID_OUTPUT: the agent output failed validation; nothing was created', schema: errorResponse },
        503: { description: 'AGENT_UNAVAILABLE', schema: errorResponse },
      },
    },
    async ({ body, user, request, idempotent }) =>
      idempotent(
        async (client, prepared) => {
          const { proposal, decision, health, customers, selected, rates } = prepared;
          const business = await loadBusiness(client, user.tenantId);
          const enquiryId = randomUUID();
          await client.query("INSERT INTO communications(id,tenant_id,direction,channel,status,text) VALUES($1,$2,'inbound','manual','received',$3)", [enquiryId, user.tenantId, body.text]);
          const knowledgeId = await knowledge(client, user.tenantId, null, null, 'communication', enquiryId, body.text);
          await queue.enqueue({ tenantId: user.tenantId, kind: 'knowledge.embed', payload: { knowledgeItemId: knowledgeId }, idempotencyKey: `embed:${knowledgeId}` }, client);
          const audit = (action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}) =>
            recordAudit(client, { tenantId: user.tenantId, actorType: 'user', actorId: user.id, action, entityType, entityId, requestId: request.id, metadata });
          await audit('model.policy_allowed', 'communication', enquiryId, { purpose: decision.purpose, reason: decision.reason, provider: decision.destination.provider, location: decision.destination.location, dataCategories: decision.dataCategories });
          await audit('enquiry.received', 'communication', enquiryId, { agentRuntime: health.runtime, synthetic: health.synthetic, lineItems: proposal.lineItems.length });

          const resolution = selected ? ({ kind: 'resolved', customer: selected, basis: 'selected' } as const) : resolveCustomer(proposal.customerQuery, customers);
          const proposalSummary = { workSummary: proposal.workSummary, customerQuery: proposal.customerQuery };
          if (resolution.kind !== 'resolved') {
            await audit('enquiry.clarification_requested', 'communication', enquiryId, { reason: resolution.kind, candidates: resolution.kind === 'ambiguous' ? resolution.matches.length : 0 });
            const matches = resolution.kind === 'ambiguous' ? resolution.matches.map((match) => ({ id: match.id, name: match.name })) : [];
            return {
              status: 200,
              body: {
                status: 'clarification_required',
                enquiryId,
                clarification: {
                  message:
                    resolution.kind === 'ambiguous'
                      ? `${matches.length} customers match "${proposal.customerQuery}". Choose the right customer and resubmit with customerId.`
                      : 'No existing customer matches this enquiry. Choose or add the customer, then resubmit with customerId.',
                  matches,
                },
                proposal: proposalSummary,
                agent: agentInfo(health),
              },
            };
          }
          const customer = resolution.customer;
          await client.query('UPDATE communications SET customer_id=$3 WHERE tenant_id=$1 AND id=$2', [user.tenantId, enquiryId, customer.id]);
          await client.query('UPDATE knowledge_items SET customer_id=$3 WHERE tenant_id=$1 AND id=$2', [user.tenantId, knowledgeId, customer.id]);

          const previousJobs = await client.query<{ id: string; title: string; status: string; completedAt: Date | null }>(
            'SELECT id,title,status,completed_at AS "completedAt" FROM jobs WHERE tenant_id=$1 AND customer_id=$2 ORDER BY created_at DESC LIMIT 5',
            [user.tenantId, customer.id],
          );
          const notes = await client.query<{ jobId: string; text: string }>(
            'SELECT job_id AS "jobId",text FROM job_notes WHERE tenant_id=$1 AND job_id = ANY($2::uuid[]) ORDER BY created_at',
            [user.tenantId, previousJobs.rows.map((row) => row.id)],
          );
          const history = previousJobs.rows.map((row) => ({
            jobId: row.id,
            title: row.title,
            status: row.status,
            completedAt: iso(row.completedAt),
            notes: notes.rows.filter((note) => note.jobId === row.id).map((note) => note.text),
          }));

          const assumptions = [...proposal.assumptions];
          if (resolution.basis === 'surname') assumptions.push(`Customer matched to ${customer.name} by name only; confirm identity before sending.`);
          if (history.length) assumptions.push('Previous work for this customer exists; review the job history before approving.');
          const calculation = calculateQuote({
            requested: proposal.lineItems,
            approvedRates: rates,
            policy: quotePolicy(business),
            assumptions,
            missingInformation: proposal.missingInformation.filter((item) => !/which customer/i.test(item)),
          });

          const jobId = randomUUID();
          await client.query(
            "INSERT INTO jobs(id,tenant_id,customer_id,title,description,status,site_address,origin) SELECT $1,$2,$3,$4,$5,'quoted',address,'assistant_proposed' FROM customers WHERE tenant_id=$2 AND id=$3",
            [jobId, user.tenantId, customer.id, proposal.workSummary.slice(0, 300), `Proposed from enquiry ${enquiryId}. Review scope before approval.`],
          );
          await client.query("INSERT INTO job_notes(id,tenant_id,job_id,author_id,text,provenance) VALUES($1,$2,$3,$4,$5,'inferred')", [
            randomUUID(),
            user.tenantId,
            jobId,
            user.id,
            `Assistant-proposed scope (unverified): ${proposal.workSummary}`,
          ]);
          await client.query('UPDATE communications SET job_id=$3 WHERE tenant_id=$1 AND id=$2', [user.tenantId, enquiryId, jobId]);
          await client.query('UPDATE knowledge_items SET job_id=$3 WHERE tenant_id=$1 AND id=$2', [user.tenantId, knowledgeId, jobId]);

          const quoteId = randomUUID();
          await client.query(
            'INSERT INTO quotes(id,tenant_id,customer_id,job_id,currency,assumptions,missing_information,subtotal_cents,tax_cents,total_cents,tax_basis_points,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
            [
              quoteId,
              user.tenantId,
              customer.id,
              jobId,
              business.currency,
              JSON.stringify(calculation.assumptions),
              JSON.stringify(calculation.missingInformation),
              calculation.subtotalCents,
              calculation.taxCents,
              calculation.totalCents,
              calculation.taxBasisPoints,
              user.id,
            ],
          );
          await writeQuoteLines(client, user.tenantId, quoteId, calculation);
          const approvalId = randomUUID();
          await client.query("INSERT INTO approval_requests(id,tenant_id,subject_type,quote_id,status,requested_by) VALUES($1,$2,'quote',$3,'pending',$4)", [approvalId, user.tenantId, quoteId, user.id]);
          await audit('job.proposed', 'job', jobId, { customerId: customer.id, matchedBy: resolution.basis });
          await audit('quote.drafted', 'quote', quoteId, { version: 1, totalCents: calculation.totalCents, lines: calculation.lines.length, missing: calculation.missingInformation.length });
          await audit('approval.requested', 'approval_request', approvalId, { quoteId });
          return {
            status: 201,
            body: {
              status: 'quote_drafted',
              enquiryId,
              jobId,
              quoteId,
              customer: { id: customer.id, name: customer.name, matchedBy: resolution.basis },
              quote: await getQuote(client, user.tenantId, quoteId),
              history,
              proposal: proposalSummary,
              agent: agentInfo(health),
            },
          };
        },
        async () => {
          const { health, destination: target } = await destination();
          const candidates = await db.pool.query<CustomerCandidate>(
            'SELECT id,name,preferred_name AS "preferredName" FROM customers WHERE tenant_id=$1 AND archived_at IS NULL ORDER BY name',
            [user.tenantId],
          );
          const selected = body.customerId ? (candidates.rows.find((candidate) => candidate.id === body.customerId) ?? null) : null;
          if (body.customerId && !selected) throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
          const rates = await loadRates(db.pool, user.tenantId);

          let approval: ModelUseApproval | null = null;
          if (body.modelApprovalId && config.privacyMode === 'APPROVAL_REQUIRED' && target.location !== 'local') {
            approval = await consumeApproval(user, body.modelApprovalId);
          }
          const decision = decideModelUse({ mode: config.privacyMode, purpose: 'enquiry_interpretation', destination: target, dataCategories: ENQUIRY_DATA, approval });
          if (!decision.allowed) {
            // Recorded outside the request transaction so the denial survives the error response.
            await recordAudit(db.pool, {
              tenantId: user.tenantId,
              actorType: 'user',
              actorId: user.id,
              action: 'model.policy_denied',
              entityType: 'enquiry',
              requestId: request.id,
              metadata: { purpose: decision.purpose, reason: decision.reason, provider: decision.destination.provider, location: decision.destination.location, mode: decision.mode },
            });
            throw new PolicyDeniedError(decision);
          }
          const offered = rates.map(({ code, label, unit }) => ({ code, label, unit }));
          const raw = await runtime.interpret({
            requestId: request.id,
            prompt: body.text,
            context: { customers: (selected ? [selected] : candidates.rows).map((candidate) => ({ name: candidate.name })), rates: offered },
          });
          // Defence in depth: whatever runtime is plugged in, its output is re-validated here.
          let proposal;
          try {
            proposal = parseWorkProposal(raw, offered.map((rate) => rate.code));
          } catch (error) {
            if (error instanceof z.ZodError) throw new HttpError(502, 'AGENT_INVALID_OUTPUT', 'The assistant returned an invalid proposal. Nothing was created; enter the job manually or retry.');
            throw error;
          }
          return { proposal, decision, health, customers: candidates.rows, selected, rates };
        },
      ),
  );
}
