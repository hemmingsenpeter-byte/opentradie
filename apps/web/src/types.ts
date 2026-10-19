/**
 * Response shapes the web client depends on. These mirror apps/api/src/app.ts.
 * Money is always integer cents calculated by the server; the client only formats it.
 */
export type Role = 'owner' | 'viewer';

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
}

export interface Customer {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
}

export const JOB_STATUSES = ['new', 'quoted', 'scheduled', 'in_progress', 'completed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface Job {
  id: string;
  customerId: string;
  title: string;
  status: JobStatus;
  notes?: string | null;
}

export interface Communication {
  id: string;
  customerId?: string | null;
  text: string;
  createdAt: string;
}

/** 'rejected' is expected once the backend adds a reject route; drafts and approvals exist today. */
export type QuoteStatus = 'draft' | 'approved' | 'rejected';

export interface QuoteLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface Quote {
  id: string;
  jobId: string;
  customerId: string;
  status: QuoteStatus;
  version: number;
  assumptions: string[];
  missingInformation: string[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Optional: the tax rate the server applied, if the API exposes it. */
  taxBasisPoints?: number;
  lines: QuoteLine[];
}

export interface ApprovedRate {
  code: string;
  label: string;
  unitPriceCents: number;
}

export interface Business {
  id: string;
  name: string;
  currency: string;
  timeZone: string;
  taxBasisPoints: number;
}

export interface RuntimeSettings {
  profile: string;
  privacyMode: string;
  agentMode: string;
  agentHealth: string | { status: string; message?: string };
  demoData?: boolean;
}

export interface AppState {
  business: Business;
  user: SessionUser;
  customers: Customer[];
  jobs: Job[];
  communications: Communication[];
  quotes: Quote[];
  rates: ApprovedRate[];
  auditEvents: { id: string; action: string; createdAt: string }[];
  settings: RuntimeSettings;
}

/** GET /health. Extra fields the backend adds are displayed as-is. */
export interface Health {
  status: string;
  database?: string;
  profile?: string;
  [key: string]: unknown;
}

export interface Clarification {
  message: string;
  matches: { id: string; name: string }[];
}

export type EnquiryResult =
  | { enquiryId: string; jobId: string; quoteId: string; clarification?: undefined }
  | { enquiryId: string; clarification: Clarification; jobId?: undefined; quoteId?: undefined };

export interface CustomerInput {
  name: string;
  email?: string;
  phone?: string;
}

export interface JobInput {
  customerId: string;
  title: string;
  notes?: string;
}

export interface QuoteDecision {
  id: string;
  status: QuoteStatus;
  version: number;
}
