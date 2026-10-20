import { dataCategories, rateCodeSchema } from '@opentradie/core';
import { z } from 'zod';

export const id = z.string().uuid();
export const idParams = z.object({ id }).strict();
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

// ---------- requests ----------
export const loginBody = z
  .object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(256) })
  .strict();

export const customerCreateBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    preferredName: optionalText(200),
    email: z.string().trim().email().max(254).nullable().optional(),
    phone: z.string().trim().min(3).max(50).nullable().optional(),
    address: optionalText(500),
  })
  .strict();
export const customerUpdateBody = customerCreateBody
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field.');
export const listQuery = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

export const jobStatus = z.enum([
  'new',
  'quoted',
  'scheduled',
  'in_progress',
  'completed',
  'cancelled',
]);
export const jobCreateBody = z
  .object({
    customerId: id,
    title: z.string().trim().min(1).max(300),
    description: optionalText(5000),
    siteAddress: optionalText(500),
    /** A property (job site) of the same customer. */
    propertyId: id.optional(),
    notes: z.string().trim().min(1).max(5000).optional(),
  })
  .strict();
export const jobUpdateBody = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    description: optionalText(5000),
    siteAddress: optionalText(500),
    propertyId: id.nullable().optional(),
    status: jobStatus.optional(),
    /** Required to move a completed or cancelled job back to active work. */
    reopen: z.literal(true).optional(),
    notes: z.string().trim().min(1).max(5000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field.')
  .refine((value) => !value.reopen || value.status, 'reopen needs a status.');
export const jobListQuery = listQuery
  .extend({ status: jobStatus.optional(), customerId: id.optional() })
  .strict();
export const jobNoteBody = z.object({ text: z.string().trim().min(1).max(5000) }).strict();

export const propertyCreateBody = z
  .object({
    label: optionalText(100),
    addressLine1: z.string().trim().min(1).max(200),
    addressLine2: optionalText(200),
    suburb: optionalText(100),
    city: optionalText(100),
    postcode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9 -]{2,12}$/)
      .nullable()
      .optional(),
    accessNotes: optionalText(2000),
  })
  .strict();
export const propertyUpdateBody = propertyCreateBody
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field.');
export const propertyListQuery = listQuery.extend({ customerId: id.optional() }).strict();

export const contactCreateBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    role: optionalText(200),
    email: z.string().trim().email().max(254).nullable().optional(),
    phone: z.string().trim().min(3).max(50).nullable().optional(),
  })
  .strict();

/** Accepted evidence types. The bytes must also match the declared type. */
export const EVIDENCE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
] as const;
/** Decoded size limit; the route's JSON body limit allows for base64 overhead. */
export const EVIDENCE_MAX_BYTES = 6 * 1024 * 1024;
export const EVIDENCE_BODY_LIMIT = 8 * 1024 * 1024 + 4096;
export const evidenceBody = z
  .object({
    fileName: z.string().trim().min(1).max(200),
    mediaType: z.enum(EVIDENCE_MEDIA_TYPES),
    /** File content, standard base64 without a data: prefix. */
    dataBase64: z
      .string()
      .min(4)
      .max(Math.ceil(EVIDENCE_MAX_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Expected base64 content.'),
    kind: z.enum(['photo', 'attachment']).optional(),
  })
  .strict();

export const searchQuery = z.object({ q: z.string().trim().min(2).max(200) }).strict();

export const enquiryBody = z
  .object({
    text: z.string().trim().min(5).max(8000),
    customerId: id.optional(),
    modelApprovalId: id.optional(),
  })
  .strict();

export const LINE_UNITS = [
  'each',
  'hour',
  'visit',
  'metre',
  'square_metre',
  'litre',
  'kilogram',
] as const;
export const quoteStatus = z.enum([
  'draft',
  'approved',
  'sent',
  'accepted',
  'rejected',
  'expired',
  'superseded',
]);
export const quantityMilli = z.number().int().min(1).max(10_000_000);
const taxCode = z.enum(['standard', 'zero_rated', 'exempt']).default('standard');
export const lineDescription = z.string().trim().min(1).max(300);
export const discountBasisPoints = z.number().int().min(0).max(10_000).optional();
const priceCents = z.number().int().min(0).max(1_000_000_000_000);

/** Legacy shape: an approved rate and a whole-number quantity. */
const legacyRateLine = z
  .object({ rateCode: rateCodeSchema, quantity: z.number().int().positive().max(10_000) })
  .strict();
/** Priced from the owner-approved rate card; quantity in thousandths (1.5 h = 1500). */
export const rateLine = z
  .object({
    source: z.literal('approved_rate'),
    rateCode: rateCodeSchema,
    quantityMilli,
    kind: z.enum(['labour', 'material', 'fee']).optional(),
    description: lineDescription.optional(),
    taxCode,
    discountBasisPoints,
  })
  .strict();
/** Material sold at recorded cost plus markup (defaults to the business default markup). */
export const costLine = z
  .object({
    source: z.literal('cost_plus_markup'),
    description: lineDescription,
    unit: z.enum(LINE_UNITS),
    quantityMilli,
    costCents: priceCents,
    markupBasisPoints: z.number().int().min(0).max(100_000).optional(),
    taxCode,
    discountBasisPoints,
  })
  .strict();
/**
 * A price typed by the owner. Accepted only on owner-authenticated routes; the server records
 * the owner's user id. Agent proposals have no route that accepts this shape.
 */
export const ownerLine = z
  .object({
    source: z.literal('owner_entered'),
    kind: z.enum(['labour', 'material', 'fee', 'discount']),
    description: lineDescription,
    unit: z.enum(LINE_UNITS),
    quantityMilli,
    unitPriceCents: priceCents,
    taxCode,
    discountBasisPoints,
  })
  .strict();
export const quoteLineInput = z.union([legacyRateLine, rateLine, costLine, ownerLine]);
export type QuoteLineInput = z.infer<typeof quoteLineInput>;
export const quoteUpdateBody = z
  .object({
    version: z.number().int().positive(),
    lines: z.array(quoteLineInput).min(1).max(100),
    /** The owner's remaining open questions; omitted keeps the current list. */
    missingInformation: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
  })
  .strict();
export const quoteDecisionBody = z.object({ version: z.number().int().positive() }).strict();
export const quoteRejectBody = quoteDecisionBody
  .extend({ reason: z.string().trim().min(1).max(500).optional() })
  .strict();

export const businessSettingsBody = z
  .object({
    gstRegistered: z.boolean().optional(),
    /** NZ GST (IRD) number, with or without hyphens; null clears it. */
    gstNumber: z.string().trim().max(20).nullable().optional(),
    pricesEntered: z.enum(['exclusive', 'inclusive']).optional(),
    quoteValidityDays: z.number().int().min(1).max(365).optional(),
    defaultMaterialMarkupBasisPoints: z.number().int().min(0).max(100_000).optional(),
    paymentTermsDays: z.number().int().min(0).max(365).optional(),
    accountingSalesAccountCode: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,10}$/)
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field.');

/** 32 random bytes, base64url without padding. */
export const acceptanceTokenParams = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
export const customerDecisionBody = z
  .object({
    /** The customer's full name, typed as their signature. */
    name: z.string().trim().min(2).max(200),
    comment: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export const modelApprovalBody = z
  .object({
    purpose: z.enum(['enquiry_interpretation', 'knowledge_embedding']),
    provider: z.string().min(1).max(200),
    dataCategories: z.array(z.enum(dataCategories)).min(1).max(dataCategories.length),
  })
  .strict();

// ---------- responses ----------
export const errorResponse = z.object({
  error: z.string(),
  message: z.string(),
  requestId: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  decision: z.unknown().optional(),
  blockers: z.array(z.string()).optional(),
});

export const userResponse = z.object({
  id,
  email: z.string(),
  displayName: z.string(),
  role: z.enum(['owner', 'viewer']),
  tenantId: id,
});

export const customerResponse = z.object({
  id,
  name: z.string(),
  preferredName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  archived: z.boolean(),
  createdAt: z.string(),
});

export const jobResponse = z.object({
  id,
  customerId: id,
  customerName: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: jobStatus,
  siteAddress: z.string().nullable(),
  propertyId: id.nullable(),
  origin: z.enum(['manual', 'assistant_proposed', 'seed']),
  notes: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
});
export const jobNoteResponse = z.object({
  id,
  text: z.string(),
  provenance: z.enum(['user_supplied', 'verified', 'inferred']),
  createdAt: z.string(),
});

export const propertyResponse = z.object({
  id,
  customerId: id,
  label: z.string().nullable(),
  addressLine1: z.string(),
  addressLine2: z.string().nullable(),
  suburb: z.string().nullable(),
  city: z.string().nullable(),
  postcode: z.string().nullable(),
  accessNotes: z.string().nullable(),
  /** One-line address for display. */
  address: z.string(),
  archived: z.boolean(),
  createdAt: z.string(),
});
export const contactResponse = z.object({
  id,
  name: z.string(),
  role: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
});
export const documentResponse = z.object({
  id,
  kind: z.enum(['approved_quote', 'quote_pdf', 'attachment', 'photo', 'other']),
  fileName: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  quoteId: z.string().nullable(),
  createdAt: z.string(),
});
export const jobEventResponse = z.object({
  id,
  type: z.string(),
  actorType: z.enum(['user', 'system', 'agent', 'customer']),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  fromStatus: jobStatus.nullable(),
  toStatus: jobStatus.nullable(),
  summary: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  /** Note text for note_added events (from job_notes, not copied into the timeline). */
  noteText: z.string().nullable(),
  createdAt: z.string(),
});
export const jobDetailResponse = z.object({
  job: jobResponse,
  customer: customerResponse,
  property: propertyResponse.nullable(),
  nextStatuses: z.array(z.object({ status: jobStatus, reopen: z.boolean() })),
  notes: z.array(jobNoteResponse),
  communications: z.array(z.unknown()),
  documents: z.array(documentResponse),
  quotes: z.array(z.unknown()),
  timeline: z.array(jobEventResponse),
});

export const quoteLineResponse = z.object({
  rateCode: z.string().nullable(),
  description: z.string(),
  unit: z.enum(LINE_UNITS),
  /** Display value (quantityMilli / 1000); may be fractional. */
  quantity: z.number(),
  quantityMilli: z.number().int(),
  kind: z.enum(['labour', 'material', 'fee', 'discount']),
  taxCode: z.enum(['standard', 'zero_rated', 'exempt']),
  priceSource: z.enum(['approved_rate', 'cost_plus_markup', 'owner_entered']),
  unitPriceCents: z.number().int(),
  costCents: z.number().int().nullable(),
  markupBasisPoints: z.number().int().nullable(),
  discountBasisPoints: z.number().int(),
  discountCents: z.number().int(),
  /** Signed: discount lines are negative. */
  lineTotalCents: z.number().int(),
});
export const taxGroupResponse = z.object({
  taxCode: z.enum(['standard', 'zero_rated', 'exempt']),
  rateBasisPoints: z.number().int(),
  netCents: z.number().int(),
  taxCents: z.number().int(),
  grossCents: z.number().int(),
});
export const quoteResponse = z.object({
  id,
  jobId: id,
  customerId: id,
  customerName: z.string(),
  jobTitle: z.string(),
  status: quoteStatus,
  /** Optimistic-concurrency version of this record (changes on every mutation). */
  version: z.number().int(),
  quoteNumber: z.string(),
  /** Document revision shown to the customer (1, 2, …); a revision is a new record. */
  revision: z.number().int(),
  quoteGroupId: id,
  previousVersionId: id.nullable(),
  validUntil: z.string().nullable(),
  sentAt: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  declinedAt: z.string().nullable(),
  expiredAt: z.string().nullable(),
  supersededAt: z.string().nullable(),
  decisionSource: z.enum(['owner', 'customer']).nullable(),
  currency: z.string(),
  assumptions: z.array(z.string()),
  missingInformation: z.array(z.string()),
  lines: z.array(quoteLineResponse),
  gstRegistered: z.boolean(),
  pricesEntered: z.enum(['exclusive', 'inclusive']),
  taxBreakdown: z.array(taxGroupResponse),
  subtotalCents: z.number().int(),
  taxCents: z.number().int(),
  totalCents: z.number().int(),
  taxBasisPoints: z.number().int(),
  canApprove: z.boolean(),
  approval: z
    .object({
      id,
      status: z.enum(['pending', 'approved', 'rejected']),
      decidedAt: z.string().nullable(),
      reason: z.string().nullable(),
    })
    .nullable(),
  customerDecision: z
    .object({
      decision: z.enum(['accepted', 'declined']),
      source: z.enum(['customer', 'owner']),
      signerName: z.string(),
      comment: z.string().nullable(),
      decidedAt: z.string(),
    })
    .nullable(),
  /** The approved-quote JSON record stored at owner approval. */
  documentId: z.string().nullable(),
  /** The PDF generated when the quote was sent. */
  pdfDocumentId: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
export const quoteSendResponse = z.object({
  quote: quoteResponse,
  /** Single-use customer link. Shown to the owner; only its SHA-256 is stored as a credential. */
  acceptanceUrl: z.string(),
  messageDraftId: id,
  pdfDocumentId: id,
  validUntil: z.string(),
});
export const businessSettingsResponse = z.object({
  gstRegistered: z.boolean(),
  gstNumber: z.string().nullable(),
  pricesEntered: z.enum(['exclusive', 'inclusive']),
  quoteValidityDays: z.number().int(),
  defaultMaterialMarkupBasisPoints: z.number().int(),
  taxBasisPoints: z.number().int(),
  paymentTermsDays: z.number().int(),
  accountingSalesAccountCode: z.string(),
});
export const publicQuoteResponse = z.object({
  status: z.enum(['sent', 'accepted', 'rejected']),
  title: z.string(),
  quoteNumber: z.string(),
  revision: z.number().int(),
  business: z.object({ name: z.string(), gstNumberLabel: z.string().nullable() }),
  customerName: z.string(),
  siteLabel: z.string().nullable(),
  dates: z.array(z.object({ label: z.string(), value: z.string() })),
  validUntil: z.string(),
  amountColumnLabel: z.string(),
  lines: z.array(
    z.object({
      description: z.string(),
      quantity: z.string(),
      unit: z.string(),
      unitPrice: z.string(),
      amount: z.string(),
    }),
  ),
  totals: z.array(z.object({ label: z.string(), value: z.string(), emphasis: z.boolean() })),
  notes: z.array(z.string()),
  totalCents: z.number().int(),
  decision: z
    .object({
      decision: z.enum(['accepted', 'declined']),
      signerName: z.string(),
      decidedAt: z.string(),
    })
    .nullable(),
});

export const agentInfo = z.object({
  runtime: z.enum(['mock', 'openclaw']),
  synthetic: z.boolean(),
  provider: z.string(),
  label: z.string().nullable(),
});

export const enquiryResponse = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('clarification_required'),
    enquiryId: id,
    clarification: z.object({
      message: z.string(),
      matches: z.array(z.object({ id, name: z.string() })),
    }),
    proposal: z.object({ workSummary: z.string(), customerQuery: z.string() }),
    agent: agentInfo,
  }),
  z.object({
    status: z.literal('quote_drafted'),
    enquiryId: id,
    jobId: id,
    quoteId: id,
    customer: z.object({
      id,
      name: z.string(),
      matchedBy: z.enum(['selected', 'exact_name', 'surname']),
    }),
    quote: quoteResponse,
    history: z.array(
      z.object({
        jobId: id,
        title: z.string(),
        status: z.string(),
        completedAt: z.string().nullable(),
        notes: z.array(z.string()),
      }),
    ),
    proposal: z.object({ workSummary: z.string(), customerQuery: z.string() }),
    agent: agentInfo,
  }),
]);

export const rateResponse = z.object({
  code: z.string(),
  label: z.string(),
  unit: z.enum(['each', 'hour', 'visit']),
  unitPriceCents: z.number().int(),
});
export const auditEventResponse = z.object({
  id,
  action: z.string(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  requestId: z.string(),
  createdAt: z.string(),
});

export const healthResponse = z.object({
  status: z.enum(['ok', 'degraded', 'unavailable']),
  version: z.string(),
  deployment: z.object({
    profile: z.enum(['local', 'cloud', 'hybrid']),
    installationId: z.string(),
    authoritative: z.boolean(),
  }),
  privacyMode: z.enum(['LOCAL_ONLY', 'APPROVAL_REQUIRED', 'APPROVED_CLOUD']),
  agent: z.object({
    mode: z.enum(['mock', 'openclaw']),
    status: z.enum(['ok', 'unavailable']),
    synthetic: z.boolean(),
    provider: z.string(),
    version: z.string(),
    inferenceLocation: z.enum(['local', 'hosted', 'unverified']),
    attestation: z.enum(['runtime', 'operator']),
    label: z.string().nullable(),
  }),
  database: z.object({
    status: z.enum(['ok', 'unavailable']),
    appliedMigrations: z.number(),
    pendingMigrations: z.array(z.string()),
    pgvector: z.enum(['enabled', 'not_installed']),
  }),
  fileStore: z.object({ kind: z.enum(['local', 's3']), status: z.enum(['ok', 'unavailable']) }),
  embeddings: z.object({
    provider: z.string(),
    location: z.enum(['local', 'hosted', 'unverified']).nullable(),
  }),
});
