/**
 * Normalised error taxonomy shared by every provider adapter. Callers (API routes, the worker)
 * decide what to do from `kind` and `retryable` only; provider-specific detail never leaks into
 * control flow. Error messages are written by us and never contain tokens, request bodies or
 * provider response bodies, so they are safe to log.
 */
export type IntegrationErrorKind =
  | 'auth_expired'
  | 'reauthorisation_required'
  | 'rate_limited'
  | 'validation'
  | 'conflict'
  | 'transient'
  | 'permanent';

export abstract class IntegrationError extends Error {
  abstract readonly kind: IntegrationErrorKind;
  /** True when the same request may succeed if retried later without any change. */
  abstract readonly retryable: boolean;
  constructor(
    message: string,
    /** Short machine-readable sub-reason, e.g. "not_found", "duplicate", "network". */
    readonly code: string,
    readonly provider: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The access token was rejected or has expired. Refreshing the token and retrying once is safe. */
export class AuthExpiredError extends IntegrationError {
  readonly kind = 'auth_expired' as const;
  readonly retryable = true;
}

/**
 * The connection can no longer be used without the owner signing in to the provider again:
 * refresh token expired/revoked, connection removed, or required scopes missing.
 */
export class ReauthorisationRequiredError extends IntegrationError {
  readonly kind = 'reauthorisation_required' as const;
  readonly retryable = false;
}

export class RateLimitedError extends IntegrationError {
  readonly kind = 'rate_limited' as const;
  readonly retryable = true;
  constructor(
    message: string,
    code: string,
    provider: string,
    /** Seconds to wait before retrying, from the provider's Retry-After header when present. */
    readonly retryAfterSeconds: number,
  ) {
    super(message, code, provider);
  }
}

/**
 * The request was rejected as invalid, either by our own pre-flight validation or by the
 * provider. `issues` are short field-level messages. Provider-supplied messages may contain
 * business data (e.g. a contact name): show them to the owner, never log them.
 */
export class ValidationError extends IntegrationError {
  readonly kind = 'validation' as const;
  readonly retryable = false;
  constructor(
    message: string,
    code: string,
    provider: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message, code, provider);
  }
}

/** Duplicate or state conflict, e.g. a contact name already used or an invoice that is no longer a draft. */
export class ConflictError extends IntegrationError {
  readonly kind = 'conflict' as const;
  readonly retryable = false;
  constructor(
    message: string,
    code: string,
    provider: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message, code, provider);
  }
}

/** Network failure, timeout or provider 5xx. Retry with backoff using the same idempotency key. */
export class TransientError extends IntegrationError {
  readonly kind = 'transient' as const;
  readonly retryable = true;
}

/** Anything else that will not succeed on retry (not found, forbidden operation, unexpected response). */
export class PermanentError extends IntegrationError {
  readonly kind = 'permanent' as const;
  readonly retryable = false;
}

export function isIntegrationError(error: unknown): error is IntegrationError {
  return error instanceof IntegrationError;
}
