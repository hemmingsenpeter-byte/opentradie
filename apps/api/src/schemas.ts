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
    notes: z.string().trim().min(1).max(5000).optional(),
  })
  .strict();
export const jobUpdateBody = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    description: optionalText(5000),
    siteAddress: optionalText(500),
    status: jobStatus.optional(),
    notes: z.string().trim().min(1).max(5000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field.');
export const jobListQuery = listQuery
  .extend({ status: jobStatus.optional(), customerId: id.optional() })
  .strict();
export const jobNoteBody = z.object({ text: z.string().trim().min(1).max(5000) }).strict();

export const searchQuery = z.object({ q: z.string().trim().min(2).max(200) }).strict();

export const enquiryBody = z
  .object({
    text: z.string().trim().min(5).max(8000),
    customerId: id.optional(),
    modelApprovalId: id.optional(),
  })
  .strict();

export const quoteLineInput = z
  .object({ rateCode: rateCodeSchema, quantity: z.number().int().positive().max(10_000) })
  .strict();
export const quoteUpdateBody = z
  .object({
    version: z.number().int().positive(),
    lines: z.array(quoteLineInput).min(1).max(50),
    /** The owner's remaining open questions; usually empty once resolved. */
    missingInformation: z.array(z.string().trim().min(1).max(300)).max(30),
  })
  .strict();
export const quoteDecisionBody = z.object({ version: z.number().int().positive() }).strict();
export const quoteRejectBody = quoteDecisionBody
  .extend({ reason: z.string().trim().min(1).max(500).optional() })
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

export const quoteLineResponse = z.object({
  rateCode: z.string(),
  description: z.string(),
  unit: z.enum(['each', 'hour', 'visit']),
  quantity: z.number().int(),
  unitPriceCents: z.number().int(),
  lineTotalCents: z.number().int(),
});
export const quoteResponse = z.object({
  id,
  jobId: id,
  customerId: id,
  customerName: z.string(),
  jobTitle: z.string(),
  status: z.enum(['draft', 'approved', 'rejected']),
  version: z.number().int(),
  currency: z.string(),
  assumptions: z.array(z.string()),
  missingInformation: z.array(z.string()),
  lines: z.array(quoteLineResponse),
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
  documentId: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
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
