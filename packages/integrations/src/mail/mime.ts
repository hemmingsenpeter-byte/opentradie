import { createHash, randomBytes } from 'node:crypto';
import PostalMime from 'postal-mime';
import { PermanentError, ValidationError } from '../errors.js';
import type { EmailAddress, InboundAttachment, InboundEmail, OutboundEmail } from './types.js';

/** Upper bound for one raw message (headers, body and attachments). */
export const MAX_RAW_EMAIL_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS = 100_000;

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
const DROP = new Set([
  'head',
  'script',
  'style',
  'template',
  'noscript',
  'svg',
  'math',
  'object',
  'iframe',
  'title',
]);
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'table',
  'tr',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'pre',
  'address',
]);
const HIDDEN_STYLE =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?\s*(?:!important)?\s*(?:;|$)|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)|max-height\s*:\s*0|height\s*:\s*0(?:px)?\s*(?:;|$)[\s\S]*overflow\s*:\s*hidden)/i;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(
    String.raw`(?:^|\s)${name}\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?`,
    'i',
  ).exec(attributes);
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? '';
}

function isHidden(attributes: string): boolean {
  if (attribute(attributes, 'hidden') !== null) return true;
  const style = attribute(attributes, 'style');
  return style !== null && HIDDEN_STYLE.test(decodeEntities(style));
}

/**
 * HTML to plain text for untrusted mail. Scripts, styles and elements hidden from the reader
 * (hidden attribute, display:none, visibility:hidden, zero font size or opacity) are dropped,
 * so text a customer cannot see never reaches the agent or the owner as message content.
 */
export function htmlToText(html: string): string {
  const out: string[] = [];
  // Comments, CDATA and doctype are skipped with indexOf, not a lazy regex: an unterminated
  // "<!--" repeated n times would make `<!--[\s\S]*?-->` rescan to the end from every start
  // (quadratic). Once a terminator is absent it is absent for every later start, so each is
  // searched at most once more after a miss and the whole scan stays linear.
  const token = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</gy;
  const constructs = [
    { start: '<!--', end: '-->', present: true },
    { start: '<![cdata[', end: ']]>', present: true },
    { start: '<!doctype', end: '>', present: true },
  ];
  /** Position after the comment/CDATA/doctype starting at `pos`, or -1 when there is none. */
  const skipConstruct = (pos: number): number => {
    for (const construct of constructs) {
      if (!construct.present) continue;
      if (html.slice(pos, pos + construct.start.length).toLowerCase() !== construct.start) continue;
      const close = html.indexOf(construct.end, pos + construct.start.length);
      if (close !== -1) return close + construct.end.length;
      construct.present = false;
    }
    return -1;
  };
  let skipTag: string | null = null;
  let skipDepth = 0;
  for (let pos = 0; pos < html.length;) {
    if (html.charCodeAt(pos) === 60 && html.charCodeAt(pos + 1) === 33) {
      const next = skipConstruct(pos);
      if (next >= 0) {
        pos = next;
        continue;
      }
    }
    token.lastIndex = pos;
    const match = token.exec(html);
    if (!match) break;
    pos = token.lastIndex;
    const [, closing, rawName, attributes = '', text] = match;
    const name = rawName?.toLowerCase();
    if (skipTag) {
      if (name === skipTag && !VOID.has(name)) {
        if (closing) skipDepth--;
        else if (!attributes.trim().endsWith('/')) skipDepth++;
        if (skipDepth === 0) skipTag = null;
      }
      continue;
    }
    if (text !== undefined) {
      out.push(decodeEntities(text.replace(/\s+/g, ' ')));
      continue;
    }
    if (!name) continue;
    if (!closing && !VOID.has(name) && (DROP.has(name) || isHidden(attributes))) {
      if (!attributes.trim().endsWith('/')) {
        skipTag = name;
        skipDepth = 1;
      }
      continue;
    }
    if (name === 'br') out.push('\n');
    else if (name === 'li' && !closing) out.push('\n- ');
    else if (name === 'td' || name === 'th') out.push(closing ? ' ' : '');
    else if (BLOCK.has(name)) out.push('\n');
  }
  return tidy(out.join(''));
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

function mailboxes(value: unknown): EmailAddress[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const result: EmailAddress[] = [];
  for (const entry of list as Array<{
    address?: string;
    name?: string;
    group?: Array<{ address?: string; name?: string }>;
  }>) {
    for (const box of entry.group ?? [entry]) {
      if (!box.address) continue;
      result.push({ address: box.address.trim().toLowerCase(), name: box.name?.trim() || null });
    }
  }
  return result.slice(0, 100);
}

function header(headers: Array<{ key: string; value: string }>, key: string): string | null {
  return headers.find((entry) => entry.key === key)?.value ?? null;
}

const ids = (value: string | null | undefined) => [
  ...new Set((value ?? '').match(/<[^<>\s]{1,996}>/g) ?? []),
];

/** Parse a raw RFC 5322 message (MIME) into the normalised inbound shape. */
export async function parseRawEmail(
  raw: Uint8Array | string,
  provider = 'generic_mime',
  providerIds: { providerMessageId?: string | null; providerThreadId?: string | null } = {},
): Promise<InboundEmail> {
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
  if (bytes.length === 0)
    throw new ValidationError('The email is empty.', 'empty_message', provider);
  if (bytes.length > MAX_RAW_EMAIL_BYTES)
    throw new ValidationError('The email is too large.', 'message_too_large', provider);
  let parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    parsed = await PostalMime.parse(bytes, {
      attachmentEncoding: 'arraybuffer',
      maxNestingDepth: 50,
    });
  } catch {
    throw new ValidationError('The email could not be parsed.', 'malformed_message', provider);
  }
  const plain = parsed.text?.trim() ? tidy(parsed.text) : '';
  const fromHtml = !plain && parsed.html ? htmlToText(parsed.html) : '';
  const text = plain || fromHtml;
  const attachments: InboundAttachment[] = parsed.attachments.slice(0, 20).map((item, index) => {
    const content =
      typeof item.content === 'string'
        ? Buffer.from(item.content, item.encoding === 'base64' ? 'base64' : 'utf8')
        : new Uint8Array(item.content instanceof ArrayBuffer ? item.content : item.content.buffer);
    return {
      fileName: item.filename?.trim() || `attachment-${index + 1}`,
      mediaType: (item.mimeType || 'application/octet-stream').toLowerCase(),
      content,
      inline: item.disposition === 'inline',
    };
  });
  const messageId =
    ids(parsed.messageId)[0] ??
    `<sha256-${createHash('sha256').update(bytes).digest('hex').slice(0, 40)}@opentradie.invalid>`;
  const date = parsed.date ? new Date(parsed.date) : null;
  return {
    messageId,
    inReplyTo: ids(parsed.inReplyTo)[0] ?? null,
    references: ids(parsed.references).slice(-50),
    subject: (parsed.subject ?? '')
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 300),
    from: mailboxes(parsed.from)[0] ?? null,
    to: mailboxes(parsed.to),
    cc: mailboxes(parsed.cc),
    replyTo: mailboxes(parsed.replyTo),
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    text,
    textFromHtml: Boolean(fromHtml),
    attachments,
    automation: {
      autoSubmitted: header(parsed.headers, 'auto-submitted'),
      precedence: header(parsed.headers, 'precedence'),
      listId: header(parsed.headers, 'list-id'),
    },
    providerMessageId: providerIds.providerMessageId ?? null,
    providerThreadId: providerIds.providerThreadId ?? null,
  };
}

// ---------- outbound ----------

/** Header values never carry CR or LF, so recipients or subjects cannot inject headers. */
function headerSafe(value: string): string {
  return value.replace(/[\r\n\0]+/g, ' ').trim();
}

function encodeWord(value: string): string {
  const safe = headerSafe(value);
  return /^[\x20-\x7e]*$/.test(safe)
    ? safe
    : `=?UTF-8?B?${Buffer.from(safe, 'utf8').toString('base64')}?=`;
}

function formatAddress(address: EmailAddress): string {
  const email = headerSafe(address.address);
  if (!/^[^\s<>@,;"]+@[^\s<>@,;"]+$/.test(email))
    throw new ValidationError('A recipient address is invalid.', 'invalid_address', 'mime');
  if (!address.name) return email;
  const name = encodeWord(address.name);
  return `${name.startsWith('=?') ? name : `"${name.replace(/["\\]/g, '')}"`} <${email}>`;
}

export function newMessageId(domain = 'opentradie.invalid'): string {
  return `<${randomBytes(16).toString('hex')}@${domain}>`;
}

/** A minimal RFC 5322 text/plain UTF-8 message, base64 encoded body, CRLF line endings. */
export function composeMime(message: OutboundEmail, date = new Date()): string {
  if (message.to.length === 0)
    throw new ValidationError('A recipient is required.', 'no_recipient', 'mime');
  const lines = [
    ...(message.from ? [`From: ${formatAddress(message.from)}`] : []),
    `To: ${message.to.map(formatAddress).join(', ')}`,
    ...(message.cc?.length ? [`Cc: ${message.cc.map(formatAddress).join(', ')}`] : []),
    `Subject: ${encodeWord(message.subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${headerSafe(message.messageId ?? newMessageId())}`,
    ...(message.inReplyTo ? [`In-Reply-To: ${headerSafe(message.inReplyTo)}`] : []),
    ...(message.references?.length
      ? [`References: ${message.references.map(headerSafe).join(' ')}`]
      : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    (
      Buffer.from(message.text.replace(/\r?\n/g, '\r\n'), 'utf8')
        .toString('base64')
        .match(/.{1,76}/g) ?? []
    ).join('\r\n'),
    '',
  ];
  return lines.join('\r\n');
}

export function assertProviderJson(value: unknown, provider: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PermanentError(
      'The mail provider returned a malformed response.',
      'malformed_response',
      provider,
    );
  return value as Record<string, unknown>;
}
