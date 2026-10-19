export interface InterpretationRequest {
  requestId: string;
  prompt: string;
  context: {
    customers: Array<{ id: string; name: string }>;
    notes: string[];
    rates: Array<{ code: string; label: string }>;
  };
}

/** An untrusted suggestion, never a financial document or approval. */
export interface WorkProposal {
  customerQuery: string;
  workSummary: string;
  rateCode: string | null;
  quantity: number | null;
  missingInformation: string[];
}

export interface AgentHealth {
  status: 'ok' | 'unavailable';
  runtime: 'mock' | 'openclaw';
  synthetic: boolean;
  version: string;
  inferenceLocation: 'local' | 'unverified';
  detail?: string;
}

export interface AgentRun {
  runId: string;
  sessionId: string;
  requestId: string;
}

export type AgentEvent = AgentRun & (
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
  constructor(readonly code: AgentErrorCode, message: string) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}

export function validateRequest(request: InterpretationRequest): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(request.requestId) || request.prompt.trim().length === 0 || request.prompt.length > 10_000 || JSON.stringify(request.context).length > 100_000) {
    throw new AgentRuntimeError('INVALID_REQUEST', 'Invalid assistant request or context size.');
  }
}

/** Reject extra keys and unknown rate codes, including invented amounts. */
export function parseProposal(value: unknown, request: InterpretationRequest): WorkProposal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidOutput();
  const record = value as Record<string, unknown>;
  const keys = ['customerQuery', 'workSummary', 'rateCode', 'quantity', 'missingInformation'];
  if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key))) throw invalidOutput();
  if (typeof record.customerQuery !== 'string' || record.customerQuery.length > 200 || typeof record.workSummary !== 'string' || record.workSummary.trim().length === 0 || record.workSummary.length > 2000) throw invalidOutput();
  if (record.rateCode !== null && (typeof record.rateCode !== 'string' || !request.context.rates.some((rate) => rate.code === record.rateCode))) throw invalidOutput();
  if (record.quantity !== null && (typeof record.quantity !== 'number' || !Number.isSafeInteger(record.quantity) || record.quantity <= 0 || record.quantity > 1000)) throw invalidOutput();
  if (!Array.isArray(record.missingInformation) || record.missingInformation.length > 20 || record.missingInformation.some((item: unknown) => typeof item !== 'string' || item.length > 500)) throw invalidOutput();
  return {
    customerQuery: record.customerQuery,
    workSummary: record.workSummary,
    rateCode: record.rateCode as string | null,
    quantity: record.quantity as number | null,
    missingInformation: [...record.missingInformation] as string[],
  };
}

function invalidOutput(): AgentRuntimeError {
  return new AgentRuntimeError('INVALID_OUTPUT', 'Assistant returned an invalid proposal. Clarification is required.');
}
