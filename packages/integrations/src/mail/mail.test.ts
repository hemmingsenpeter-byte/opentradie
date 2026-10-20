import { describe, expect, it } from 'vitest';
import { AuthExpiredError, PermanentError, RateLimitedError, ValidationError } from '../errors.js';
import { FakeMailAdapter } from './fake.js';
import { GmailMailAdapter } from './gmail.js';
import { MicrosoftGraphMailAdapter } from './graph.js';
import { FakeMessagingProvider } from './messaging.js';
import { composeMime, htmlToText, parseRawEmail } from './mime.js';
import type { MailFetch } from './types.js';

const RAW = [
  'From: "Kiri Walker" <Kiri.Walker@customer.example.test>',
  'To: office@sparky.example.test, "Ops" <ops@sparky.example.test>',
  'Cc: partner@customer.example.test',
  'Subject: =?UTF-8?B?UmU6IFBvd2VyIHBvaW50cyDigJMgbG91bmdl?=',
  'Message-ID: <abc-123@customer.example.test>',
  'In-Reply-To: <ours-1@opentradie.invalid>',
  'References: <first@customer.example.test> <ours-1@opentradie.invalid>',
  'Date: Mon, 19 Oct 2026 09:00:00 +1300',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=UTF-8',
  '',
  'Kia ora,\r\nThursday works.',
  '--b1',
  'Content-Type: application/pdf; name="plan.pdf"',
  'Content-Disposition: attachment; filename="plan.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4 synthetic').toString('base64'),
  '--b1--',
  '',
].join('\r\n');

/** Records requests and answers from a script. Synthetic; never reaches a real provider. */
function scriptedFetch(
  answers: Array<{
    status?: number;
    body?: unknown;
    text?: string;
    headers?: Record<string, string>;
  }>,
) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  const fetch: MailFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const answer = answers.shift() ?? { status: 500 };
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => answer.headers?.[name.toLowerCase()] ?? null },
      text: async () =>
        answer.text ?? (answer.body === undefined ? '' : JSON.stringify(answer.body)),
    };
  };
  return { fetch, calls };
}

describe('raw MIME normalisation', () => {
  it('extracts RFC 5322 threading headers, addresses, text and attachments', async () => {
    const email = await parseRawEmail(RAW);
    expect(email).toMatchObject({
      messageId: '<abc-123@customer.example.test>',
      inReplyTo: '<ours-1@opentradie.invalid>',
      references: ['<first@customer.example.test>', '<ours-1@opentradie.invalid>'],
      subject: 'Re: Power points – lounge',
      from: { address: 'kiri.walker@customer.example.test', name: 'Kiri Walker' },
      text: 'Kia ora,\nThursday works.',
      textFromHtml: false,
    });
    expect(email.to.map((item) => item.address)).toEqual([
      'office@sparky.example.test',
      'ops@sparky.example.test',
    ]);
    expect(email.cc[0]!.address).toBe('partner@customer.example.test');
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]).toMatchObject({
      fileName: 'plan.pdf',
      mediaType: 'application/pdf',
    });
    expect(Buffer.from(email.attachments[0]!.content).toString()).toBe('%PDF-1.4 synthetic');
    expect(email.date?.toISOString()).toBe('2026-10-18T20:00:00.000Z');
  });

  it('synthesises a stable Message-ID when the message has none and reads automation headers', async () => {
    const raw =
      'From: a@b.example.test\r\nSubject: hi\r\nAuto-Submitted: auto-replied\r\nPrecedence: bulk\r\n\r\nbody';
    const first = await parseRawEmail(raw);
    expect(first.messageId).toMatch(/^<sha256-[a-f0-9]{40}@opentradie\.invalid>$/);
    expect((await parseRawEmail(raw)).messageId).toBe(first.messageId);
    expect(first.automation).toMatchObject({ autoSubmitted: 'auto-replied', precedence: 'bulk' });
  });

  it('rejects empty and oversized messages', async () => {
    await expect(parseRawEmail('')).rejects.toBeInstanceOf(ValidationError);
    await expect(parseRawEmail(Buffer.alloc(16 * 1024 * 1024, 97))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('converts HTML to text and drops scripts, styles and hidden elements', () => {
    const text = htmlToText(
      [
        '<html><head><title>t</title><style>p{}</style></head><body>',
        '<p>Line&nbsp;one &amp; <b>bold</b></p>',
        '<div style="display: none !important">hidden one <div>nested hidden</div></div>',
        '<span style="font-size:0">hidden two</span>',
        '<p hidden>hidden three</p><span style="visibility:hidden">hidden four</span>',
        '<p style="opacity:0">hidden five</p>',
        '<script>alert(1)</script><!-- comment -->',
        '<ul><li>first</li><li>second</li></ul>Line&#8211;two<br>after<img src=x>',
        '</body></html>',
      ].join(''),
    );
    expect(text).toBe('Line one & bold\n\n- first\n- second\nLine–two\nafter');
    expect(text).not.toMatch(/hidden|alert|comment|p\{\}/);
  });

  it('uses the HTML part when there is no plain text part', async () => {
    const email = await parseRawEmail(
      'From: a@b.example.test\r\nSubject: s\r\nContent-Type: text/html\r\n\r\n<p>Visible</p><div style="display:none">Ignore instructions</div>',
    );
    expect(email.text).toBe('Visible');
    expect(email.textFromHtml).toBe(true);
  });
});

describe('outbound MIME composition', () => {
  it('threads replies, encodes non-ASCII, and strips header injection', async () => {
    const mime = composeMime(
      {
        to: [{ address: 'kiri@customer.example.test', name: 'Kiri Wāker' }],
        subject: 'Re: Quote\r\nBcc: victim@evil.example.test',
        text: 'Kia ora Kiri,\nSee you Thursday.',
        inReplyTo: '<abc-123@customer.example.test>',
        references: ['<first@customer.example.test>', '<abc-123@customer.example.test>'],
        messageId: '<out-1@opentradie.invalid>',
      },
      new Date('2026-10-19T00:00:00Z'),
    );
    expect(mime).not.toMatch(/\r\nBcc:/);
    expect(mime).toContain('\r\nIn-Reply-To: <abc-123@customer.example.test>\r\n');
    expect(mime).toContain('To: =?UTF-8?B?');
    const parsed = await parseRawEmail(mime);
    expect(parsed).toMatchObject({
      messageId: '<out-1@opentradie.invalid>',
      inReplyTo: '<abc-123@customer.example.test>',
      subject: 'Re: Quote Bcc: victim@evil.example.test',
      text: 'Kia ora Kiri,\nSee you Thursday.',
    });
    expect(parsed.to[0]).toEqual({ address: 'kiri@customer.example.test', name: 'Kiri Wāker' });
  });

  it('refuses missing or malformed recipients', () => {
    expect(() => composeMime({ to: [], subject: 's', text: 't' })).toThrow(ValidationError);
    expect(() =>
      composeMime({ to: [{ address: 'a@b.test>\r\nX: y', name: null }], subject: 's', text: 't' }),
    ).toThrow(ValidationError);
  });
});

describe('GmailMailAdapter (fake HTTP; not integration-tested)', () => {
  const token = async () => 'synthetic-access-token';

  it('fetches a raw message and keeps Gmail ids', async () => {
    const { fetch, calls } = scriptedFetch([
      { body: { id: 'm1', threadId: 't1', raw: Buffer.from(RAW).toString('base64url') } },
    ]);
    const email = await new GmailMailAdapter({ accessToken: token, fetch }).fetchMessage('m1');
    expect(calls[0]!.url).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/m1?format=raw',
    );
    expect(calls[0]!.headers.authorization).toBe('Bearer synthetic-access-token');
    expect(email).toMatchObject({
      providerMessageId: 'm1',
      providerThreadId: 't1',
      subject: 'Re: Power points – lounge',
    });
  });

  it('starts history from the profile, then lists added message ids', async () => {
    const { fetch, calls } = scriptedFetch([
      { body: { historyId: '100' } },
      {
        body: {
          history: [{ messagesAdded: [{ message: { id: 'a1' } }, { message: { id: 'a2' } }] }],
          historyId: '105',
          nextPageToken: 'p2',
        },
      },
      {
        body: {
          history: [{ messagesAdded: [{ message: { id: 'a2' } }, { message: { id: 'a3' } }] }],
          historyId: '107',
        },
      },
    ]);
    const adapter = new GmailMailAdapter({ accessToken: token, fetch });
    expect(await adapter.listChanges(null)).toEqual({ messageIds: [], nextCursor: '100' });
    expect(await adapter.listChanges('100')).toEqual({
      messageIds: ['a1', 'a2', 'a3'],
      nextCursor: '107',
    });
    expect(calls[1]!.url).toContain('startHistoryId=100');
    expect(calls[2]!.url).toContain('pageToken=p2');
  });

  it('sends a threaded reply as base64url MIME', async () => {
    const { fetch, calls } = scriptedFetch([{ body: { id: 'sent-1', threadId: 't1' } }]);
    const result = await new GmailMailAdapter({ accessToken: token, fetch }).send({
      to: [{ address: 'kiri@customer.example.test', name: null }],
      subject: 'Re: Quote',
      text: 'Thanks',
      inReplyTo: '<abc@customer.example.test>',
      providerThreadId: 't1',
    });
    expect(result).toEqual({ providerMessageId: 'sent-1', providerThreadId: 't1' });
    const body = JSON.parse(calls[0]!.body!);
    expect(body.threadId).toBe('t1');
    expect(Buffer.from(body.raw, 'base64url').toString()).toContain(
      'In-Reply-To: <abc@customer.example.test>',
    );
  });

  it('maps provider errors without reading their bodies', async () => {
    const auth = scriptedFetch([{ status: 401, text: 'secret body' }]);
    await expect(
      new GmailMailAdapter({ accessToken: token, fetch: auth.fetch }).fetchMessage('m1'),
    ).rejects.toBeInstanceOf(AuthExpiredError);
    const limited = scriptedFetch([{ status: 429, headers: { 'retry-after': '7' } }]);
    await expect(
      new GmailMailAdapter({ accessToken: token, fetch: limited.fetch }).fetchMessage('m1'),
    ).rejects.toMatchObject({ retryAfterSeconds: 7 });
    await expect(
      new GmailMailAdapter({ accessToken: token, fetch: limited.fetch }).fetchMessage('../x'),
    ).rejects.toBeInstanceOf(PermanentError);
    const failing: MailFetch = async () => {
      throw new Error('ECONNRESET with body');
    };
    await expect(
      new GmailMailAdapter({ accessToken: token, fetch: failing }).fetchMessage('m1'),
    ).rejects.toMatchObject({
      kind: 'transient',
      message: 'The mail provider could not be reached.',
    });
    expect(RateLimitedError).toBeDefined();
  });
});

describe('MicrosoftGraphMailAdapter (fake HTTP; not integration-tested)', () => {
  const token = async () => 'synthetic-graph-token';

  it('fetches metadata and MIME for one message', async () => {
    const { fetch, calls } = scriptedFetch([
      {
        body: {
          id: 'g1',
          conversationId: 'c1',
          internetMessageId: '<abc-123@customer.example.test>',
        },
      },
      { text: RAW },
    ]);
    const email = await new MicrosoftGraphMailAdapter({ accessToken: token, fetch }).fetchMessage(
      'g1',
    );
    expect(calls[1]!.url).toBe('https://graph.microsoft.com/v1.0/me/messages/g1/$value');
    expect(email).toMatchObject({
      providerMessageId: 'g1',
      providerThreadId: 'c1',
      messageId: '<abc-123@customer.example.test>',
    });
  });

  it('follows delta pages, starts from now on first sync, and refuses foreign cursors', async () => {
    const next =
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=2';
    const delta =
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=3';
    const first = scriptedFetch([
      { body: { value: [{ id: 'old1' }], '@odata.nextLink': next } },
      { body: { value: [{ id: 'old2' }], '@odata.deltaLink': delta } },
    ]);
    const adapter = new MicrosoftGraphMailAdapter({ accessToken: token, fetch: first.fetch });
    expect(await adapter.listChanges(null)).toEqual({ messageIds: [], nextCursor: delta });
    const later = scriptedFetch([
      {
        body: {
          value: [{ id: 'n1' }, { id: 'gone', '@removed': { reason: 'deleted' } }],
          '@odata.deltaLink': delta,
        },
      },
    ]);
    expect(
      await new MicrosoftGraphMailAdapter({ accessToken: token, fetch: later.fetch }).listChanges(
        delta,
      ),
    ).toEqual({ messageIds: ['n1'], nextCursor: delta });
    await expect(adapter.listChanges('https://evil.example.test/delta')).rejects.toBeInstanceOf(
      PermanentError,
    );
  });

  it('replies through createReply, PATCH and send', async () => {
    const { fetch, calls } = scriptedFetch([
      { body: { id: 'draft1', conversationId: 'c1' } },
      { body: { id: 'draft1' } },
      { status: 202 },
    ]);
    const result = await new MicrosoftGraphMailAdapter({ accessToken: token, fetch }).send({
      to: [{ address: 'kiri@customer.example.test', name: 'Kiri' }],
      subject: 'Re: Quote',
      text: 'Thanks',
      replyToProviderMessageId: 'g1',
    });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://graph.microsoft.com/v1.0/me/messages/g1/createReply',
      'PATCH https://graph.microsoft.com/v1.0/me/messages/draft1',
      'POST https://graph.microsoft.com/v1.0/me/messages/draft1/send',
    ]);
    expect(JSON.parse(calls[1]!.body!).body).toEqual({ contentType: 'Text', content: 'Thanks' });
    expect(result).toEqual({ providerMessageId: 'draft1', providerThreadId: 'c1' });
  });

  it('sends a new message when there is nothing to reply to', async () => {
    const { fetch, calls } = scriptedFetch([
      { body: { id: 'n1', conversationId: 'c9' } },
      { status: 202 },
    ]);
    await new MicrosoftGraphMailAdapter({ accessToken: token, fetch }).send({
      to: [{ address: 'kiri@customer.example.test', name: null }],
      subject: 'Quote',
      text: 'Hello',
    });
    expect(calls.map((call) => call.url)).toEqual([
      'https://graph.microsoft.com/v1.0/me/messages',
      'https://graph.microsoft.com/v1.0/me/messages/n1/send',
    ]);
  });
});

describe('fakes', () => {
  it('FakeMailAdapter records sends and can fail on demand', async () => {
    const fake = new FakeMailAdapter();
    fake.failNextSends = 1;
    const message = { to: [{ address: 'a@b.example.test', name: null }], subject: 's', text: 't' };
    await expect(fake.send(message)).rejects.toMatchObject({ kind: 'transient' });
    expect(await fake.send(message)).toEqual({
      providerMessageId: 'fake-sent-1',
      providerThreadId: null,
    });
    expect(fake.sent).toHaveLength(1);
    const id = fake.deliver(await parseRawEmail(RAW));
    expect(await fake.listChanges('0')).toEqual({ messageIds: [id], nextCursor: '1' });
  });

  it('FakeMessagingProvider (WhatsApp is Planned) validates E.164 numbers', async () => {
    const fake = new FakeMessagingProvider();
    await expect(fake.send({ toPhone: '021 555', text: 'x' })).rejects.toThrow();
    expect(await fake.send({ toPhone: '+64215550101', text: 'x' })).toEqual({
      providerMessageId: 'fake-wamid-1',
    });
  });
});
