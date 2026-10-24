import { INVOICE_STATUSES } from '@opentradie/database';
import { z } from 'zod';
import {
  costLine,
  discountBasisPoints,
  id,
  lineDescription,
  ownerLine,
  quantityMilli,
  quoteLineResponse,
  rateLine,
  taxGroupResponse,
} from './schemas.js';

// Invoices and accounting sync (ADR 0023).

export const invoiceStatus = z.enum(INVOICE_STATUSES);
export type InvoiceStatus = z.infer<typeof invoiceStatus>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Keep an existing invoice line (its price source and origin), optionally adjusted by the owner. */
const keptInvoiceLine = z
  .object({
    lineId: id,
    quantityMilli: quantityMilli.optional(),
    description: lineDescription.optional(),
    discountBasisPoints,
    taxCode: z.enum(['standard', 'zero_rated', 'exempt']).optional(),
  })
  .strict();
export const invoiceLineInput = z.union([keptInvoiceLine, rateLine, costLine, ownerLine]);
export type InvoiceLineInput = z.infer<typeof invoiceLineInput>;

export const invoiceCreateBody = z
  .object({
    /** An accepted quote of this job; defaults to the job's accepted quote, if any. */
    quoteId: id.optional(),
    includeQuote: z.boolean().optional(),
    includeTimeEntries: z.boolean().optional(),
    includeMaterials: z.boolean().optional(),
  })
  .strict();
export const invoiceUpdateBody = z
  .object({
    version: z.number().int().positive(),
    lines: z.array(invoiceLineInput).min(1).max(200),
    issueDate: isoDate.optional(),
    dueDate: isoDate.optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();
export const invoiceVersionBody = z.object({ version: z.number().int().positive() }).strict();
export const invoiceListQuery = z
  .object({ status: invoiceStatus.optional(), jobId: id.optional() })
  .strict();

export const invoiceLineResponse = quoteLineResponse.extend({
  id,
  sourceType: z.enum(['quote_line', 'time_entry', 'material', 'manual']),
  sourceTimeEntryId: id.nullable(),
  sourceMaterialId: id.nullable(),
});

export const invoiceResponse = z.object({
  id,
  invoiceNumber: z.string(),
  status: invoiceStatus,
  version: z.number().int(),
  jobId: id,
  jobTitle: z.string(),
  customerId: id,
  customerName: z.string(),
  sourceQuoteId: id.nullable(),
  issueDate: z.string(),
  dueDate: z.string(),
  currency: z.string(),
  gstRegistered: z.boolean(),
  pricesEntered: z.enum(['exclusive', 'inclusive']),
  taxBasisPoints: z.number().int(),
  taxBreakdown: z.array(taxGroupResponse),
  subtotalCents: z.number().int(),
  taxCents: z.number().int(),
  totalCents: z.number().int(),
  notes: z.string().nullable(),
  lines: z.array(invoiceLineResponse),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  pdfAvailable: z.boolean(),
  /** Taxable supply information check (GST Act ss 19F-19N); anything listed blocks approval. */
  readiness: z.object({
    tier: z.enum(['not_registered', 'none', 'up_to_1000', 'over_1000']),
    missing: z.array(z.string()),
    problems: z.array(z.string()),
  }),
  accounting: z.object({
    provider: z.string().nullable(),
    externalInvoiceId: z.string().nullable(),
    providerInvoiceNumber: z.string().nullable(),
    providerStatus: z.string().nullable(),
    providerTotalCents: z.number().int().nullable(),
    postedAt: z.string().nullable(),
    amountPaidCents: z.number().int().nullable(),
    amountDueCents: z.number().int().nullable(),
    lastReconciledAt: z.string().nullable(),
    syncError: z
      .object({ kind: z.string(), message: z.string(), issues: z.array(z.string()) })
      .nullable(),
    attempts: z.array(
      z.object({
        attempt: z.number().int(),
        status: z.string(),
        errorKind: z.string().nullable(),
        startedAt: z.string(),
        finishedAt: z.string().nullable(),
      }),
    ),
    warnings: z.array(z.string()),
  }),
});
export type InvoiceDto = z.infer<typeof invoiceResponse>;

export const accountingStatusResponse = z.object({
  provider: z.enum(['none', 'xero', 'fake']),
  /** True for the fake adapter: a mock, never evidence of a real integration. */
  mock: z.boolean(),
  label: z.string().nullable(),
  status: z.enum(['not_configured', 'disconnected', 'connected', 'error']),
  statusReason: z.string().nullable(),
  organisationId: z.string().nullable(),
  pendingOrganisations: z.array(z.object({ organisationId: z.string(), name: z.string() })),
  connectedAt: z.string().nullable(),
  syncFailures: z.array(
    z.object({ invoiceId: id, invoiceNumber: z.string(), kind: z.string(), message: z.string() }),
  ),
});
