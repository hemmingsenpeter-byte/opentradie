import { PermanentError } from '../errors.js';
import { mailRequest, parseJson, str } from './http.js';
import { parseRawEmail } from './mime.js';
import type {
  AccessTokenSource,
  EmailAddress,
  InboundEmail,
  MailChanges,
  MailFetch,
  MailProvider,
  OutboundEmail,
  SendResult,
} from './types.js';

const BASE = 'https://graph.microsoft.com/v1.0/me';
const PROVIDER = 'microsoft_graph';
const ID = /^[A-Za-z0-9_=+/-]{1,512}$/;

/** Delegated Microsoft Graph permissions: read for ingestion, send for approved replies. */
export const GRAPH_MAIL_SCOPES = ['offline_access', 'Mail.Read', 'Mail.Send'] as const;

const recipients = (list: EmailAddress[] | undefined) =>
  (list ?? []).map((item) => ({
    emailAddress: { address: item.address, ...(item.name ? { name: item.name } : {}) },
  }));

/**
 * Microsoft Graph mail adapter (/me/messages, MIME via /$value, inbox delta query, reply drafts
 * sent with /send). Implemented, not integration-tested: exercised only against an injected
 * fake HTTP layer.
 */
export class MicrosoftGraphMailAdapter implements MailProvider {
  readonly provider = 'microsoft_graph' as const;
  constructor(
    private readonly options: {
      accessToken: AccessTokenSource;
      fetch?: MailFetch;
      timeoutMs?: number;
    },
  ) {}

  private request(url: string, init: { method?: string; json?: unknown; accept?: string } = {}) {
    return mailRequest({ ...this.options, provider: PROVIDER }, url, init);
  }

  private path(id: string): string {
    if (!ID.test(id)) throw new PermanentError('Invalid Graph message id.', 'invalid_id', PROVIDER);
    return `${BASE}/messages/${encodeURIComponent(id)}`;
  }

  async fetchMessage(providerMessageId: string): Promise<InboundEmail> {
    const url = this.path(providerMessageId);
    const meta = parseJson(
      (await this.request(`${url}?$select=id,conversationId,internetMessageId`)).text,
      PROVIDER,
    );
    const mime = await this.request(`${url}/$value`, { accept: 'message/rfc822' });
    return parseRawEmail(mime.text, PROVIDER, {
      providerMessageId: str(meta.id) ?? providerMessageId,
      providerThreadId: str(meta.conversationId),
    });
  }

  async listChanges(cursor: string | null): Promise<MailChanges> {
    let url = cursor ?? `${BASE}/mailFolders/inbox/messages/delta?$select=id`;
    if (cursor !== null) {
      const parsed = new URL(cursor);
      // A stored cursor is followed only to Graph itself.
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'graph.microsoft.com')
        throw new PermanentError('Invalid Graph delta link.', 'invalid_cursor', PROVIDER);
    }
    const messageIds: string[] = [];
    for (let page = 0; page < 100; page++) {
      const body = parseJson((await this.request(url)).text, PROVIDER);
      for (const item of Array.isArray(body.value) ? body.value : []) {
        const entry = item as { id?: unknown; '@removed'?: unknown };
        const id = str(entry.id);
        if (id && !entry['@removed'] && ID.test(id)) messageIds.push(id);
      }
      const next = str(body['@odata.nextLink']);
      const delta = str(body['@odata.deltaLink']);
      if (delta) {
        // The first sync starts "from now": existing mail is not imported.
        return { messageIds: cursor === null ? [] : messageIds, nextCursor: delta };
      }
      if (!next || new URL(next).hostname !== 'graph.microsoft.com')
        throw new PermanentError(
          'Graph delta ended without a delta link.',
          'malformed_response',
          PROVIDER,
        );
      url = next;
    }
    throw new PermanentError('Graph delta paging did not finish.', 'too_many_pages', PROVIDER);
  }

  async send(message: OutboundEmail): Promise<SendResult> {
    if (message.to.length === 0)
      throw new PermanentError('A recipient is required.', 'no_recipient', PROVIDER);
    const body = { contentType: 'Text', content: message.text };
    let draft: Record<string, unknown>;
    if (message.replyToProviderMessageId) {
      // createReply keeps Graph's own conversation threading and In-Reply-To headers.
      draft = parseJson(
        (
          await this.request(`${this.path(message.replyToProviderMessageId)}/createReply`, {
            method: 'POST',
            json: {},
          })
        ).text,
        PROVIDER,
      );
      const id = str(draft.id);
      if (!id)
        throw new PermanentError('Graph returned no draft id.', 'malformed_response', PROVIDER);
      await this.request(this.path(id), {
        method: 'PATCH',
        json: {
          subject: message.subject,
          body,
          toRecipients: recipients(message.to),
          ccRecipients: recipients(message.cc),
        },
      });
    } else {
      draft = parseJson(
        (
          await this.request(`${BASE}/messages`, {
            method: 'POST',
            json: {
              subject: message.subject,
              body,
              toRecipients: recipients(message.to),
              ccRecipients: recipients(message.cc),
            },
          })
        ).text,
        PROVIDER,
      );
    }
    const id = str(draft.id);
    if (!id)
      throw new PermanentError('Graph returned no draft id.', 'malformed_response', PROVIDER);
    await this.request(`${this.path(id)}/send`, { method: 'POST' });
    return { providerMessageId: id, providerThreadId: str(draft.conversationId) };
  }
}
