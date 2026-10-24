import { createHash } from 'node:crypto';
import type { Database } from '@opentradie/database';
import { reconcileInvoices, type AccountingRuntime, type FileStore } from '@opentradie/platform';
import { z } from 'zod';
import { HttpError, type RouteRegistry } from '../http.js';
import {
  invoiceCreateBody,
  invoiceListQuery,
  invoiceResponse,
  invoiceUpdateBody,
  invoiceVersionBody,
} from '../invoice-schemas.js';
import { errorResponse, idParams } from '../schemas.js';
import { contentDisposition } from '../services/evidence.js';
import {
  approveInvoice,
  createInvoiceFromJob,
  getInvoice,
  listInvoices,
  retryInvoiceSync,
  updateInvoiceDraft,
  voidInvoiceDraft,
} from '../services/invoices.js';

export function registerInvoiceRoutes(
  api: RouteRegistry,
  deps: { db: Database; fileStore: FileStore; accounting: AccountingRuntime | null },
) {
  const { db, fileStore, accounting } = deps;

  api.route(
    {
      method: 'GET',
      url: '/api/invoices',
      summary: 'List invoices (owner or viewer)',
      tags: ['invoices'],
      auth: 'user',
      query: invoiceListQuery,
      responses: {
        200: { description: 'Invoices', schema: z.object({ invoices: z.array(invoiceResponse) }) },
      },
    },
    async ({ user, query }) => ({
      body: { invoices: await listInvoices(api.pool, user.tenantId, query) },
    }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/invoices/:id',
      summary:
        'An invoice with lines, GST, the taxable supply information check, posting status, sync attempts and payment status',
      tags: ['invoices'],
      auth: 'user',
      params: idParams,
      responses: {
        200: { description: 'Invoice', schema: invoiceResponse },
        404: { description: 'INVOICE_NOT_FOUND', schema: errorResponse },
      },
    },
    async ({ user, params }) => ({ body: await getInvoice(api.pool, user.tenantId, params.id) }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/jobs/:id/invoices',
      summary:
        'Owner creates a draft invoice for a completed job from its accepted quote and/or uninvoiced time entries (approved rates) and priced materials. Time and materials already on a live invoice are never billed twice.',
      tags: ['invoices'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: invoiceCreateBody,
      responses: {
        201: { description: 'Draft invoice', schema: invoiceResponse },
        403: { description: 'OWNER_REQUIRED', schema: errorResponse },
        409: {
          description:
            'JOB_NOT_COMPLETED, QUOTE_NOT_ACCEPTED, NO_ACCEPTED_QUOTE, QUOTE_ALREADY_INVOICED or ALREADY_INVOICED',
          schema: errorResponse,
        },
        422: { description: 'NOTHING_TO_INVOICE', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const created = await createInvoiceFromJob(client, {
          tenantId: user.tenantId,
          actor: { type: 'user', userId: user.id },
          requestId: request.id,
          jobId: params.id,
          quoteId: body.quoteId,
          includeQuote: body.includeQuote,
          includeTimeEntries: body.includeTimeEntries,
          includeMaterials: body.includeMaterials,
        });
        return { status: 201, body: await getInvoice(client, user.tenantId, created.invoiceId) };
      }),
  );

  api.route(
    {
      method: 'PATCH',
      url: '/api/invoices/:id',
      summary:
        'Owner edits a draft invoice: keep or adjust existing lines, remove lines (their time and materials become uninvoiced again) or add lines priced from approved rates, cost plus markup or an owner-entered price. The server recomputes every total.',
      tags: ['invoices'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: invoiceUpdateBody,
      responses: {
        200: { description: 'Updated draft', schema: invoiceResponse },
        409: { description: 'STALE_INVOICE or INVOICE_NOT_DRAFT', schema: errorResponse },
        422: {
          description: 'UNKNOWN_RATE, INVALID_INVOICE_LINES or INVALID_DATE',
          schema: errorResponse,
        },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        await updateInvoiceDraft(client, {
          user,
          requestId: request.id,
          invoiceId: params.id,
          version: body.version,
          lines: body.lines,
          issueDate: body.issueDate,
          dueDate: body.dueDate,
          notes: body.notes,
        });
        return { body: await getInvoice(client, user.tenantId, params.id) };
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/invoices/:id/approve',
      summary:
        'Owner approves a draft invoice. Missing taxable supply information blocks approval with an explicit list. Approval stores the PDF and, when an accounting provider is configured, queues the posting in the same transaction.',
      tags: ['invoices'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: invoiceVersionBody,
      responses: {
        200: { description: 'Approved invoice', schema: invoiceResponse },
        409: { description: 'STALE_INVOICE or INVOICE_NOT_DRAFT', schema: errorResponse },
        422: {
          description: 'INVOICE_INCOMPLETE (with missing and problems)',
          schema: errorResponse,
        },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        await approveInvoice(client, {
          user,
          requestId: request.id,
          invoiceId: params.id,
          version: body.version,
          fileStore,
          accountingEnabled: accounting !== null,
        });
        return { body: await getInvoice(client, user.tenantId, params.id) };
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/invoices/:id/void',
      summary: 'Owner voids a draft invoice; its time entries and materials can be invoiced again',
      tags: ['invoices'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: invoiceVersionBody,
      responses: {
        200: { description: 'Voided invoice', schema: invoiceResponse },
        409: { description: 'STALE_INVOICE or INVOICE_NOT_DRAFT', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        await voidInvoiceDraft(client, {
          user,
          requestId: request.id,
          invoiceId: params.id,
          version: body.version,
        });
        return { body: await getInvoice(client, user.tenantId, params.id) };
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/invoices/:id/retry-sync',
      summary:
        'Owner retries posting an invoice whose accounting sync failed. The provider idempotency key is unchanged, so a retry never creates a second ledger invoice.',
      tags: ['invoices'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      responses: {
        200: { description: 'Invoice queued for posting', schema: invoiceResponse },
        409: {
          description: 'INVOICE_NOT_FAILED or ACCOUNTING_NOT_CONFIGURED',
          schema: errorResponse,
        },
      },
    },
    async ({ user, params, request, idempotent }) => {
      if (!accounting)
        throw new HttpError(
          409,
          'ACCOUNTING_NOT_CONFIGURED',
          'No accounting provider is configured.',
        );
      return idempotent(async (client) => {
        await retryInvoiceSync(client, { user, requestId: request.id, invoiceId: params.id });
        return { body: await getInvoice(client, user.tenantId, params.id) };
      });
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/accounting/sync',
      summary:
        'Owner "sync now": read posting status and payments for posted invoices back from the accounting system',
      tags: ['invoices'],
      auth: 'owner',
      idempotent: true,
      responses: {
        200: {
          description: 'Reconciliation summary',
          schema: z.object({
            checked: z.number().int(),
            updated: z.number().int(),
            paid: z.number().int(),
            failed: z.number().int(),
            blocked: z.string().nullable(),
          }),
        },
        409: { description: 'ACCOUNTING_NOT_CONFIGURED', schema: errorResponse },
      },
    },
    async ({ user, request, idempotent }) => {
      if (!accounting)
        throw new HttpError(
          409,
          'ACCOUNTING_NOT_CONFIGURED',
          'No accounting provider is configured.',
        );
      // Provider calls happen outside any transaction; only the replay record is transactional.
      const summary = await reconcileInvoices(db, accounting, user.tenantId, {
        requestId: request.id,
      });
      return idempotent(async () => ({ body: summary }));
    },
  );

  api.route(
    {
      method: 'GET',
      url: '/api/invoices/:id/pdf',
      summary: 'Download the PDF stored when the invoice was approved (owner or viewer)',
      tags: ['invoices'],
      auth: 'user',
      params: idParams,
      responses: {
        200: { description: 'application/pdf' },
        404: { description: 'INVOICE_NOT_FOUND or PDF_NOT_FOUND', schema: errorResponse },
      },
    },
    async ({ user, params, reply }) => {
      const result = await api.pool.query<{ storageKey: string; fileName: string; sha256: string }>(
        `SELECT d.storage_key AS "storageKey",d.file_name AS "fileName",d.sha256 FROM invoices i
         JOIN documents d ON d.tenant_id=i.tenant_id AND d.id=i.pdf_document_id
         WHERE i.tenant_id=$1 AND i.id=$2`,
        [user.tenantId, params.id],
      );
      const document = result.rows[0];
      if (!document) {
        await getInvoice(api.pool, user.tenantId, params.id);
        throw new HttpError(
          404,
          'PDF_NOT_FOUND',
          'No PDF yet: one is created when the invoice is approved.',
        );
      }
      const content = await fileStore.get(document.storageKey);
      if (createHash('sha256').update(content).digest('hex') !== document.sha256)
        throw new HttpError(
          500,
          'DOCUMENT_INTEGRITY',
          'The stored PDF does not match its checksum.',
        );
      reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', contentDisposition(document.fileName))
        .header('cache-control', 'private, no-store');
      return { body: content };
    },
  );
}
