/**
 * MessagingProvider contract for WhatsApp Business (Cloud API) and SMS. Planned: only this
 * interface and an in-memory fake exist. No WhatsApp integration is implemented or claimed.
 */
export type MessagingProviderName = 'whatsapp_business' | 'sms' | 'fake';

export interface InboundChatMessage {
  /** Provider message id (WhatsApp `wamid...`), the de-duplication key. */
  providerMessageId: string;
  /** E.164 phone number of the sender. */
  fromPhone: string;
  fromName: string | null;
  text: string;
  receivedAt: Date;
}

export interface OutboundChatMessage {
  toPhone: string;
  text: string;
  /** WhatsApp requires an approved template outside the 24-hour customer service window. */
  template?: { name: string; language: string; parameters: string[] } | null;
}

export interface MessagingProvider {
  readonly provider: MessagingProviderName;
  /** Only ever called after an owner approval is recorded. */
  send(message: OutboundChatMessage): Promise<{ providerMessageId: string }>;
}

export class FakeMessagingProvider implements MessagingProvider {
  readonly provider = 'fake' as const;
  readonly sent: Array<OutboundChatMessage & { providerMessageId: string }> = [];
  async send(message: OutboundChatMessage) {
    if (!/^\+[1-9]\d{6,14}$/.test(message.toPhone)) throw new Error('Invalid E.164 phone number.');
    const providerMessageId = `fake-wamid-${this.sent.length + 1}`;
    this.sent.push({ ...message, providerMessageId });
    return { providerMessageId };
  }
}
