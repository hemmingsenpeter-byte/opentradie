/**
 * Mail adapter contract. OPENTRADIE owns the message record; a provider only delivers mail in
 * and carries approved replies out. Bodies and addresses are customer data: adapters never log
 * them and error messages never include them.
 */

export type MailProviderName = 'gmail' | 'microsoft_graph' | 'generic_mime' | 'fake';

export interface EmailAddress {
  address: string;
  name: string | null;
}

export interface InboundAttachment {
  fileName: string;
  /** Declared type from the message; the backend checks content against an allowlist. */
  mediaType: string;
  content: Uint8Array;
  inline: boolean;
}

/** The normalised RFC 5322 essentials of one inbound message. */
export interface InboundEmail {
  /** Message-ID with angle brackets. Synthesised from a content hash when the message has none. */
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  from: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  date: Date | null;
  /** Plain text. HTML-only messages are converted, with hidden elements removed. */
  text: string;
  /** True when the text came from the HTML part. */
  textFromHtml: boolean;
  attachments: InboundAttachment[];
  automation: { autoSubmitted: string | null; precedence: string | null; listId: string | null };
  /** Provider ids when the message came through a provider API. */
  providerMessageId: string | null;
  providerThreadId: string | null;
}

export interface OutboundEmail {
  to: EmailAddress[];
  cc?: EmailAddress[];
  from?: EmailAddress | null;
  subject: string;
  text: string;
  /** Message-ID of the message being answered, for RFC 5322 threading. */
  inReplyTo?: string | null;
  references?: string[];
  /** Provider thread to keep the reply in (Gmail threadId). */
  providerThreadId?: string | null;
  /** Provider id of the message being answered (Graph replies use it). */
  replyToProviderMessageId?: string | null;
  /** Our own Message-ID for the outgoing message, so a reply to it threads back. */
  messageId?: string;
}

export interface SendResult {
  providerMessageId: string;
  providerThreadId: string | null;
}

export interface MailChanges {
  /** Provider message ids added since the cursor. */
  messageIds: string[];
  /** Opaque cursor for the next call (Gmail historyId, Graph deltaLink). */
  nextCursor: string;
}

export interface MailProvider {
  readonly provider: MailProviderName;
  /** Fetch one message by provider id and normalise it. */
  fetchMessage(providerMessageId: string): Promise<InboundEmail>;
  /** Messages added since `cursor` (null: start from now and return the first cursor). */
  listChanges(cursor: string | null): Promise<MailChanges>;
  /** Only ever called by the send task after an owner approval is recorded. */
  send(message: OutboundEmail): Promise<SendResult>;
}

/** Resolves the mail connection for a tenant. Null means no usable connection is configured. */
export interface MailConnections {
  forTenant(tenantId: string): Promise<MailProvider | null>;
}

/** The default until encrypted provider tokens are wired to PostgreSQL: no connection. */
export const noMailConnections: MailConnections = { forTenant: async () => null };

/** Injectable HTTP for adapters (global fetch by default; fakes in tests). */
export type MailFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** Returns a current OAuth access token; refreshing is the token source's job. */
export type AccessTokenSource = () => Promise<string>;
