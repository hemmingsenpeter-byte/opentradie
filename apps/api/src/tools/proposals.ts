import { randomUUID } from 'node:crypto';
import {
  calculateQuote,
  canonicalHash,
  checkJobTransition,
  costPlusMarkupCents,
  formatQuantityMilli,
  formatSignedCents,
  isToolName,
  parseToolCall,
  resolveApproval,
  TOOL_DEFINITIONS,
  type ApprovalMode,
  type JobStatus,
  type ProposalMeta,
  type ToolDefinition,
  type ToolName,
} from '@opentradie/core';
import { recordAudit, recordJobEvent, type Queryable } from '@opentradie/database';
import { HttpError, iso } from '../http.js';
import {
  getCustomer,
  loadBusiness,
  loadRates,
  propertyForCustomer,
  quotePolicy,
  writeQuoteLines,
} from '../services/records.js';

export type ProposalSource = 'agent' | 'voice' | 'email' | 'user';
export type ProposalStatus =
  'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'superseded';

export interface ProposalOrigin {
  source: ProposalSource;
  /** Opaque reference (session, message or request id). Never content. */
  sourceRef?: string | null;
  sessionId?: string | null;
  createdByType: 'agent' | 'user' | 'system';
  createdBy?: string | null;
}

/** Who executes: an owner approving, or the system under an owner-enabled auto policy. */
export type ExecutionActor = { type: 'user'; id: string } | { type: 'system' };

type Payload = Record<string, unknown>;

interface ProposalRow {
  id: string;
  source: ProposalSource;
  sourceRef: string | null;
  tool: string;
  payload: Payload;
  summary: string;
  clarifications: string[];
  approvalPolicy: ApprovalMode;
  status: ProposalStatus;
  jobId: string | null;
  customerId: string | null;
  createdByType: string;
  createdAt: Date;
  decidedByType: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  edited: boolean;
  executedAt: Date | null;
  resultEntityType: string | null;
  resultEntityId: string | null;
  failureCode: string | null;
  failureReason: string | null;
}

const COLUMNS = `p.id,p.source,p.source_ref AS "sourceRef",p.tool,p.payload,p.summary,p.clarifications,
  p.approval_policy AS "approvalPolicy",p.status,p.job_id AS "jobId",p.customer_id AS "customerId",
  p.created_by_type AS "createdByType",p.created_at AS "createdAt",p.decided_by_type AS "decidedByType",
  p.decided_by AS "decidedBy",u.display_name AS "decidedByName",p.decided_at AS "decidedAt",
  p.decision_reason AS "decisionReason",p.edited,p.executed_at AS "executedAt",
  p.result_entity_type AS "resultEntityType",p.result_entity_id AS "resultEntityId",
  p.failure_code AS "failureCode",p.failure_reason AS "failureReason"`;
const FROM = `action_proposals p LEFT JOIN users u ON u.tenant_id=p.tenant_id AND u.id=p.decided_by`;

export function proposalDto(row: ProposalRow) {
  const tool: ToolDefinition | null = isToolName(row.tool) ? TOOL_DEFINITIONS[row.tool] : null;
  return {
    id: row.id,
    tool: row.tool,
    toolTitle: tool?.title ?? row.tool,
    source: row.source,
    sourceRef: row.sourceRef,
    status: row.status,
    summary: row.summary,
    payload: row.payload,
    clarifications: row.clarifications,
    approvalPolicy: row.approvalPolicy,
    financial: tool?.financial ?? false,
    customerFacing: tool?.customerFacing ?? false,
    executable: tool?.executable ?? false,
    notExecutableReason: tool?.notExecutableReason ?? null,
    jobId: row.jobId,
    customerId: row.customerId,
    createdByType: row.createdByType,
    createdAt: iso(row.createdAt)!,
    decidedByType: row.decidedByType,
    decidedBy: row.decidedBy,
    decidedByName: row.decidedByName,
    decidedAt: iso(row.decidedAt),
    decisionReason: row.decisionReason,
    edited: row.edited,
    executedAt: iso(row.executedAt),
    result:
      row.resultEntityType && row.resultEntityId
        ? { entityType: row.resultEntityType, entityId: row.resultEntityId }
        : null,
    failure: row.failureCode ? { code: row.failureCode, reason: row.failureReason } : null,
  };
}
export type ProposalDto = ReturnType<typeof proposalDto>;

export async function getProposalRow(
  client: Queryable,
  tenantId: string,
  id: string,
  lock = false,
): Promise<ProposalRow> {
  const result = await client.query<ProposalRow>(
    lock
      ? // FOR UPDATE cannot apply to the nullable side of an outer join.
        `SELECT ${COLUMNS} FROM ${FROM} WHERE p.tenant_id=$1 AND p.id=$2 FOR UPDATE OF p`
      : `SELECT ${COLUMNS} FROM ${FROM} WHERE p.tenant_id=$1 AND p.id=$2`,
    [tenantId, id],
  );
  if (!result.rows[0]) throw new HttpError(404, 'PROPOSAL_NOT_FOUND', 'Proposal not found.');
  return result.rows[0];
}

export async function listProposals(
  client: Queryable,
  tenantId: string,
  filter: { status?: ProposalStatus | undefined; jobId?: string | undefined; limit: number },
): Promise<ProposalDto[]> {
  const result = await client.query<ProposalRow>(
    `SELECT ${COLUMNS} FROM ${FROM}
     WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.status=$2) AND ($3::uuid IS NULL OR p.job_id=$3)
     ORDER BY p.created_at DESC LIMIT $4`,
    [tenantId, filter.status ?? null, filter.jobId ?? null, filter.limit],
  );
  return result.rows.map(proposalDto);
}

export async function approvalPolicyFor(
  client: Queryable,
  tenantId: string,
  tool: ToolName,
): Promise<ApprovalMode> {
  const stored = await client.query<{ approval: ApprovalMode }>(
    'SELECT approval FROM agent_tool_policies WHERE tenant_id=$1 AND tool=$2',
    [tenantId, tool],
  );
  return resolveApproval(tool, stored.rows[0]?.approval ?? null);
}

// ---------------------------------------------------------------------------------------------
// Validation against the tenant's records: every referenced entity must exist in this tenant.
// Produces the inbox summary (server-generated, never model text) and server clarifications.
// ---------------------------------------------------------------------------------------------

const short = (value: string, max = 80) => (value.length > max ? `${value.slice(0, max)}…` : value);

async function jobFor(client: Queryable, tenantId: string, jobId: string) {
  const found = await client.query<{
    id: string;
    title: string;
    status: JobStatus;
    customerId: string;
    customerName: string;
  }>(
    `SELECT j.id,j.title,j.status,j.customer_id AS "customerId",c.name AS "customerName"
     FROM jobs j JOIN customers c ON c.tenant_id=j.tenant_id AND c.id=j.customer_id WHERE j.tenant_id=$1 AND j.id=$2`,
    [tenantId, jobId],
  );
  if (!found.rows[0]) throw new HttpError(404, 'JOB_NOT_FOUND', 'Job not found.');
  return found.rows[0];
}

async function hourlyRate(client: Queryable, tenantId: string, code: string) {
  const found = await client.query<{ id: string; code: string; label: string; unit: string }>(
    'SELECT id,code,label,unit FROM approved_rates WHERE tenant_id=$1 AND code=$2 AND active=true',
    [tenantId, code],
  );
  const rate = found.rows[0];
  if (!rate)
    throw new HttpError(
      422,
      'RATE_NOT_APPROVED',
      `Rate "${code}" is not an approved, active rate.`,
    );
  if (rate.unit !== 'hour')
    throw new HttpError(
      422,
      'RATE_NOT_HOURLY',
      `Rate "${code}" is charged per ${rate.unit}; time entries need an hourly rate.`,
    );
  return rate;
}

interface Described {
  jobId: string | null;
  customerId: string | null;
  summary: string;
  clarifications: string[];
}

export async function describeProposal(
  client: Queryable,
  tenantId: string,
  tool: ToolName,
  payload: Payload,
): Promise<Described> {
  const clarifications: string[] = [];
  switch (tool) {
    case 'customer.create': {
      const name = payload.name as string;
      const similar = await client.query<{ name: string }>(
        'SELECT name FROM customers WHERE tenant_id=$1 AND archived_at IS NULL AND lower(name)=lower($2) LIMIT 3',
        [tenantId, name],
      );
      for (const row of similar.rows)
        clarifications.push(
          `A customer named "${short(row.name)}" already exists. Is this a different person?`,
        );
      return {
        jobId: null,
        customerId: null,
        summary: `Add customer "${short(name)}"`,
        clarifications,
      };
    }
    case 'job.create': {
      const customer = await getCustomer(client, tenantId, payload.customerId as string);
      if (payload.propertyId)
        await propertyForCustomer(client, tenantId, customer.id, payload.propertyId as string);
      else {
        const sites = await client.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM properties WHERE tenant_id=$1 AND customer_id=$2 AND archived_at IS NULL',
          [tenantId, customer.id],
        );
        if ((sites.rows[0]?.count ?? 0) > 1)
          clarifications.push('This customer has several sites. Which site is the job at?');
      }
      return {
        jobId: null,
        customerId: customer.id,
        summary: `New job "${short(payload.title as string)}" for ${short(customer.name)}`,
        clarifications,
      };
    }
    case 'job.update_status': {
      const job = await jobFor(client, tenantId, payload.jobId as string);
      const to = payload.status as JobStatus;
      const check = checkJobTransition(job.status, to, { reopen: payload.reopen === true });
      if (!check.allowed)
        throw new HttpError(
          409,
          check.code === 'REOPEN_REQUIRED' ? 'REOPEN_REQUIRED' : 'INVALID_STATUS_TRANSITION',
          check.message,
        );
      return {
        jobId: job.id,
        customerId: job.customerId,
        summary: `Move job "${short(job.title)}" from ${job.status.replace('_', ' ')} to ${to.replace('_', ' ')}`,
        clarifications,
      };
    }
    case 'job.add_note': {
      const job = await jobFor(client, tenantId, payload.jobId as string);
      return {
        jobId: job.id,
        customerId: job.customerId,
        summary: `Add a note to job "${short(job.title)}"`,
        clarifications,
      };
    }
    case 'job.record_time': {
      const job = await jobFor(client, tenantId, payload.jobId as string);
      const rate = await hourlyRate(client, tenantId, payload.rateCode as string);
      return {
        jobId: job.id,
        customerId: job.customerId,
        summary: `Record ${formatQuantityMilli(payload.quantityMilli as number)} h of "${short(rate.label)}" on job "${short(job.title)}" (priced from the approved rate)`,
        clarifications,
      };
    }
    case 'job.add_material': {
      const job = await jobFor(client, tenantId, payload.jobId as string);
      const cost = payload.reportedUnitCostCents as number | undefined;
      if (cost !== undefined)
        clarifications.push(
          'Confirm the reported supplier cost and choose the markup before approving.',
        );
      return {
        jobId: job.id,
        customerId: job.customerId,
        summary: `Add ${formatQuantityMilli(payload.quantityMilli as number)} ${payload.unit as string} of "${short(payload.description as string, 60)}" to job "${short(job.title)}"${
          cost !== undefined ? ` (reported supplier cost ${formatSignedCents(cost)} per unit)` : ''
        }`,
        clarifications,
      };
    }
    case 'quote.prepare': {
      const job = await jobFor(client, tenantId, payload.jobId as string);
      const rates = new Set((await loadRates(client, tenantId)).map((rate) => rate.code));
      const lines = payload.lines as Array<{ rateCode: string; quantityMilli: number }>;
      for (const line of lines) {
        if (!rates.has(line.rateCode))
          throw new HttpError(
            422,
            'RATE_NOT_APPROVED',
            `Rate "${line.rateCode}" is not an approved, active rate.`,
          );
        if (line.quantityMilli % 1000 !== 0)
          throw new HttpError(
            422,
            'FRACTIONAL_QUANTITY_UNSUPPORTED',
            'Draft quotes currently take whole-unit quantities.',
          );
      }
      return {
        jobId: job.id,
        customerId: job.customerId,
        summary: `Draft a quote for job "${short(job.title)}" with ${lines.length} line(s) priced from approved rates`,
        clarifications,
      };
    }
    case 'invoice.prepare': {
      const job = await jobFor(client, tenantId, payload.jobId as string);
      if (payload.quoteId) {
        const quote = await client.query(
          'SELECT 1 FROM quotes WHERE tenant_id=$1 AND id=$2 AND job_id=$3',
          [tenantId, payload.quoteId, job.id],
        );
        if (!quote.rowCount) throw new HttpError(404, 'QUOTE_NOT_FOUND', 'Quote not found.');
      }
      return {
        jobId: job.id,
        customerId: job.customerId,
        summary: `Prepare an invoice for job "${short(job.title)}"`,
        clarifications,
      };
    }
    case 'communication.draft': {
      const job = payload.jobId ? await jobFor(client, tenantId, payload.jobId as string) : null;
      const customer = await getCustomer(
        client,
        tenantId,
        (payload.customerId as string | undefined) ?? job!.customerId,
      );
      if (job && job.customerId !== customer.id)
        throw new HttpError(
          422,
          'JOB_CUSTOMER_MISMATCH',
          'That job belongs to a different customer.',
        );
      return {
        jobId: job?.id ?? null,
        customerId: customer.id,
        summary: `Draft a ${payload.channel as string} message to ${short(customer.name)} (saved as a draft, not sent)`,
        clarifications,
      };
    }
    case 'reminder.create': {
      const job = payload.jobId ? await jobFor(client, tenantId, payload.jobId as string) : null;
      const customer = payload.customerId
        ? await getCustomer(client, tenantId, payload.customerId as string)
        : null;
      return {
        jobId: job?.id ?? null,
        customerId: customer?.id ?? job?.customerId ?? null,
        summary: `Reminder due ${payload.dueAt as string}${job ? ` for job "${short(job.title)}"` : ''}`,
        clarifications,
      };
    }
    default:
      throw new HttpError(400, 'NOT_A_PROPOSE_TOOL', 'This tool does not create proposals.');
  }
}

// ---------------------------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------------------------

/**
 * Create (or replay) a proposal. Never changes a business record unless the owner has enabled
 * auto-approval for this tool (only job notes can be), in which case the note is executed with
 * `inferred` provenance in the same transaction.
 */
export async function createProposal(
  client: Queryable,
  input: {
    tenantId: string;
    requestId: string;
    tool: ToolDefinition;
    payload: Payload;
    meta: ProposalMeta;
    origin: ProposalOrigin;
  },
): Promise<{ proposal: ProposalDto; duplicate: boolean }> {
  const { tenantId, tool, payload, meta, origin } = input;
  const payloadHash = canonicalHash({ tool: tool.name, payload });
  // Without an agent-chosen key, an identical proposal from the same session on the same day is
  // treated as a replay of the same instruction.
  const key = meta.idempotencyKey
    ? `key:${meta.idempotencyKey}`
    : `auto:${canonicalHash({
        payloadHash,
        session: origin.sessionId ?? origin.sourceRef ?? null,
        day: new Date().toISOString().slice(0, 10),
      })}`;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `proposal:${tenantId}:${key}`,
  ]);
  const existing = await client.query<{ id: string; tool: string; payload: Payload }>(
    'SELECT id,tool,payload FROM action_proposals WHERE tenant_id=$1 AND idempotency_key=$2',
    [tenantId, key],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (canonicalHash({ tool: row.tool, payload: row.payload }) !== payloadHash)
      throw new HttpError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'This idempotency key was already used for a different proposal.',
      );
    return {
      proposal: proposalDto(await getProposalRow(client, tenantId, row.id)),
      duplicate: true,
    };
  }

  const described = await describeProposal(client, tenantId, tool.name, payload);
  const clarifications = [...(meta.clarifications ?? []), ...described.clarifications].slice(0, 8);
  const approval = await approvalPolicyFor(client, tenantId, tool.name);
  const id = randomUUID();
  await client.query(
    `INSERT INTO action_proposals(id,tenant_id,source,source_ref,session_id,tool,payload,summary,clarifications,
       approval_policy,idempotency_key,job_id,customer_id,created_by_type,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      id,
      tenantId,
      origin.source,
      origin.sourceRef ?? null,
      origin.sessionId ?? null,
      tool.name,
      JSON.stringify(payload),
      described.summary.slice(0, 500),
      JSON.stringify(clarifications),
      approval,
      key,
      described.jobId,
      described.customerId,
      origin.createdByType,
      origin.createdBy ?? null,
    ],
  );
  await recordAudit(client, {
    tenantId,
    actorType: origin.createdByType,
    actorId: origin.createdByType === 'user' ? (origin.createdBy ?? null) : null,
    action: 'proposal.created',
    entityType: 'action_proposal',
    entityId: id,
    requestId: input.requestId,
    metadata: { tool: tool.name, source: origin.source, approvalPolicy: approval },
  });

  // Owner-enabled auto policy (job notes only) executes immediately and is recorded as such.
  if (approval === 'auto' && clarifications.length === 0) {
    const row = await getProposalRow(client, tenantId, id, true);
    const result = await runExecutor(client, {
      tenantId,
      requestId: input.requestId,
      proposal: row,
      payload,
      actor: { type: 'system' },
      ownerInputs: {},
    });
    await client.query(
      `UPDATE action_proposals SET status='executed',decided_by_type='system',decided_at=now(),executed_at=now(),
         result_entity_type=$3,result_entity_id=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2`,
      [tenantId, id, result.entityType, result.entityId],
    );
    await recordAudit(client, {
      tenantId,
      actorType: 'system',
      actorId: null,
      action: 'proposal.auto_executed',
      entityType: 'action_proposal',
      entityId: id,
      requestId: input.requestId,
      metadata: { tool: tool.name, ...result },
    });
  }
  return { proposal: proposalDto(await getProposalRow(client, tenantId, id)), duplicate: false };
}

/** Re-validate an owner-edited payload with exactly the rules applied to agent input. */
export function revalidatePayload(tool: ToolName, edited: Payload): Payload {
  const parsed = parseToolCall(tool, edited);
  if (!parsed.ok)
    throw new HttpError(
      parsed.code === 'PRICE_FIELD_REFUSED' ? 422 : 400,
      parsed.code === 'INVALID_INPUT' ? 'VALIDATION_ERROR' : parsed.code,
      parsed.message,
      { issues: parsed.issues },
    );
  if (parsed.meta.idempotencyKey || parsed.meta.clarifications)
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      'Edited proposals cannot change replay keys or clarifications.',
    );
  return parsed.input;
}

// ---------------------------------------------------------------------------------------------
// Executors: deterministic domain commands, run inside the caller's transaction.
// ---------------------------------------------------------------------------------------------

export interface OwnerInputs {
  /** Owner-chosen markup for a material with a reported cost (basis points). */
  markupBasisPoints?: number | undefined;
}

interface ExecutionContext {
  tenantId: string;
  requestId: string;
  proposal: ProposalRow;
  payload: Payload;
  actor: ExecutionActor;
  ownerInputs: OwnerInputs;
}

export interface ExecutionResult {
  entityType: string;
  entityId: string;
}

export async function runExecutor(
  client: Queryable,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  const { tenantId, requestId, proposal, payload, actor, ownerInputs } = context;
  if (!isToolName(proposal.tool))
    throw new HttpError(409, 'EXECUTOR_NOT_AVAILABLE', 'Unknown proposal tool.');
  const tool = TOOL_DEFINITIONS[proposal.tool];
  if (!tool.executable)
    throw new HttpError(
      409,
      'EXECUTOR_NOT_AVAILABLE',
      tool.notExecutableReason ?? 'This proposal cannot be executed yet.',
    );
  const userId = actor.type === 'user' ? actor.id : null;
  const actorType = actor.type === 'user' ? 'user' : 'system';
  const audit = (action: string, entityType: string, entityId: string, metadata: Payload = {}) =>
    recordAudit(client, {
      tenantId,
      actorType,
      actorId: userId,
      action,
      entityType,
      entityId,
      requestId,
      metadata: { ...metadata, proposalId: proposal.id, origin: 'action_proposal' },
    });
  const event = (
    jobId: string,
    input: Omit<
      Parameters<typeof recordJobEvent>[1],
      'tenantId' | 'jobId' | 'actorType' | 'actorId'
    >,
  ) =>
    recordJobEvent(client, {
      tenantId,
      jobId,
      actorType,
      actorId: userId,
      ...input,
      metadata: { ...input.metadata, proposalId: proposal.id },
    });

  switch (proposal.tool) {
    case 'customer.create': {
      const id = randomUUID();
      await client.query(
        'INSERT INTO customers(id,tenant_id,name,preferred_name,email,phone,address) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          tenantId,
          payload.name,
          payload.preferredName ?? null,
          payload.email ?? null,
          payload.phone ?? null,
          payload.address ?? null,
        ],
      );
      await audit('customer.created', 'customer', id);
      return { entityType: 'customer', entityId: id };
    }
    case 'job.create': {
      const customer = await getCustomer(client, tenantId, payload.customerId as string);
      const property = payload.propertyId
        ? await propertyForCustomer(client, tenantId, customer.id, payload.propertyId as string)
        : null;
      const id = randomUUID();
      await client.query(
        "INSERT INTO jobs(id,tenant_id,customer_id,title,description,site_address,property_id,origin) VALUES($1,$2,$3,$4,$5,$6,$7,'assistant_proposed')",
        [
          id,
          tenantId,
          customer.id,
          payload.title,
          payload.description ?? null,
          property?.address ?? null,
          property?.id ?? null,
        ],
      );
      await event(id, {
        type: 'created',
        toStatus: 'new',
        summary: 'Job created from an approved assistant proposal',
        metadata: { origin: 'assistant_proposed', propertyId: property?.id ?? null },
      });
      await audit('job.created', 'job', id, { customerId: customer.id });
      return { entityType: 'job', entityId: id };
    }
    case 'job.update_status': {
      const locked = await client.query<{ status: JobStatus }>(
        'SELECT status FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [tenantId, payload.jobId],
      );
      const current = locked.rows[0];
      if (!current) throw new HttpError(404, 'JOB_NOT_FOUND', 'Job not found.');
      const to = payload.status as JobStatus;
      const check = checkJobTransition(current.status, to, { reopen: payload.reopen === true });
      if (!check.allowed)
        throw new HttpError(
          409,
          check.code === 'REOPEN_REQUIRED' ? 'REOPEN_REQUIRED' : 'INVALID_STATUS_TRANSITION',
          check.message,
        );
      await client.query(
        `UPDATE jobs SET status=$3,${check.setsCompletedAt ? 'completed_at=now(),' : ''}${
          check.clearsCompletedAt ? 'completed_at=NULL,' : ''
        }updated_at=now() WHERE tenant_id=$1 AND id=$2`,
        [tenantId, payload.jobId, to],
      );
      await event(payload.jobId as string, {
        type: 'status_changed',
        fromStatus: current.status,
        toStatus: to,
        summary: check.reopen
          ? 'Job reopened (approved proposal)'
          : 'Status changed (approved proposal)',
        metadata: { reopen: check.reopen },
      });
      await audit('job.updated', 'job', payload.jobId as string, {
        fields: ['status'],
        fromStatus: current.status,
        toStatus: to,
      });
      return { entityType: 'job', entityId: payload.jobId as string };
    }
    case 'job.add_note': {
      const jobId = payload.jobId as string;
      await jobFor(client, tenantId, jobId);
      // Approved by the owner: verified. Auto-executed: stays inferred until someone checks it.
      const provenance = actor.type === 'user' ? 'verified' : 'inferred';
      const id = randomUUID();
      await client.query(
        'INSERT INTO job_notes(id,tenant_id,job_id,author_id,text,provenance) VALUES($1,$2,$3,$4,$5,$6)',
        [id, tenantId, jobId, userId, payload.text, provenance],
      );
      await client.query(
        "INSERT INTO knowledge_items(id,tenant_id,customer_id,job_id,source_type,source_id,source_created_at,content,provenance) SELECT $1,$2,customer_id,$3,'job_note',$4,now(),$5,$6 FROM jobs WHERE tenant_id=$2 AND id=$3",
        [randomUUID(), tenantId, jobId, id, payload.text, provenance],
      );
      await event(jobId, {
        type: 'note_added',
        summary:
          actor.type === 'user'
            ? 'Note added (approved assistant proposal)'
            : 'Note added by the assistant (auto-approved by owner policy)',
        metadata: { noteId: id, provenance },
      });
      await audit('job.note_added', 'job', jobId, { noteId: id, provenance });
      return { entityType: 'job_note', entityId: id };
    }
    case 'job.record_time': {
      const jobId = payload.jobId as string;
      await jobFor(client, tenantId, jobId);
      const rate = await hourlyRate(client, tenantId, payload.rateCode as string);
      const id = randomUUID();
      await client.query(
        `INSERT INTO job_time_entries(id,tenant_id,job_id,rate_id,rate_code,quantity_milli,description,work_date,provenance,proposal_id,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'agent_proposed',$9,$10)`,
        [
          id,
          tenantId,
          jobId,
          rate.id,
          rate.code,
          payload.quantityMilli,
          payload.description ?? null,
          payload.workDate ?? null,
          proposal.id,
          userId,
        ],
      );
      await event(jobId, {
        type: 'time_recorded',
        summary: `${formatQuantityMilli(payload.quantityMilli as number)} h recorded (${short(rate.label, 60)})`,
        metadata: { timeEntryId: id, rateCode: rate.code, quantityMilli: payload.quantityMilli },
      });
      await audit('job.time_recorded', 'job_time_entry', id, {
        jobId,
        rateCode: rate.code,
        quantityMilli: payload.quantityMilli,
      });
      return { entityType: 'job_time_entry', entityId: id };
    }
    case 'job.add_material': {
      const jobId = payload.jobId as string;
      await jobFor(client, tenantId, jobId);
      const cost = payload.reportedUnitCostCents as number | undefined;
      let priced: { markup: number; sell: number } | null = null;
      if (cost !== undefined) {
        if (actor.type !== 'user' || ownerInputs.markupBasisPoints === undefined)
          throw new HttpError(
            422,
            'MARKUP_REQUIRED',
            'This material has a reported supplier cost. Choose the markup (basis points) when approving.',
          );
        priced = {
          markup: ownerInputs.markupBasisPoints,
          sell: costPlusMarkupCents(cost, ownerInputs.markupBasisPoints),
        };
      }
      const id = randomUUID();
      await client.query(
        `INSERT INTO job_materials(id,tenant_id,job_id,description,unit,quantity_milli,unit_cost_cents,markup_bp,sell_unit_cents,
           price_source,cost_provenance,cost_confirmed_by,supplier,provenance,proposal_id,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'agent_proposed',$14,$15)`,
        [
          id,
          tenantId,
          jobId,
          payload.description,
          payload.unit,
          payload.quantityMilli,
          priced ? cost : null,
          priced?.markup ?? null,
          priced?.sell ?? null,
          priced ? 'cost_plus_markup' : 'unpriced',
          priced ? 'agent_reported' : null,
          priced ? userId : null,
          payload.supplier ?? null,
          proposal.id,
          userId,
        ],
      );
      await event(jobId, {
        type: 'material_added',
        summary: `Material added: ${formatQuantityMilli(payload.quantityMilli as number)} ${payload.unit as string}`,
        metadata: { materialId: id, priced: priced !== null },
      });
      await audit('job.material_added', 'job_material', id, {
        jobId,
        quantityMilli: payload.quantityMilli,
        priceSource: priced ? 'cost_plus_markup' : 'unpriced',
        ...(priced ? { markupBasisPoints: priced.markup, sellUnitCents: priced.sell } : {}),
      });
      return { entityType: 'job_material', entityId: id };
    }
    case 'quote.prepare': {
      const job = await jobFor(client, tenantId, payload.jobId as string);
      const lines = payload.lines as Array<{
        rateCode: string;
        quantityMilli: number;
        description?: string;
      }>;
      if (lines.some((line) => line.quantityMilli % 1000 !== 0))
        throw new HttpError(
          422,
          'FRACTIONAL_QUANTITY_UNSUPPORTED',
          'Draft quotes currently take whole-unit quantities.',
        );
      const business = await loadBusiness(client, tenantId);
      const calculation = calculateQuote({
        requested: lines.map((line) => ({
          rateCode: line.rateCode,
          quantity: line.quantityMilli / 1000,
          ...(line.description ? { description: line.description } : {}),
        })),
        approvedRates: await loadRates(client, tenantId),
        policy: quotePolicy(business),
        assumptions: (payload.assumptions as string[] | undefined) ?? [],
        missingInformation: (payload.missingInformation as string[] | undefined) ?? [],
      });
      const quoteId = randomUUID();
      await client.query(
        'INSERT INTO quotes(id,tenant_id,customer_id,job_id,currency,assumptions,missing_information,subtotal_cents,tax_cents,total_cents,tax_basis_points,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [
          quoteId,
          tenantId,
          job.customerId,
          job.id,
          business.currency,
          JSON.stringify(calculation.assumptions),
          JSON.stringify(calculation.missingInformation),
          calculation.subtotalCents,
          calculation.taxCents,
          calculation.totalCents,
          calculation.taxBasisPoints,
          userId,
        ],
      );
      await writeQuoteLines(client, tenantId, quoteId, calculation);
      const approvalId = randomUUID();
      await client.query(
        "INSERT INTO approval_requests(id,tenant_id,subject_type,quote_id,status,requested_by) VALUES($1,$2,'quote',$3,'pending',$4)",
        [approvalId, tenantId, quoteId, userId],
      );
      await event(job.id, {
        type: 'quote_drafted',
        summary: 'Draft quote prepared from approved rates; awaiting owner approval',
        metadata: { quoteId, version: 1, totalCents: calculation.totalCents },
      });
      await audit('quote.drafted', 'quote', quoteId, {
        version: 1,
        totalCents: calculation.totalCents,
        lines: calculation.lines.length,
      });
      await audit('approval.requested', 'approval_request', approvalId, { quoteId });
      return { entityType: 'quote', entityId: quoteId };
    }
    case 'communication.draft': {
      const described = await describeProposal(client, tenantId, 'communication.draft', payload);
      const id = randomUUID();
      await client.query(
        "INSERT INTO communications(id,tenant_id,customer_id,job_id,direction,channel,status,subject,text) VALUES($1,$2,$3,$4,'outbound',$5,'draft',$6,$7)",
        [
          id,
          tenantId,
          described.customerId,
          described.jobId,
          payload.channel,
          payload.subject ?? null,
          payload.text,
        ],
      );
      if (described.jobId)
        await event(described.jobId, {
          type: 'communication_drafted',
          summary: `Draft ${payload.channel as string} message saved (not sent)`,
          metadata: { communicationId: id },
        });
      await audit('communication.drafted', 'communication', id, {
        channel: payload.channel,
        customerId: described.customerId,
      });
      return { entityType: 'communication', entityId: id };
    }
    default:
      throw new HttpError(409, 'EXECUTOR_NOT_AVAILABLE', 'This proposal cannot be executed yet.');
  }
}
