/**
 * Deterministic, server-side rules for inbound email. Nothing here calls a model: these rules
 * decide what the backend may create on its own (a customer, a job) and the agent's output is
 * only advisory. All input is untrusted.
 */

const REPLY_PREFIX = /^\s*((re|fw|fwd|aw|sv|antw|wg)(\[\d+\])?\s*:\s*)+/i;

/** Lower-case subject with reply/forward prefixes and extra whitespace removed. */
export function normaliseSubject(subject: string | null | undefined): string {
  let value = (subject ?? '').normalize('NFKC');
  let previous = '';
  while (previous !== value) {
    previous = value;
    value = value.replace(REPLY_PREFIX, '');
  }
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-NZ').slice(0, 300);
}

/** Subjects too generic to thread on without headers. */
const GENERIC_SUBJECTS = new Set([
  '',
  'hi',
  'hello',
  'enquiry',
  'inquiry',
  'question',
  'quote',
  'help',
  'no subject',
]);

export function subjectIsThreadable(normalised: string): boolean {
  return normalised.length >= 4 && !GENERIC_SUBJECTS.has(normalised);
}

const EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Lower-cased address when syntactically plausible, otherwise null. */
export function normaliseEmailAddress(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed.length > 254 || !EMAIL.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/** `<a@b>` tokens from a Message-ID, In-Reply-To or References header value. */
export function parseMessageIds(value: string | null | undefined): string[] {
  const ids = (value ?? '').match(/<[^<>\s]{1,996}>/g) ?? [];
  return [...new Set(ids)].slice(0, 50);
}

export interface AutomationSignals {
  fromAddress: string | null;
  autoSubmitted?: string | null;
  precedence?: string | null;
  listId?: string | null;
}

const NO_REPLY =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounces?|notifications?)([+@-]|$)/i;

/** Auto-replies, bounces and bulk mail never create customers or jobs and never get a draft reply. */
export function isAutomatedEmail(signals: AutomationSignals): boolean {
  const auto = (signals.autoSubmitted ?? '').trim().toLowerCase();
  if (auto && auto !== 'no') return true;
  if (/^(bulk|list|junk|auto_reply)$/i.test((signals.precedence ?? '').trim())) return true;
  if (signals.listId) return true;
  const local = signals.fromAddress?.split('@')[0] ?? '';
  return NO_REPLY.test(local);
}

const ENQUIRY_WORDS =
  /\b(quote|quotation|price|pricing|estimate|cost|how much|install|installation|replace|repair|fix|fault|broken|not working|tripping|power ?points?|sockets?|outlets?|lights?|wiring|rewire|switchboard|heat ?pump|electrician|plumber|leak|book|booking|available|availability|come (?:and|to) (?:look|check)|job)\b/i;

/**
 * Whether a message from an unknown sender reads like a request for work. Deliberately broad:
 * the job it creates is status "new" and the owner reviews it. Automated mail is excluded.
 */
export function looksLikeEnquiry(input: {
  subject: string | null | undefined;
  text: string;
  automated: boolean;
}): boolean {
  if (input.automated) return false;
  return ENQUIRY_WORDS.test(`${input.subject ?? ''}\n${input.text.slice(0, 5000)}`);
}

export type DraftWarning =
  'contains_price' | 'contains_bank_account' | 'contains_link' | 'contains_email_address';

/**
 * Flags in an AI-drafted reply that the owner must look at before approving. Prices in a reply
 * never come from approved rates, and bank details or links in a draft can come from injected
 * instructions in the inbound message.
 */
export function draftWarnings(text: string): DraftWarning[] {
  const warnings: DraftWarning[] = [];
  // Each repeated run is anchored with a lookbehind so a match can only start at the beginning of
  // a run; unanchored runs make the engine retry from every position (quadratic on long input).
  if (/(?:\$|nzd|aud|usd)\s?\d|(?<!\d)\d+(?:\.\d{2})?\s?(?:dollars|nzd)\b/i.test(text))
    warnings.push('contains_price');
  if (
    /\b\d{2}[- ]?\d{4}[- ]?\d{7}[- ]?\d{2,3}\b|\biban\b|\baccount (?:number|no)\b|\bbsb\b/i.test(
      text,
    )
  )
    warnings.push('contains_bank_account');
  if (/\bhttps?:\/\/|\bwww\./i.test(text)) warnings.push('contains_link');
  if (/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text))
    warnings.push('contains_email_address');
  return warnings;
}

/** A display name for a new customer: the sender's name, else the mailbox part of the address. */
export function customerNameFromSender(name: string | null | undefined, address: string): string {
  const cleaned = (name ?? '').replace(/["<>]/g, '').replace(/\s+/g, ' ').trim();
  if (cleaned && !cleaned.includes('@')) return cleaned.slice(0, 200);
  const local = address.split('@')[0] ?? address;
  const words = local
    .replace(/[._+-]+/g, ' ')
    .replace(/\d+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  return (words.join(' ') || address).slice(0, 200);
}
