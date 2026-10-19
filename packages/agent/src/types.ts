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

export interface AgentRuntime {
  interpret(request: InterpretationRequest): Promise<WorkProposal>;
  createRun(request: InterpretationRequest): Promise<AgentRun>;
  stream(run: AgentRun): AsyncIterable<AgentEvent>;
  getSession(sessionId: string): Promise<AgentSession>;
  cancel(run: AgentRun): Promise<void>;
  health(): Promise<AgentHealth>;
  close(): Promise<void>;
}

export type AgentErrorCode = 'UNAVAILABLE' | 'TIMEOUT' | 'CANCELLED' | 'INVALID_OUTPUT' | 'VERSION_MISMATCH' | 'INVALID_REQUEST';

export class AgentRuntimeError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentRuntimeError';
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
    throw new AgentRuntimeError('INVALID_OUTPUT', 'Assistant returned an invalid proposal. Clarification is required.');
  }
}
