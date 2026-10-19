import {
  AgentRuntimeError,
  parseProposal,
  validateRequest,
  type AgentEvent,
  type AgentHealth,
  type AgentRun,
  type AgentRuntime,
  type AgentSession,
  type InterpretationRequest,
  type WorkProposal,
} from './types.js';

export const MOCK_AGENT_LABEL =
  'Mock agent runtime: deterministic pattern matching, no AI model. Not evidence of a real OpenClaw integration.';

/** Deterministic, synthetic demo interpreter. It never calls a model and never sees prices. */
export class MockAgentRuntime implements AgentRuntime {
  private readonly runs = new Map<
    string,
    { run: AgentRun; request: InterpretationRequest; cancelled: boolean }
  >();

  async interpret(request: InterpretationRequest): Promise<WorkProposal> {
    validateRequest(request);
    return mockProposal(request);
  }

  async createRun(request: InterpretationRequest): Promise<AgentRun> {
    validateRequest(request);
    if (this.runs.size >= 100) this.runs.delete(this.runs.keys().next().value!);
    const run = {
      requestId: request.requestId,
      runId: `mock-${request.requestId}`,
      sessionId: `mock-${request.requestId}`,
    };
    this.runs.set(run.runId, { run, request: structuredClone(request), cancelled: false });
    return run;
  }

  async *stream(run: AgentRun): AsyncIterable<AgentEvent> {
    const state = this.owned(run);
    yield { ...run, type: 'started' };
    if (state.cancelled) {
      yield { ...run, type: 'cancelled' };
      return;
    }
    yield { ...run, type: 'completed', proposal: mockProposal(state.request) };
  }

  async getSession(sessionId: string): Promise<AgentSession> {
    const state = [...this.runs.values()].find((value) => value.run.sessionId === sessionId);
    if (!state) throw new AgentRuntimeError('INVALID_REQUEST', 'Unknown assistant session.');
    return { sessionId, messages: [{ role: 'user', text: state.request.prompt }] };
  }

  async cancel(run: AgentRun): Promise<void> {
    this.owned(run).cancelled = true;
  }

  async health(): Promise<AgentHealth> {
    return {
      status: 'ok',
      runtime: 'mock',
      synthetic: true,
      version: 'mock-1',
      provider: 'mock',
      inferenceLocation: 'local',
      attestation: 'runtime',
      detail: MOCK_AGENT_LABEL,
    };
  }

  async close(): Promise<void> {
    this.runs.clear();
  }

  private owned(run: AgentRun) {
    const state = this.runs.get(run.runId);
    if (!state || state.run.sessionId !== run.sessionId || state.run.requestId !== run.requestId)
      throw new AgentRuntimeError('INVALID_REQUEST', 'Unknown assistant run.');
    return state;
  }
}

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];
const QUANTITY = String.raw`(\d{1,4}|${NUMBER_WORDS.slice(1).join('|')}|a|an|single)`;

function quantityFrom(token: string | undefined): number | null {
  if (!token) return null;
  const lower = token.toLowerCase();
  if (/^\d+$/.test(lower)) return Number(lower) > 0 && Number(lower) <= 1000 ? Number(lower) : null;
  if (lower === 'a' || lower === 'an' || lower === 'single') return 1;
  const index = NUMBER_WORDS.indexOf(lower);
  return index > 0 ? index : null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface WorkPattern {
  noun: RegExp;
  rateCode: (text: string) => string;
  description: string;
}

const WORK: WorkPattern[] = [
  {
    noun: /power\s*points?|sockets?|outlets?/,
    rateCode: (text) =>
      /\b(new|extra|additional|add|install)\b/i.test(text) && !/\breplac/i.test(text)
        ? 'power_point_new'
        : 'power_point_replace',
    description: 'Power points',
  },
  {
    noun: /light\s*fittings?|light\s*fixtures?|lights?/,
    rateCode: () => 'light_fitting_replace',
    description: 'Light fittings',
  },
];

function mockProposal(request: InterpretationRequest): WorkProposal {
  const { prompt, context } = request;
  const offered = new Set(context.rates.map((rate) => rate.code));
  const lineItems: WorkProposal['lineItems'] = [];
  const assumptions = ['Interpreted by the mock agent runtime (deterministic, no AI model).'];
  for (const work of WORK) {
    const counted = new RegExp(
      String.raw`\b${QUANTITY}\s+(?:[a-z-]+\s+){0,2}?(?:${work.noun.source})\b`,
      'i',
    ).exec(prompt);
    const mentioned =
      counted ?? new RegExp(String.raw`\b(?:${work.noun.source})\b`, 'i').exec(prompt);
    if (!mentioned) continue;
    const code = work.rateCode(prompt);
    lineItems.push({
      rateCode: offered.has(code) ? code : null,
      quantity: quantityFrom(counted?.[1]),
      description: work.description,
    });
    if (code === 'power_point_replace')
      assumptions.push('Like-for-like replacement of standard double power points.');
  }
  const covered = /power\s*points?|sockets?|outlets?|light/i.test(prompt);
  if (!covered)
    lineItems.push({
      rateCode: null,
      quantity: null,
      description: prompt.trim().slice(0, 120) || 'Requested work',
    });

  // Identity is only a hint; the server resolves it against its own records.
  const named = context.customers.find((customer) =>
    new RegExp(String.raw`\b${escapeRegex(customer.name)}\b`, 'i').test(prompt),
  );
  const honorific = /\b(?:[Mm]rs|[Mm]r|[Mm]s|[Mm]iss|[Dd]r)\.?\s+\p{Lu}[\p{L}'-]+/u.exec(
    prompt,
  )?.[0];
  const surname = context.customers
    .map((customer) => customer.name.split(/\s+/).at(-1) ?? '')
    .find(
      (last) => last.length > 2 && new RegExp(String.raw`\b${escapeRegex(last)}\b`).test(prompt),
    );
  const customerQuery = named?.name ?? honorific ?? surname ?? '';
  const missingInformation = customerQuery ? [] : ['Which customer is this enquiry for?'];
  const summary = lineItems
    .map((item) =>
      item.quantity
        ? `${item.quantity} × ${item.description.toLowerCase()}`
        : item.description.toLowerCase(),
    )
    .join(', ');
  return parseProposal(
    {
      customerQuery,
      workSummary: (covered ? `Replace or install: ${summary}` : summary).slice(0, 500),
      lineItems,
      missingInformation,
      assumptions,
    },
    request,
  );
}
