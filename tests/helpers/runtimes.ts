import { MockAgentRuntime, type AgentHealth, type AgentRuntime, type InterpretationRequest, type WorkProposal } from '@opentradie/agent';

/** A test double standing in for a model-backed runtime at a chosen location. Not a real integration. */
export class StubRuntime extends MockAgentRuntime implements AgentRuntime {
  readonly calls: InterpretationRequest[] = [];
  constructor(
    private readonly options: {
      location?: AgentHealth['inferenceLocation'];
      status?: AgentHealth['status'];
      provider?: string;
      output?: (request: InterpretationRequest) => unknown;
    } = {},
  ) {
    super();
  }
  override async interpret(request: InterpretationRequest): Promise<WorkProposal> {
    this.calls.push(request);
    if (this.options.output) return this.options.output(request) as WorkProposal;
    return super.interpret(request);
  }
  override async health(): Promise<AgentHealth> {
    return {
      status: this.options.status ?? 'ok',
      runtime: 'openclaw',
      synthetic: false,
      version: 'stub',
      provider: this.options.provider ?? 'openclaw:openrouter',
      inferenceLocation: this.options.location ?? 'hosted',
      attestation: 'operator',
    };
  }
}
