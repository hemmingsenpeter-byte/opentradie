/**
 * The single typed module for every HTTP call the web app makes.
 * Route paths live here only, so backend route changes are a one-file adjustment.
 *
 * Server rules this client relies on (apps/api/src/app.ts):
 * - Session is an httpOnly signed cookie set by POST /api/auth/login.
 * - Mutations must carry an Origin matching APP_ORIGIN (browsers send it) and JSON bodies.
 * - Every mutation (except sign-in/out) requires an Idempotency-Key header. Callers that may
 *   retry pass their own; otherwise a fresh key is generated per call.
 * - Errors are { error, message, requestId }.
 */
import type {
  AppState,
  Customer,
  CustomerInput,
  EnquiryResult,
  EvidenceInput,
  Health,
  Job,
  JobDetail,
  JobDocument,
  JobInput,
  JobStatus,
  Property,
  PropertyInput,
  QuoteDecision,
  SessionUser,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type UnauthorizedListener = () => void;
let onUnauthorized: UnauthorizedListener | null = null;
/** Called when an authenticated call returns 401 (expired or revoked session). */
export function setUnauthorizedListener(listener: UnauthorizedListener | null) {
  onUnauthorized = listener;
}

/**
 * Idempotency keys must work outside secure contexts too (e.g. a Mac mini reached over
 * plain http on the LAN), where crypto.randomUUID is unavailable.
 */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  /** Login itself returns 401 for bad credentials; that must not trigger a sign-out. */
  skipUnauthorizedHook?: boolean;
}

const FRIENDLY: Record<string, string> = {
  NOT_FOUND: 'This action is not available on this server version yet.',
  REQUEST_REJECTED: 'The server rejected the request.',
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers({ Accept: 'application/json' });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const method = options.method ?? 'GET';
  const key =
    options.idempotencyKey ??
    (method !== 'GET' && !path.startsWith('/api/auth/') ? newIdempotencyKey() : undefined);
  if (key) headers.set('Idempotency-Key', key);
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(
      0,
      'NETWORK',
      'Cannot reach OPENTRADIE. Check your connection and that the app service is running, then try again.',
    );
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = (payload ?? {}) as { error?: string; message?: string; requestId?: string };
    const code = problem.error ?? `HTTP_${response.status}`;
    if (response.status === 401 && !options.skipUnauthorizedHook) onUnauthorized?.();
    const message =
      (code === 'NOT_FOUND' && FRIENDLY.NOT_FOUND) ||
      problem.message ||
      FRIENDLY[code] ||
      `Request failed (${response.status}). Please try again.`;
    throw new ApiError(response.status, code, message, problem.requestId);
  }
  return payload as T;
}

// --- Session ---------------------------------------------------------------
export const login = (email: string, password: string) =>
  request<{ user: SessionUser }>('/api/auth/login', {
    method: 'POST',
    body: { email, password },
    skipUnauthorizedHook: true,
  });
export const logout = () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' });
export const getMe = () => request<SessionUser>('/api/me', { skipUnauthorizedHook: true });

// --- Workspace data ----------------------------------------------------------
export const getState = () => request<AppState>('/api/state');

/** Health is public and may answer 503 with a body; both are data for the Settings screen. */
export async function getHealth(): Promise<Health> {
  try {
    const response = await fetch('/health', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    const body = (await response.json().catch(() => null)) as Health | null;
    return body ?? { status: response.ok ? 'ok' : 'unavailable' };
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the health endpoint.');
  }
}

// --- Customers -------------------------------------------------------------
export const createCustomer = (input: CustomerInput) =>
  request<Customer>('/api/customers', { method: 'POST', body: input });
/** Expected route (PATCH /api/customers/:id); not in the original scaffold API. */
export const updateCustomer = (id: string, input: CustomerInput) =>
  request<Customer>(`/api/customers/${encodeURIComponent(id)}`, { method: 'PATCH', body: input });

// --- Jobs ------------------------------------------------------------------
export const createJob = (input: JobInput) =>
  request<Job>('/api/jobs', { method: 'POST', body: input });
export const updateJob = (
  id: string,
  input: { status?: JobStatus; reopen?: true; notes?: string; propertyId?: string | null },
) => request<Job>(`/api/jobs/${encodeURIComponent(id)}`, { method: 'PATCH', body: input });
export const getJobDetail = (id: string) =>
  request<JobDetail>(`/api/jobs/${encodeURIComponent(id)}`);
export const addJobNote = (id: string, text: string) =>
  request<{ id: string }>(`/api/jobs/${encodeURIComponent(id)}/notes`, {
    method: 'POST',
    body: { text },
  });
export const uploadEvidence = (id: string, input: EvidenceInput, idempotencyKey: string) =>
  request<JobDocument>(`/api/jobs/${encodeURIComponent(id)}/evidence`, {
    method: 'POST',
    body: input,
    idempotencyKey,
  });
/** Same-origin URL; the session cookie authorises it, so it works in <img> and links. */
export const documentUrl = (id: string) => `/api/documents/${encodeURIComponent(id)}/content`;

// --- Properties ------------------------------------------------------------
export const createProperty = (customerId: string, input: PropertyInput) =>
  request<Property>(`/api/customers/${encodeURIComponent(customerId)}/properties`, {
    method: 'POST',
    body: input,
  });

// --- Export ----------------------------------------------------------------
/** Owner-only; the browser downloads the JSON bundle. */
export const EXPORT_URL = '/api/export';

// --- Assistant -------------------------------------------------------------
export const submitEnquiry = (
  input: { text: string; customerId?: string },
  idempotencyKey: string,
) => request<EnquiryResult>('/api/enquiries', { method: 'POST', body: input, idempotencyKey });

// --- Quotes ----------------------------------------------------------------
export const approveQuote = (id: string, version: number, idempotencyKey: string) =>
  request<QuoteDecision>(`/api/quotes/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: { version },
    idempotencyKey,
  });
/** Expected route (POST /api/quotes/:id/reject, same contract as approve plus optional reason). */
export const rejectQuote = (id: string, version: number, idempotencyKey: string, reason?: string) =>
  request<QuoteDecision>(`/api/quotes/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: reason ? { version, reason } : { version },
    idempotencyKey,
  });
