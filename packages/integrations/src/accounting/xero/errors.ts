import {
  AuthExpiredError,
  ConflictError,
  IntegrationError,
  PermanentError,
  RateLimitedError,
  ReauthorisationRequiredError,
  TransientError,
  ValidationError,
} from '../../errors.js';

const PROVIDER = 'xero';
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const DUPLICATE = /already (been )?(assigned|exists|used)|must be unique|duplicate/i;

interface RawFailure {
  status: number | null;
  headers: Record<string, unknown>;
  body: unknown;
  networkCode: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/**
 * The SDK rejects with a JSON string ({response:{statusCode,headers,body},body}) for API calls,
 * with {response, body} for non-2xx resolutions, and with a redacted axios error for /connections.
 */
function unpack(error: unknown): RawFailure {
  let value: unknown = error;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { status: null, headers: {}, body: null, networkCode: null };
    }
  }
  const record = asRecord(value) ?? {};
  const response = asRecord(record.response) ?? {};
  const status = [response.statusCode, response.status, record.statusCode, record.status].find(
    (candidate): candidate is number => typeof candidate === 'number',
  );
  const networkCode = typeof record.code === 'string' ? record.code : null;
  return {
    status: status ?? null,
    headers: asRecord(response.headers) ?? {},
    body: record.body ?? response.body ?? response.data ?? null,
    networkCode,
  };
}

function header(headers: Record<string, unknown>, name: string): string | null {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found && found[1] !== undefined && found[1] !== null ? String(found[1]) : null;
}

/** Validation messages from a Xero ValidationException body, truncated. Never logged by us. */
export function xeroValidationMessages(body: unknown): string[] {
  const record = asRecord(typeof body === 'string' ? safeParse(body) : body);
  if (!record) return [];
  const messages: string[] = [];
  const elements = Array.isArray(record.Elements) ? record.Elements : [];
  for (const element of elements) {
    const errors = asRecord(element)?.ValidationErrors;
    if (!Array.isArray(errors)) continue;
    for (const item of errors) {
      const message = asRecord(item)?.Message;
      if (typeof message === 'string') messages.push(message.slice(0, 300));
    }
  }
  if (!messages.length && typeof record.Message === 'string')
    messages.push(record.Message.slice(0, 300));
  return [...new Set(messages)].slice(0, 20);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseRetryAfter(value: string | null): number {
  if (!value) return DEFAULT_RETRY_AFTER_SECONDS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return DEFAULT_RETRY_AFTER_SECONDS;
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ERR_NETWORK',
]);

/** Maps any SDK failure to the normalised taxonomy. Response bodies never enter error messages. */
export function mapXeroError(error: unknown): IntegrationError {
  if (error instanceof IntegrationError) return error;
  const failure = unpack(error);
  const { status } = failure;
  if (status === null || status === 0) {
    if (status === 0 || (failure.networkCode && NETWORK_CODES.has(failure.networkCode)))
      return new TransientError('Xero could not be reached.', 'network', PROVIDER);
    return new PermanentError('Unexpected failure calling Xero.', 'unexpected', PROVIDER);
  }
  if (status === 401)
    return new AuthExpiredError('Xero rejected the access token.', 'unauthorised', PROVIDER);
  if (status === 403)
    return new ReauthorisationRequiredError(
      'Xero refused access to this organisation; reconnect Xero.',
      'forbidden',
      PROVIDER,
    );
  if (status === 429) {
    const problem = header(failure.headers, 'x-rate-limit-problem');
    return new RateLimitedError(
      'Xero rate limit reached.',
      problem ? `rate_limit_${problem.replace(/[^a-z]/gi, '').toLowerCase()}` : 'rate_limit',
      PROVIDER,
      parseRetryAfter(header(failure.headers, 'retry-after')),
    );
  }
  if (status === 404)
    return new PermanentError('The Xero record was not found.', 'not_found', PROVIDER);
  if (status === 409 || status === 412)
    return new ConflictError('Xero reported a conflicting change.', 'conflict', PROVIDER);
  if (status === 400) {
    const messages = xeroValidationMessages(failure.body);
    if (messages.some((message) => DUPLICATE.test(message)))
      return new ConflictError(
        'Xero reported a duplicate record.',
        'duplicate',
        PROVIDER,
        messages,
      );
    return new ValidationError(
      'Xero rejected the request as invalid.',
      'provider_validation',
      PROVIDER,
      messages,
    );
  }
  if (status >= 500 || status === 408)
    return new TransientError(`Xero returned HTTP ${status}.`, `http_${status}`, PROVIDER);
  return new PermanentError(`Xero returned HTTP ${status}.`, `http_${status}`, PROVIDER);
}
