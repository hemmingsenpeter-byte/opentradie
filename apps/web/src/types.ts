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
  paymentTermsDays: number;
  accountingSalesAccountCode: string;
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
  paymentTermsDays?: number;
  accountingSalesAccountCode?: string;
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
  database?: string | { status?: string };
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

/** An action proposed by the assistant or an agent tool; nothing happens until the owner approves. */
export type ProposalStatus =
  'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'superseded';

export interface ActionProposal {
  id: string;
  tool: string;
  toolTitle: string;
  source: 'agent' | 'voice' | 'email' | 'user';
  status: ProposalStatus;
  /** Server-generated description; never model text. */
  summary: string;
  /** Validated tool input. Free text in it is untrusted and shown as plain text only. */
  payload: Record<string, unknown>;
  clarifications: string[];
  approvalPolicy: 'owner' | 'auto';
  financial: boolean;
  customerFacing: boolean;
  executable: boolean;
  notExecutableReason: string | null;
  jobId: string | null;
  customerId: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionReason: string | null;
  edited: boolean;
  result: { entityType: string; entityId: string } | null;
  failure: { code: string; reason: string | null } | null;
}

export interface ProposalApproval {
  payload?: Record<string, unknown>;
  markupBasisPoints?: number;
}

// --- Inbox (unified email inbox) ----------------------------------------------
export type ThreadReviewReason =
  | 'customer_ambiguous'
  | 'customer_name_only'
  | 'job_ambiguous'
  | 'customer_unknown'
  | 'triage_failed';

export interface InboxThreadSummary {
  id: string;
  channel: string;
  subject: string | null;
  status: 'open' | 'closed' | 'archived';
  needsReview: boolean;
  reviewReason: ThreadReviewReason | null;
  customerId: string | null;
  customerName: string | null;
  jobId: string | null;
  jobTitle: string | null;
  lastMessageAt: string;
  unreadCount: number;
  pendingDrafts: number;
  latestDirection: 'inbound' | 'outbound' | null;
  latestFromName: string | null;
  latestFromAddress: string | null;
  snippet: string | null;
  classification: string | null;
}

export interface InboxMatch {
  customer: {
    id: string | null;
    basis: string;
    confidence: number;
    candidates: { id: string; name: string }[];
  };
  job: {
    id: string | null;
    basis: string;
    confidence: number;
    candidates: { id: string; title: string }[];
  };
}

export interface InboxTriage {
  match?: InboxMatch;
  classification?: string;
  summary?: string;
  suggestedActions?: { type: string; note: string }[];
  draftWarnings?: string[];
  synthetic?: boolean;
  outcome?: { reason?: string; explanation?: string };
  attachments?: { stored: number; rejected: { fileName: string; reason: string }[] };
}

export interface InboxMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  status: 'received' | 'draft' | 'approved' | 'sending' | 'sent' | 'failed' | 'discarded';
  origin: string;
  subject: string | null;
  text: string;
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string[];
  receivedAt: string | null;
  readAt: string | null;
  createdAt: string;
  approvedAt: string | null;
  sentAt: string | null;
  triage: InboxTriage | null;
  triageStatus:
    'not_applicable' | 'pending' | 'completed' | 'policy_denied' | 'unavailable' | 'invalid_output';
  sendErrorCode: string | null;
  sendAttempt: number;
  attachments: { id: string; fileName: string; mediaType: string; sizeBytes: number }[];
}

export interface InboxThreadDetail {
  thread: {
    id: string;
    subject: string | null;
    status: 'open' | 'closed' | 'archived';
    needsReview: boolean;
    reviewReason: ThreadReviewReason | null;
    customerId: string | null;
    customerName: string | null;
    jobId: string | null;
    jobTitle: string | null;
    jobStatus: string | null;
    lastMessageAt: string;
    createdAt: string;
  };
  messages: InboxMessage[];
}

export interface InboxIngestResult {
  status: 'accepted' | 'duplicate';
  communicationId: string;
  threadId: string;
  customerId: string | null;
  jobId: string | null;
  createdCustomer: boolean;
  createdJob: boolean;
  needsReview: boolean;
}

// --- Invoices and accounting (ADR 0023) ---------------------------------------
export type InvoiceStatus =
  'draft' | 'approved' | 'posting' | 'posted' | 'sync_failed' | 'void' | 'paid' | 'part_paid';

export interface InvoiceLine {
  id: string;
  rateCode: string | null;
  description: string;
  unit: string;
  quantity: number;
  quantityMilli: number;
  kind: 'labour' | 'material' | 'fee' | 'discount';
  taxCode: 'standard' | 'zero_rated' | 'exempt';
  priceSource: 'approved_rate' | 'cost_plus_markup' | 'owner_entered';
  unitPriceCents: number;
  discountBasisPoints: number;
  lineTotalCents: number;
  sourceType: 'quote_line' | 'time_entry' | 'material' | 'manual';
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  version: number;
  jobId: string;
  jobTitle: string;
  customerId: string;
  customerName: string;
  sourceQuoteId: string | null;
  issueDate: string;
  dueDate: string;
  currency: string;
  gstRegistered: boolean;
  pricesEntered: 'exclusive' | 'inclusive';
  taxBasisPoints: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  notes: string | null;
  lines: InvoiceLine[];
  createdAt: string;
  approvedAt: string | null;
  voidedAt: string | null;
  pdfAvailable: boolean;
  readiness: { tier: string; missing: string[]; problems: string[] };
  accounting: {
    provider: string | null;
    externalInvoiceId: string | null;
    providerInvoiceNumber: string | null;
    providerStatus: string | null;
    providerTotalCents: number | null;
    postedAt: string | null;
    amountPaidCents: number | null;
    amountDueCents: number | null;
    lastReconciledAt: string | null;
    syncError: { kind: string; message: string; issues: string[] } | null;
    attempts: {
      attempt: number;
      status: string;
      errorKind: string | null;
      startedAt: string;
      finishedAt: string | null;
    }[];
    warnings: string[];
  };
}

/** A new invoice line the owner adds: priced by the server from an approved rate. */
export type InvoiceLineEdit =
  | { lineId: string; quantityMilli?: number }
  | { source: 'approved_rate'; rateCode: string; quantityMilli: number };

export interface AccountingStatus {
  provider: 'none' | 'xero' | 'fake';
  mock: boolean;
  label: string | null;
  status: 'not_configured' | 'disconnected' | 'connected' | 'error';
  statusReason: string | null;
  organisationId: string | null;
  pendingOrganisations: { organisationId: string; name: string }[];
  connectedAt: string | null;
  syncFailures: { invoiceId: string; invoiceNumber: string; kind: string; message: string }[];
}

export interface SyncSummary {
  checked: number;
  updated: number;
  paid: number;
  failed: number;
  blocked: string | null;
}

/** GET /api/integrations/mail/status. `mock` is the fake mailbox: never a real integration. */
export interface MailStatus {
  provider: 'none' | 'gmail' | 'microsoft_graph' | 'fake';
  mock: boolean;
  label: string | null;
  status: 'not_configured' | 'disconnected' | 'connected' | 'error';
  statusReason: string | null;
  connectedAt: string | null;
  /** Last completed mailbox poll; null before the first. */
  lastSyncedAt: string | null;
}

export interface MailSyncResult {
  outcome: 'synced' | 'cursor_initialised' | 'not_connected' | 'reauthorisation_required';
  errorCode: 'MAIL_REAUTHORISATION_REQUIRED' | null;
  imported: number;
  duplicates: number;
  skippedOwn: number;
  rejected: number;
  more: boolean;
  lastSyncedAt: string | null;
}

export type FollowUpCustomerStage =
  'pre_due_courtesy' | 'overdue_1' | 'overdue_2' | 'overdue_final';
export type FollowUpStage = FollowUpCustomerStage | 'escalate_owner';

/** GET /api/settings/collections (ADR 0027). Off by default; every stage needs approval by default. */
export interface CollectionsSettings {
  enabled: boolean;
  preDueCourtesyEnabled: boolean;
  preDueDays: number;
  overdue1Days: number;
  overdue2Days: number;
  overdueFinalDays: number;
  escalateDays: number;
  autoSend: Record<FollowUpCustomerStage, boolean>;
}

export interface FollowUpHistoryItem {
  id: string;
  stage: FollowUpStage;
  status: string;
  reason: string | null;
  communicationId: string | null;
  communicationStatus: string | null;
  threadId: string | null;
  createdAt: string;
}

/** GET /api/invoices/:id/follow-ups */
export interface InvoiceFollowUps {
  enabled: boolean;
  hold: boolean;
  holdReason: string | null;
  next:
    | { stage: FollowUpStage; daysOverdue: number; amountDueCents: number }
    | { stage: 'none'; reason: string; daysOverdue: number };
  history: FollowUpHistoryItem[];
}
