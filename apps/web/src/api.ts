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
  AccountingStatus,
  MailStatus,
  ActionProposal,
  Invoice,
  InvoiceLineEdit,
  SyncSummary,
  AppState,
  Customer,
  CustomerInput,
  EnquiryResult,
  EvidenceInput,
  InboxIngestResult,
  InboxThreadDetail,
  InboxThreadSummary,
  Health,
  Job,
  JobDetail,
  JobDocument,
  JobInput,
  JobStatus,
  Property,
  PropertyInput,
  BusinessSettings,
  PublicQuote,
  Quote,
  ProposalApproval,
  QuoteDecision,
  QuoteLineRequest,
  QuoteSendResult,
  SessionUser,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    /** Extra fields of the error body, e.g. the missing-information list of INVOICE_INCOMPLETE. */
    readonly details: Record<string, unknown> = {},
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

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
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
    throw new ApiError(
      response.status,
      code,
      message,
      problem.requestId,
      (payload ?? {}) as Record<string, unknown>,
    );
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
export const customerExportUrl = (id: string) => `/api/customers/${encodeURIComponent(id)}/export`;
export const eraseCustomer = (id: string, confirmName: string) =>
  request<{ customerId: string; alreadyErased: boolean; erasedAt: string }>(
    `/api/customers/${encodeURIComponent(id)}/erase`,
    { method: 'POST', body: { confirmName } },
  );

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
export const updateQuoteLines = (
  id: string,
  version: number,
  lines: QuoteLineRequest[],
  idempotencyKey: string,
) =>
  request<Quote>(`/api/quotes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { version, lines },
    idempotencyKey,
  });
/** Approved quote -> sent. Re-sending a sent quote returns the same acceptance link. */
export const sendQuote = (id: string, version: number, idempotencyKey: string) =>
  request<QuoteSendResult>(`/api/quotes/${encodeURIComponent(id)}/send`, {
    method: 'POST',
    body: { version },
    idempotencyKey,
  });
export const reviseQuote = (id: string, version: number, idempotencyKey: string) =>
  request<Quote>(`/api/quotes/${encodeURIComponent(id)}/revise`, {
    method: 'POST',
    body: { version },
    idempotencyKey,
  });
export const quotePdfUrl = (id: string) => `/api/quotes/${encodeURIComponent(id)}/pdf`;
export const getQuoteActivity = (id: string) =>
  request<{ auditEvents: { id: string; action: string; actorType: string; createdAt: string }[] }>(
    `/api/audit-events?entityId=${encodeURIComponent(id)}&limit=50`,
  );

// --- Business settings --------------------------------------------------------
export const updateBusinessSettings = (input: Partial<BusinessSettings>) =>
  request<BusinessSettings>('/api/settings/business', { method: 'PATCH', body: input });

// --- Public customer quote (no sign-in) -----------------------------------------
const publicPath = (token: string) => `/api/public/quotes/${encodeURIComponent(token)}`;
export const getPublicQuote = (token: string) =>
  request<PublicQuote>(publicPath(token), { skipUnauthorizedHook: true });
export const publicQuotePdfUrl = (token: string) => `${publicPath(token)}/pdf`;
export const decidePublicQuote = (
  token: string,
  decision: 'accept' | 'decline',
  input: { name: string; comment?: string },
) =>
  request<PublicQuote>(`${publicPath(token)}/${decision}`, {
    method: 'POST',
    body: input,
    skipUnauthorizedHook: true,
  });

// --- Action proposals (approval inbox) ---------------------------------------
export const listProposals = () =>
  request<{ proposals: ActionProposal[] }>('/api/proposals?limit=60');
/** Approving runs the action on the server; a 422 PROPOSAL_FAILED means it was refused and recorded. */
export const approveProposal = (id: string, input: ProposalApproval, idempotencyKey: string) =>
  request<{ proposal: ActionProposal; replayed: boolean }>(
    `/api/proposals/${encodeURIComponent(id)}/approve`,
    { method: 'POST', body: input, idempotencyKey },
  );
export const rejectProposal = (id: string, reason: string, idempotencyKey: string) =>
  request<ActionProposal>(`/api/proposals/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: { reason },
    idempotencyKey,
  });

// --- Inbox -------------------------------------------------------------------
export type InboxFilter = 'all' | 'needs_review' | 'unread' | 'open';
export const listInboxThreads = (filter: InboxFilter = 'all') =>
  request<{ threads: InboxThreadSummary[] }>(`/api/inbox/threads?filter=${filter}`);
export const getInboxThread = (id: string) =>
  request<InboxThreadDetail>(`/api/inbox/threads/${encodeURIComponent(id)}`);
export const markThreadRead = (id: string) =>
  request<{ marked: number }>(`/api/inbox/threads/${encodeURIComponent(id)}/read`, {
    method: 'POST',
  });
export const pasteEmail = (
  input: { from: string; fromName?: string; subject: string; text: string },
  idempotencyKey: string,
) =>
  request<InboxIngestResult>('/api/inbox/paste', { method: 'POST', body: input, idempotencyKey });
export const createJobFromThread = (id: string, idempotencyKey: string) =>
  request<{ jobId: string; customerId: string }>(
    `/api/inbox/threads/${encodeURIComponent(id)}/create-job`,
    { method: 'POST', body: {}, idempotencyKey },
  );
export const linkThread = (
  id: string,
  input: { customerId?: string | null; jobId?: string | null },
  idempotencyKey: string,
) =>
  request<{ customerId: string | null; jobId: string | null }>(
    `/api/inbox/threads/${encodeURIComponent(id)}/link`,
    { method: 'POST', body: input, idempotencyKey },
  );
/** Approval queues the send; the server never sends twice for one approval. */
export const approveAndSend = (id: string, text: string, idempotencyKey: string) =>
  request<{ id: string; status: string; sendAttempt: number }>(
    `/api/communications/${encodeURIComponent(id)}/approve-send`,
    { method: 'POST', body: { text }, idempotencyKey },
  );
export const discardDraft = (id: string) =>
  request<{ status: string }>(`/api/communications/${encodeURIComponent(id)}/discard`, {
    method: 'POST',
  });

// --- Invoices (ADR 0023) ----------------------------------------------------------
const invoicePath = (id: string) => `/api/invoices/${encodeURIComponent(id)}`;
export const listInvoices = (filter: { jobId?: string } = {}) =>
  request<{ invoices: Invoice[] }>(
    filter.jobId ? `/api/invoices?jobId=${encodeURIComponent(filter.jobId)}` : '/api/invoices',
  );
export const getInvoice = (id: string) => request<Invoice>(invoicePath(id));
/** Lines and amounts are built by the server from the job; the client sends no prices. */
export const createInvoiceForJob = (
  jobId: string,
  input: { includeQuote?: boolean; includeTimeEntries?: boolean; includeMaterials?: boolean },
  idempotencyKey: string,
) =>
  request<Invoice>(`/api/jobs/${encodeURIComponent(jobId)}/invoices`, {
    method: 'POST',
    body: input,
    idempotencyKey,
  });
export const updateInvoiceLines = (
  id: string,
  version: number,
  lines: InvoiceLineEdit[],
  idempotencyKey: string,
) =>
  request<Invoice>(invoicePath(id), {
    method: 'PATCH',
    body: { version, lines },
    idempotencyKey,
  });
export const approveInvoice = (id: string, version: number, idempotencyKey: string) =>
  request<Invoice>(`${invoicePath(id)}/approve`, {
    method: 'POST',
    body: { version },
    idempotencyKey,
  });
export const voidInvoice = (id: string, version: number, idempotencyKey: string) =>
  request<Invoice>(`${invoicePath(id)}/void`, {
    method: 'POST',
    body: { version },
    idempotencyKey,
  });
export const retryInvoiceSync = (id: string, idempotencyKey: string) =>
  request<Invoice>(`${invoicePath(id)}/retry-sync`, { method: 'POST', idempotencyKey });
export const invoicePdfUrl = (id: string) => `${invoicePath(id)}/pdf`;

// --- Mailbox connection ----------------------------------------------------------
export const getMailStatus = () => request<MailStatus>('/api/integrations/mail/status');
export const startMailConnection = (provider: string) =>
  request<{ authorizeUrl: string; mock: boolean }>(
    `/api/integrations/mail/${encodeURIComponent(provider)}/connect`,
  );
export const disconnectMail = (provider: string) =>
  request<{ status: string }>(`/api/integrations/mail/${encodeURIComponent(provider)}/disconnect`, {
    method: 'POST',
  });

// --- Accounting connection --------------------------------------------------------
export const getAccountingStatus = () => request<AccountingStatus>('/api/integrations/xero/status');
export const startAccountingConnection = () =>
  request<{ authorizeUrl: string; mock: boolean }>('/api/integrations/xero/connect');
export const disconnectAccounting = () =>
  request<{ status: string }>('/api/integrations/xero/disconnect', { method: 'POST' });
export const chooseAccountingOrganisation = (organisationId: string) =>
  request<{ organisationId: string }>('/api/integrations/xero/organisation', {
    method: 'POST',
    body: { organisationId },
  });
export const syncAccountingNow = () =>
  request<SyncSummary>('/api/accounting/sync', { method: 'POST' });
/** MOCK adapter only: records a payment in the fake ledger (demos and tests). */
export const recordMockPayment = (invoiceId: string) =>
  request<{ mock: true }>('/api/integrations/accounting/mock/payments', {
    method: 'POST',
    body: { invoiceId },
  });
