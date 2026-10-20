import { randomUUID } from 'node:crypto';
import { signRelayBody } from '@opentradie/platform';
import type { TestContext } from './app.js';

export const INBOUND_SECRET = 'inbound-email-test-secret-0123456789abcdef';

/** A minimal RFC 5322 message for tests. Synthetic data only. */
export function rawEmail(options: {
  from: string;
  name?: string;
  subject: string;
  text?: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  headers?: string[];
  attachments?: Array<{ fileName: string; mediaType: string; content: Buffer }>;
}): string {
  const messageId = options.messageId ?? `<${randomUUID()}@customer.example.test>`;
  const head = [
    `From: ${options.name ? `"${options.name}" ` : ''}<${options.from}>`,
    'To: office@sparky.example.test',
    `Subject: ${options.subject}`,
    `Message-ID: ${messageId}`,
    'Date: Mon, 19 Oct 2026 09:00:00 +1300',
    ...(options.inReplyTo ? [`In-Reply-To: ${options.inReplyTo}`] : []),
    ...(options.references ? [`References: ${options.references.join(' ')}`] : []),
    ...(options.headers ?? []),
    'MIME-Version: 1.0',
  ];
  const body = options.html
    ? { type: 'text/html; charset=UTF-8', content: options.html }
    : { type: 'text/plain; charset=UTF-8', content: options.text ?? '' };
  if (!options.attachments?.length)
    return [...head, `Content-Type: ${body.type}`, '', body.content, ''].join('\r\n');
  const boundary = `b-${randomUUID()}`;
  const parts = [
    `--${boundary}`,
    `Content-Type: ${body.type}`,
    '',
    body.content,
    ...options.attachments.flatMap((attachment) => [
      `--${boundary}`,
      `Content-Type: ${attachment.mediaType}; name="${attachment.fileName}"`,
      `Content-Disposition: attachment; filename="${attachment.fileName}"`,
      'Content-Transfer-Encoding: base64',
      '',
      attachment.content.toString('base64'),
    ]),
    `--${boundary}--`,
    '',
  ];
  return [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join(
    '\r\n',
  );
}

/** POST a raw message to the signed inbound endpoint, as a relay or provider bridge would. */
export async function postInboundEmail(
  ctx: TestContext,
  rawMime: string,
  options: {
    eventId?: string;
    provider?: string;
    secret?: string;
    timestamp?: number;
    signature?: string;
  } = {},
): Promise<{ status: number; body: any }> {
  const body = JSON.stringify({
    version: 1,
    eventId: options.eventId ?? randomUUID(),
    rawMimeBase64: Buffer.from(rawMime).toString('base64'),
  });
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/inbound/email/${options.provider ?? 'generic_mime'}`,
    headers: {
      'content-type': 'application/json',
      'x-opentradie-signature':
        options.signature ??
        signRelayBody(body, options.secret ?? INBOUND_SECRET, options.timestamp),
    },
    payload: body,
  });
  return { status: response.statusCode, body: JSON.parse(response.body) };
}
