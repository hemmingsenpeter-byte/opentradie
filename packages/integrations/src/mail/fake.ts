import { TransientError } from '../errors.js';
import { composeMime } from './mime.js';
import type {
  InboundEmail,
  MailChanges,
  MailConnections,
  MailProvider,
  OutboundEmail,
  SendResult,
} from './types.js';

/** In-memory mail provider for tests and demos. It sends nothing anywhere. */
export class FakeMailAdapter implements MailProvider {
  readonly provider = 'fake' as const;
  readonly sent: Array<OutboundEmail & { mime: string; providerMessageId: string }> = [];
  private readonly inbox = new Map<string, InboundEmail>();
  private sequence = 0;
  /** Set to make the next sends fail with a transient error. */
  failNextSends = 0;

  deliver(message: InboundEmail): string {
    const id = `fake-${++this.sequence}`;
    this.inbox.set(id, { ...message, providerMessageId: id });
    return id;
  }

  async fetchMessage(providerMessageId: string): Promise<InboundEmail> {
    const message = this.inbox.get(providerMessageId);
    if (!message) throw new TransientError('Fake message not found.', 'not_found', 'fake');
    return message;
  }

  async listChanges(cursor: string | null): Promise<MailChanges> {
    const from = cursor === null ? this.sequence : Number(cursor);
    const ids = [...this.inbox.keys()].filter((id) => Number(id.slice(5)) > from);
    return { messageIds: ids, nextCursor: String(this.sequence) };
  }

  async send(message: OutboundEmail): Promise<SendResult> {
    if (this.failNextSends > 0) {
      this.failNextSends--;
      throw new TransientError('Fake send failure.', 'network', 'fake');
    }
    const providerMessageId = `fake-sent-${this.sent.length + 1}`;
    this.sent.push({ ...message, mime: composeMime(message), providerMessageId });
    return { providerMessageId, providerThreadId: message.providerThreadId ?? null };
  }
}

/** Every tenant uses the same fake provider. */
export function fakeMailConnections(adapter: FakeMailAdapter): MailConnections {
  return { forTenant: async () => adapter };
}
