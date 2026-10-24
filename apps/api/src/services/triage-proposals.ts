import type { MessageTriage } from '@opentradie/agent';
import { parseToolCall } from '@opentradie/core';
import { recordAudit, type Queryable } from '@opentradie/database';
import { createProposal } from '../tools/proposals.js';
import { findAvailableSlots } from './scheduling.js';

/**
 * Turns inbox triage suggestions into action proposals for the Approval inbox (ADR 0022
 * amendment). The model only ever returns suggestion *labels*; it never names a tool or supplies
 * an id. The server maps each label to an agent tool call built from records it has already
 * matched, validates it through the same tool registry the MCP gateway uses, and stores a
 * pending proposal. Nothing executes here: proposals from email are never auto-approved, even
 * where the owner allows auto-approval for agent notes.
 */

export interface TriageProposalSource {
  communicationId: string;
  customerId: string | null;
  jobId: string | null;
  /** True when the inbox pipeline created the job from this very message. */
  jobCreatedFromMessage: boolean;
  subject: string | null;
  senderLabel: string;
}

export interface ToolCallCandidate {
  name: string;
  args: Record<string, unknown>;
}

type Suggestion = MessageTriage['suggestedActions'][number];

/** Server-built tool calls for the suggestions. Labels without a safe mapping produce nothing. */
export async function toolCallsForTriage(
  client: Queryable,
  tenantId: string,
  triage: Pick<MessageTriage, 'classification' | 'summary' | 'suggestedActions'>,
  source: TriageProposalSource,
): Promise<ToolCallCandidate[]> {
  if (triage.classification === 'spam_or_automated') return [];
  const types = new Set<Suggestion['type']>(triage.suggestedActions.map((action) => action.type));
  const calls: ToolCallCandidate[] = [];
  const existingJob = source.jobId && !source.jobCreatedFromMessage ? source.jobId : null;

  if (types.has('create_job') && source.customerId && !source.jobId)
    calls.push({
      name: 'job.create',
      args: {
        customerId: source.customerId,
        title: (source.subject ?? '').trim().slice(0, 300) || 'Email enquiry',
      },
    });

  if (types.has('link_to_job') && existingJob)
    calls.push({
      name: 'job.add_note',
      args: {
        jobId: existingJob,
        text: `Email from ${source.senderLabel}: ${triage.summary}`.slice(0, 4000),
      },
    });

  if (types.has('schedule_visit') && source.jobId) {
    const availability = await findAvailableSlots(client, tenantId, {
      durationMinutes: 60,
      days: 14,
      limit: 1,
      stepMinutes: 30,
    });
    const slot = availability.slots[0];
    if (slot)
      calls.push({
        name: 'schedule.propose',
        args: { jobId: source.jobId, startsAt: slot.startsAt, endsAt: slot.endsAt },
      });
  }
  // draft_quote needs rate codes and quantities, and request_information is answered by the
  // reply draft; both stay as labels for the owner.
  return calls;
}

/**
 * Validate each candidate through the agent tool registry and create pending proposals with
 * source 'email' and the communication id as source_ref. Refused candidates (unknown tools,
 * read tools, invalid input) are audited by tool name and error code only.
 */
export async function proposeFromTriage(
  client: Queryable,
  input: {
    tenantId: string;
    requestId: string;
    communicationId: string;
    calls: ToolCallCandidate[];
  },
): Promise<{ created: string[]; refused: Array<{ tool: string; code: string }> }> {
  const created: string[] = [];
  const refused: Array<{ tool: string; code: string }> = [];
  for (const call of input.calls.slice(0, 5)) {
    const toolLabel = /^[a-z_.]{1,64}$/.test(call.name) ? call.name : 'invalid';
    const parsed = parseToolCall(call.name, call.args);
    const code = !parsed.ok
      ? parsed.code
      : parsed.tool.risk !== 'propose'
        ? 'NOT_A_PROPOSE_TOOL'
        : null;
    if (!parsed.ok || code) {
      refused.push({ tool: toolLabel, code: code ?? 'INVALID_INPUT' });
      continue;
    }
    const { proposal, duplicate } = await createProposal(client, {
      tenantId: input.tenantId,
      requestId: input.requestId,
      tool: parsed.tool,
      payload: parsed.input,
      meta: { idempotencyKey: `email-${input.communicationId}-${call.name.replace('.', '_')}` },
      origin: { source: 'email', sourceRef: input.communicationId, createdByType: 'agent' },
      allowAutoExecute: false,
    });
    if (!duplicate) created.push(proposal.id);
  }
  if (refused.length)
    await recordAudit(client, {
      tenantId: input.tenantId,
      actorType: 'system',
      actorId: null,
      action: 'communication.triage_proposals_refused',
      entityType: 'communication',
      entityId: input.communicationId,
      requestId: input.requestId,
      metadata: { refused },
    });
  return { created, refused };
}
