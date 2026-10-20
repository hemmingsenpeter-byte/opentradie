import {
  AuthExpiredError,
  PermanentError,
  RateLimitedError,
  ReauthorisationRequiredError,
  TransientError,
  ValidationError,
} from '../errors.js';
import type { AccessTokenSource, MailFetch } from './types.js';

/**
 * One authenticated request to a mail provider API. Error bodies can contain message content
 * and are never read; errors carry only the HTTP status as a code.
 */
export async function mailRequest(
  options: {
    fetch?: MailFetch;
    accessToken: AccessTokenSource;
    provider: string;
    timeoutMs?: number;
  },
  url: string,
  init: { method?: string; json?: unknown; accept?: string } = {},
): Promise<{ status: number; text: string }> {
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as MailFetch);
  const token = await options.accessToken();
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: init.accept ?? 'application/json',
  };
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  let response: Awaited<ReturnType<MailFetch>>;
  try {
    response = await doFetch(url, {
      method: init.method ?? 'GET',
      headers,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      signal: controller.signal,
    });
  } catch {
    throw new TransientError(
      'The mail provider could not be reached.',
      'network',
      options.provider,
    );
  } finally {
    clearTimeout(timer);
  }
  const code = `http_${response.status}`;
  if (response.status === 401)
    throw new AuthExpiredError(
      'The mail provider rejected the access token.',
      code,
      options.provider,
    );
  if (response.status === 403)
    throw new ReauthorisationRequiredError(
      'The mail connection lacks permission; reconnect the mailbox.',
      code,
      options.provider,
    );
  if (response.status === 429) {
    const retry = Number(response.headers.get('retry-after'));
    throw new RateLimitedError(
      'The mail provider rate limit was reached.',
      'rate_limit',
      options.provider,
      Number.isFinite(retry) && retry >= 0 ? retry : 60,
    );
  }
  if (response.status >= 500 || response.status === 408)
    throw new TransientError(
      `The mail provider returned HTTP ${response.status}.`,
      code,
      options.provider,
    );
  if (response.status === 400 || response.status === 422)
    throw new ValidationError('The mail provider rejected the request.', code, options.provider);
  if (!response.ok)
    throw new PermanentError(
      `The mail provider returned HTTP ${response.status}.`,
      code,
      options.provider,
    );
  return { status: response.status, text: await response.text() };
}

export function parseJson(text: string, provider: string): Record<string, unknown> {
  try {
    const value: unknown = text ? JSON.parse(text) : {};
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new PermanentError(
    'The mail provider returned a malformed response.',
    'malformed_response',
    provider,
  );
}

export const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;
