import { AgentRuntimeError, parseProposal, validateRequest, type AgentEvent, type AgentHealth, type AgentRun, type AgentRuntime, type AgentSession, type InterpretationRequest, type WorkProposal } from './types.js';

/** Deliberately limited, synthetic demo parser. It never calls a model. */
export class MockAgentRuntime implements AgentRuntime {
  private readonly runs = new Map<string, { run: AgentRun; request: InterpretationRequest; cancelled: boolean }>();

  async interpret(request: InterpretationRequest): Promise<WorkProposal> {
    validateRequest(request);
    return demoProposal(request);
  }

  async createRun(request: InterpretationRequest): Promise<AgentRun> {
    validateRequest(request);
    if (this.runs.size >= 100) this.runs.delete(this.runs.keys().next().value!);
    const run = { requestId: request.requestId, runId: `mock-${request.requestId}`, sessionId: `mock-${request.requestId}` };
    this.runs.set(run.runId, { run, request: structuredClone(request), cancelled: false });
    return run;
  }

  async *stream(run: AgentRun): AsyncIterable<AgentEvent> {
    const state = this.runs.get(run.runId);
    if (!state || state.run.sessionId !== run.sessionId || state.run.requestId !== run.requestId) throw new AgentRuntimeError('INVALID_REQUEST', 'Unknown assistant run.');
    yield { ...run, type: 'started' };
    if (state.cancelled) { yield { ...run, type: 'cancelled' }; return; }
    yield { ...run, type: 'completed', proposal: demoProposal(state.request) };
  }

  async getSession(sessionId: string): Promise<AgentSession> {
    const state = [...this.runs.values()].find((value) => value.run.sessionId === sessionId);
    if (!state) throw new AgentRuntimeError('INVALID_REQUEST', 'Unknown assistant session.');
    return { sessionId, messages: [{ role: 'user', text: state.request.prompt }] };
  }

  async cancel(run: AgentRun): Promise<void> {
    const state = this.runs.get(run.runId);
    if (!state || state.run.sessionId !== run.sessionId || state.run.requestId !== run.requestId) throw new AgentRuntimeError('INVALID_REQUEST', 'Unknown assistant run.');
    state.cancelled = true;
  }

  async health(): Promise<AgentHealth> { return { status: 'ok', runtime: 'mock', synthetic: true, version: 'demo-v1', inferenceLocation: 'local' }; }
  async close(): Promise<void> { this.runs.clear(); }
}

function demoProposal(request: InterpretationRequest): WorkProposal {
  const { prompt, context } = request;
  const lower = prompt.toLowerCase();
  const names = context.customers.filter((customer) => {
    const name = customer.name.toLowerCase();
    const surname = name.split(/\s+/).at(-1);
    return lower.includes(name) || Boolean(surname && surname.length > 2 && new RegExp(`\\b${escapeRegex(surname)}\\b`, 'i').test(prompt));
  });
  const customerQuery = names.length === 1 ? names[0]!.name : /\b(?:mrs|mr|ms|miss)\.?\s+[a-z]+/i.exec(prompt)?.[0] ?? '';
  const powerPoints = /\bpower\s*points?\b/i.test(prompt);
  const rateCode = powerPoints && context.rates.some((rate) => rate.code === 'power_point') ? 'power_point' : null;
  // Only an explicit positive quantity immediately before the work item counts.
  const token = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+power\s*points?\b/i.exec(prompt)?.[1]?.toLowerCase();
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const extracted = token ? (/^\d+$/.test(token) ? Number(token) : words.indexOf(token)) : null;
  const quantity = extracted !== null && extracted > 0 && extracted <= 1000 ? extracted : null;
  const missingInformation: string[] = [];
  if (names.length !== 1) missingInformation.push(names.length > 1 ? 'Confirm which matching customer this enquiry concerns.' : 'Identify the customer.');
  if (rateCode === null) missingInformation.push('Select an approved rate for this work.');
  if (quantity === null) missingInformation.push('Confirm the quantity of work.');
  missingInformation.push('Confirm site access, scope and whether extra materials are required.');
  return parseProposal({ customerQuery, workSummary: powerPoints ? 'Replace requested power points' : prompt.trim().slice(0, 2000), rateCode, quantity, missingInformation }, request);
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
