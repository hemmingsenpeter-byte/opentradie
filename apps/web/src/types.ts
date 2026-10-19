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

export const JOB_STATUSES = [
  'new',
  'quoted',
  'scheduled',
  'in_progress',
  'completed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface Job {
  id: string;
  customerId: string;
  title: string;
  status: JobStatus;
  notes?: string | null;
  siteAddress?: string | null;
  propertyId?: string | null;
  completedAt?: string | null;
}

/** A job site belonging to a customer. */
export interface Property {
  id: string;
  customerId: string;
  label: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  suburb?: string | null;
  city?: string | null;
  postcode?: string | null;
  accessNotes: string | null;
  address: string;
  archived?: boolean;
}

export interface PropertyInput {
  label?: string;
  addressLine1: string;
  addressLine2?: string;
  suburb?: string;
  city?: string;
  postcode?: string;
  accessNotes?: string;
}

export interface JobDocument {
  id: string;
  kind: 'approved_quote' | 'attachment' | 'photo' | 'other';
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  type: string;
  actorType: 'user' | 'system' | 'agent';
  actorName: string | null;
  fromStatus: JobStatus | null;
  toStatus: JobStatus | null;
  summary: string;
  noteText: string | null;
  createdAt: string;
}

export interface JobNote {
  id: string;
  text: string;
  provenance: 'user_supplied' | 'verified' | 'inferred';
  createdAt: string;
}

/** GET /api/jobs/:id */
export interface JobDetail {
  job: Job;
  customer: Customer;
  property: Property | null;
  nextStatuses: { status: JobStatus; reopen: boolean }[];
  notes: JobNote[];
  documents: JobDocument[];
  timeline: TimelineEvent[];
}

export interface EvidenceInput {
  fileName: string;
  mediaType: string;
  dataBase64: string;
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
  /** Active properties; absent on servers older than the job-card release. */
  properties?: Property[];
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
  propertyId?: string;
  notes?: string;
}

export interface QuoteDecision {
  id: string;
  status: QuoteStatus;
  version: number;
}
