import { PermanentError } from '../errors.js';
import { mailRequest, parseJson, str } from './http.js';
import { composeMime, parseRawEmail } from './mime.js';
import type {
  AccessTokenSource,
  InboundEmail,
  MailChanges,
  MailFetch,
  MailProvider,
  OutboundEmail,
  SendResult,
} from './types.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PROVIDER = 'gmail';
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** OAuth scopes: read for ingestion, send for approved replies. Nothing broader. */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
] as const;

/**
 * Gmail API adapter over plain HTTPS (users.messages.get with format=raw, users.history.list,
 * users.messages.send, users.watch). Implemented, not integration-tested: exercised only
 * against an injected fake HTTP layer. Tokens come from the caller's token source.
 */
export class GmailMailAdapter implements MailProvider {
  readonly provider = 'gmail' as const;
  constructor(
    private readonly options: {
      accessToken: AccessTokenSource;
      fetch?: MailFetch;
      timeoutMs?: number;
    },
  ) {}

  private request(url: string, init: { method?: string; json?: unknown } = {}) {
    return mailRequest({ ...this.options, provider: PROVIDER }, url, init);
  }

  async fetchMessage(providerMessageId: string): Promise<InboundEmail> {
    if (!ID.test(providerMessageId))
      throw new PermanentError('Invalid Gmail message id.', 'invalid_id', PROVIDER);
    const { text } = await this.request(`${BASE}/messages/${providerMessageId}?format=raw`);
    const body = parseJson(text, PROVIDER);
    const raw = str(body.raw);
    if (!raw)
      throw new PermanentError('Gmail returned no raw message.', 'malformed_response', PROVIDER);
    return parseRawEmail(Buffer.from(raw, 'base64url'), PROVIDER, {
      providerMessageId: str(body.id) ?? providerMessageId,
      providerThreadId: str(body.threadId),
    });
  }

  async listChanges(cursor: string | null): Promise<MailChanges> {
    if (cursor === null) {
      const profile = parseJson((await this.request(`${BASE}/profile`)).text, PROVIDER);
      const historyId = str(profile.historyId) ?? String(profile.historyId ?? '');
      if (!/^\d{1,20}$/.test(historyId))
        throw new PermanentError('Gmail returned no history id.', 'malformed_response', PROVIDER);
      return { messageIds: [], nextCursor: historyId };
    }
    if (!/^\d{1,20}$/.test(cursor))
      throw new PermanentError('Invalid Gmail history id.', 'invalid_cursor', PROVIDER);
    const messageIds = new Set<string>();
    let pageToken: string | null = null;
    let latest = cursor;
    for (let page = 0; page < 50; page++) {
      const url = new URL(`${BASE}/history`);
      url.searchParams.set('startHistoryId', cursor);
      url.searchParams.set('historyTypes', 'messageAdded');
      url.searchParams.set('labelId', 'INBOX');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const body = parseJson((await this.request(url.toString())).text, PROVIDER);
      for (const entry of Array.isArray(body.history) ? body.history : []) {
        const added =
          (entry as { messagesAdded?: Array<{ message?: { id?: unknown } }> }).messagesAdded ?? [];
        for (const item of added) {
          const id = str(item.message?.id);
          if (id && ID.test(id)) messageIds.add(id);
        }
      }
      latest =
        str(body.historyId) ??
        (typeof body.historyId === 'number' ? String(body.historyId) : latest);
      pageToken = str(body.nextPageToken);
      if (!pageToken) break;
    }
    return { messageIds: [...messageIds], nextCursor: latest };
  }

  /** Registers Gmail push notifications to a Cloud Pub/Sub topic (renew at least every 7 days). */
  async startWatch(topicName: string): Promise<{ historyId: string; expiration: Date }> {
    if (
      !/^projects\/[a-z][a-z0-9-]{4,29}\/topics\/[A-Za-z][A-Za-z0-9._~%+-]{2,254}$/.test(topicName)
    )
      throw new PermanentError('Invalid Pub/Sub topic name.', 'invalid_topic', PROVIDER);
    const body = parseJson(
      (
        await this.request(`${BASE}/watch`, {
          method: 'POST',
          json: { topicName, labelIds: ['INBOX'] },
        })
      ).text,
      PROVIDER,
    );
    return {
      historyId: String(body.historyId ?? ''),
      expiration: new Date(Number(body.expiration ?? 0)),
    };
  }

  async send(message: OutboundEmail): Promise<SendResult> {
    const raw = Buffer.from(composeMime(message), 'utf8').toString('base64url');
    const body = parseJson(
      (
        await this.request(`${BASE}/messages/send`, {
          method: 'POST',
          json: {
            raw,
            ...(message.providerThreadId ? { threadId: message.providerThreadId } : {}),
          },
        })
      ).text,
      PROVIDER,
    );
    const id = str(body.id);
    if (!id)
      throw new PermanentError('Gmail returned no message id.', 'malformed_response', PROVIDER);
    return { providerMessageId: id, providerThreadId: str(body.threadId) };
  }
}
