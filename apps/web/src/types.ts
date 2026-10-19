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
  kind: 'approved_quote' | 'quote_pdf' | 'attachment' | 'photo' | 'other';
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  type: string;
  actorType: 'user' | 'system' | 'agent' | 'customer';
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
  /** Outbound rows are message drafts (e.g. a sent quote's link); absent on older servers. */
  direction?: 'inbound' | 'outbound';
  text: string;
  createdAt: string;
}

export type QuoteStatus =
  'draft' | 'approved' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'superseded';

export type LineKind = 'labour' | 'material' | 'fee' | 'discount';
export type TaxCode = 'standard' | 'zero_rated' | 'exempt';
export type PriceSource = 'approved_rate' | 'cost_plus_markup' | 'owner_entered';
export const LINE_UNITS = [
  'each',
  'hour',
  'visit',
  'metre',
  'square_metre',
  'litre',
  'kilogram',
] as const;
export type LineUnit = (typeof LINE_UNITS)[number];

export interface QuoteLine {
  description: string;
  /** Display value; quantityMilli is exact (1.5 h = 1500). */
  quantity: number;
  quantityMilli?: number;
  unit?: LineUnit;
  kind?: LineKind;
  taxCode?: TaxCode;
  priceSource?: PriceSource;
  rateCode?: string | null;
  unitPriceCents: number;
  costCents?: number | null;
  markupBasisPoints?: number | null;
  discountBasisPoints?: number;
  /** Signed; discount lines are negative. */
  lineTotalCents: number;
}

export interface TaxGroup {
  taxCode: TaxCode;
  rateBasisPoints: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
}

export interface Quote {
  id: string;
  jobId: string;
  customerId: string;
  status: QuoteStatus;
  version: number;
  quoteNumber?: string;
  revision?: number;
  quoteGroupId?: string;
  previousVersionId?: string | null;
  validUntil?: string | null;
  sentAt?: string | null;
  acceptedAt?: string | null;
  declinedAt?: string | null;
  expiredAt?: string | null;
  decisionSource?: 'owner' | 'customer' | null;
  gstRegistered?: boolean;
  pricesEntered?: 'exclusive' | 'inclusive';
  taxBreakdown?: TaxGroup[];
  assumptions: string[];
  missingInformation: string[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Optional: the tax rate the server applied, if the API exposes it. */
  taxBasisPoints?: number;
  lines: QuoteLine[];
  customerDecision?: {
    decision: 'accepted' | 'declined';
    source: 'customer' | 'owner';
    signerName: string;
    comment: string | null;
    decidedAt: string;
  } | null;
  pdfDocumentId?: string | null;
  createdAt?: string;
}

/** A line as the owner's editor sends it; the server prices it. */
export type QuoteLineRequest =
  | {
      source: 'approved_rate';
      rateCode: string;
      quantityMilli: number;
      kind?: 'labour' | 'material' | 'fee';
      taxCode: TaxCode;
      discountBasisPoints?: number;
    }
  | {
      source: 'cost_plus_markup';
      description: string;
      unit: LineUnit;
      quantityMilli: number;
      costCents: number;
      markupBasisPoints?: number;
      taxCode: TaxCode;
      discountBasisPoints?: number;
    }
  | {
      source: 'owner_entered';
      kind: LineKind;
      description: string;
      unit: LineUnit;
      quantityMilli: number;
      unitPriceCents: number;
      taxCode: TaxCode;
      discountBasisPoints?: number;
    };

export interface QuoteSendResult {
  quote: Quote;
  acceptanceUrl: string;
  messageDraftId: string;
  pdfDocumentId: string;
  validUntil: string;
}

export interface BusinessSettings {
  gstRegistered: boolean;
  gstNumber: string | null;
  pricesEntered: 'exclusive' | 'inclusive';
  quoteValidityDays: number;
  defaultMaterialMarkupBasisPoints: number;
  taxBasisPoints: number;
}

/** GET /api/public/quotes/:token — already formatted by the server. */
export interface PublicQuote {
  status: 'sent' | 'accepted' | 'rejected';
  title: string;
  quoteNumber: string;
  revision: number;
  business: { name: string; gstNumberLabel: string | null };
  customerName: string;
  siteLabel: string | null;
  dates: { label: string; value: string }[];
  validUntil: string;
  amountColumnLabel: string;
  lines: {
    description: string;
    quantity: string;
    unit: string;
    unitPrice: string;
    amount: string;
  }[];
  totals: { label: string; value: string; emphasis: boolean }[];
  notes: string[];
  totalCents: number;
  decision: { decision: 'accepted' | 'declined'; signerName: string; decidedAt: string } | null;
}

export interface ApprovedRate {
  code: string;
  label: string;
  unit?: string;
  unitPriceCents: number;
}

export interface Business {
  id: string;
  name: string;
  currency: string;
  timeZone: string;
  taxBasisPoints: number;
  gstRegistered?: boolean;
  gstNumber?: string | null;
  pricesEntered?: 'exclusive' | 'inclusive';
  quoteValidityDays?: number;
  defaultMaterialMarkupBasisPoints?: number;
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
