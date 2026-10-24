import {
  MockAgentRuntime,
  OPENCLAW_VERSION,
  RealOpenClawAgentRuntime,
  mockTriage,
  mockVoiceExtraction,
  type GatewayConnection,
  type InterpretationRequest,
  type OpenClawTestDependencies,
} from '@opentradie/agent';

type GatewayClientOptions = Parameters<
  NonNullable<OpenClawTestDependencies['connectionFactory']>
>[0];

/**
 * A fake OpenClaw Gateway behind the REAL RealOpenClawAgentRuntime adapter. It answers each
 * chat.send with one final chat message chosen by `reply`. Not evidence of a live integration.
 */
export class FakeGateway implements GatewayConnection {
  constructor(
    readonly options: GatewayClientOptions,
    private readonly reply: (message: string) => string | Promise<string>,
    readonly sent: Array<Record<string, unknown>> = [],
  ) {}
  start(): void {
    this.options.onHelloOk?.({
      protocol: 4,
      server: { version: OPENCLAW_VERSION },
      features: {
        methods: ['chat.send', 'chat.abort', 'chat.history', 'health'],
        events: ['chat'],
      },
    } as never);
  }
  stop(): void {}
  async stopAndWait(): Promise<void> {}
  async request<T>(method: string, params?: unknown): Promise<T> {
    if (method !== 'chat.send') return { ok: true } as T;
    const sent = params as Record<string, unknown>;
    this.sent.push(sent);
    const runId = `fake-run-${this.sent.length}`;
    const text = await this.reply(String(sent.message));
    setTimeout(() =>
      this.options.onEvent?.({
        type: 'event',
        event: 'chat',
        payload: {
          runId,
          sessionKey: sent.sessionKey,
          seq: 1,
          state: 'final',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
        },
      } as never),
    );
    return { runId, status: 'started' } as T;
  }
}

/**
 * Plays the model: reads the delimited data block back out of the prompt and answers with the
 * deterministic mock's output, so a test can assert the Gateway path matches the mock path.
 */
export async function mockModelReply(message: string): Promise<string> {
  const lines = message.split('\n');
  const enquiry = lines.find((line) => line.includes('"untrustedMessage"'));
  if (enquiry) {
    const data = JSON.parse(enquiry) as {
      requestId: string;
      untrustedMessage: string;
      untrustedBusinessContext: InterpretationRequest['context'];
    };
    return JSON.stringify(
      await new MockAgentRuntime().interpret({
        requestId: data.requestId,
        prompt: data.untrustedMessage,
        context: data.untrustedBusinessContext,
      }),
    );
  }
  const openIndex = (marker: string) => lines.findIndex((line) => line.startsWith(marker));
  const email = openIndex('<<<UNTRUSTED_EMAIL ');
  if (email >= 0) {
    const context = JSON.parse(lines[email - 1]!) as Record<string, string | null>;
    const body = JSON.parse(lines[email + 1]!) as Record<string, unknown>;
    return JSON.stringify(
      mockTriage({
        requestId: String(context.requestId),
        message: {
          subject: String(body.subject),
          senderName: String(body.senderName),
          bodyText: String(body.body),
          attachmentNames: body.attachmentNames as string[],
        },
        context: {
          businessName: String(context.businessName),
          customerName: context.matchedCustomerName ?? null,
          jobTitle: context.matchedJobTitle ?? null,
        },
      }),
    );
  }
  const start = openIndex('<<<UNTRUSTED_TRANSCRIPT ');
  const end = openIndex('<<<END_UNTRUSTED_TRANSCRIPT ');
  return (
    '```json\n' +
    JSON.stringify(
      mockVoiceExtraction({
        requestId: 'fake',
        transcript: lines.slice(start + 1, end).join('\n'),
      }),
    ) +
    '\n```'
  );
}

export function fakeGatewayRuntime(
  options: {
    location?: 'local' | 'hosted';
    reply?: (message: string) => string | Promise<string>;
  } = {},
): { runtime: RealOpenClawAgentRuntime; sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  const runtime = new RealOpenClawAgentRuntime(
    {
      url: 'ws://127.0.0.1:18789',
      token: 'synthetic-test-token',
      deviceStatePath: '/unused-in-injected-test',
      timeoutMs: 5000,
      modelProvider: 'ollama',
      inferenceLocation: options.location ?? 'local',
    },
    {
      hostDeps: {},
      connectionFactory: (gatewayOptions) =>
        new FakeGateway(gatewayOptions, options.reply ?? mockModelReply, sent),
    },
  );
  return { runtime, sent };
}
