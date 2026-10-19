import { parseWorkProposal, type ModelLocation, type WorkProposal } from '@opentradie/core';

export type { WorkProposal };

/**
 * What the agent may see: the untrusted enquiry text, customer display names and the codes and
 * labels of approved rates. Never prices, notes, contact details or identifiers.
 */
export interface InterpretationRequest {
  requestId: string;
  prompt: string;
  context: {
    customers: Array<{ name: string }>;
    rates: Array<{ code: string; label: string; unit: string }>;
  };
}

export interface AgentHealth {
  status: 'ok' | 'unavailable';
  runtime: 'mock' | 'openclaw';
  /** True for the deterministic mock: no model is involved and nothing proves a real integration. */
  synthetic: boolean;
  version: string;
  provider: string;
  inferenceLocation: ModelLocation;
  attestation: 'runtime' | 'operator';
  detail?: string;
}

export interface AgentRun {
  runId: string;
  sessionId: string;
  requestId: string;
}

export type AgentEvent = AgentRun &
  (
    | { type: 'started' }
    | { type: 'delta'; text: string; replace: boolean }
    | { type: 'completed'; proposal: WorkProposal }
    | { type: 'cancelled' }
    | { type: 'failed'; code: AgentErrorCode }
  );

export interface AgentSession {
  sessionId: string;
  messages: Array<{ role: string; text: string }>;
}

/**
 * A request to turn untrusted text about one job (for example a transcribed voice note) into
 * business tool calls. The agent sees the job's status and the approved rate codes, never prices.
 */
export interface JobActionRequest {
  requestId: string;
  text: string;
  context: {
    jobStatus: string;
    rates: Array<{ code: string; label: string; unit: string }>;
  };
}

/** One tool call the agent wants to make. Untrusted: the API validates it with the tool registry. */
export interface PlannedToolCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface AgentRuntime {
  interpret(request: InterpretationRequest): Promise<WorkProposal>;
  /**
   * Optional in-process planner used by the assistant screen. The OpenClaw runtime does not
   * implement it: a real Gateway calls the business tools through the MCP tool gateway instead.
   */
  planJobActions?(request: JobActionRequest): Promise<PlannedToolCall[]>;
  createRun(request: InterpretationRequest): Promise<AgentRun>;
  stream(run: AgentRun): AsyncIterable<AgentEvent>;
  getSession(sessionId: string): Promise<AgentSession>;
  cancel(run: AgentRun): Promise<void>;
  health(): Promise<AgentHealth>;
  close(): Promise<void>;
}

export type AgentErrorCode =
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INVALID_OUTPUT'
  | 'VERSION_MISMATCH'
  | 'INVALID_REQUEST';

export class AgentRuntimeError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}

export function validateJobActionRequest(request: JobActionRequest): void {
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(request.requestId) ||
    request.text.trim().length === 0 ||
    request.text.length > 4_000 ||
    JSON.stringify(request.context).length > 100_000
  ) {
    throw new AgentRuntimeError('INVALID_REQUEST', 'Invalid assistant request or context size.');
  }
}

export function validateRequest(request: InterpretationRequest): void {
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(request.requestId) ||
    request.prompt.trim().length === 0 ||
    request.prompt.length > 10_000 ||
    JSON.stringify(request.context).length > 100_000
  ) {
    throw new AgentRuntimeError('INVALID_REQUEST', 'Invalid assistant request or context size.');
  }
}

/** Agent output is untrusted: strict schema, no extra keys (so no prices), only offered rate codes. */
export function parseProposal(value: unknown, request: InterpretationRequest): WorkProposal {
  try {
    return parseWorkProposal(
      value,
      request.context.rates.map((rate) => rate.code),
    );
  } catch {
    throw new AgentRuntimeError(
      'INVALID_OUTPUT',
      'Assistant returned an invalid proposal. Clarification is required.',
    );
  }
}
