import { createHash, randomUUID } from 'node:crypto';
import {
  addDays,
  computeDocumentTotals,
  costPlusMarkupCents,
  documentTitle,
  formatNzGstNumber,
  localDate,
  taxableSupplyInformationRequirements,
  type DocumentTotals,
  type LineInput,
  type LineKind,
  type LineUnit,
  type PriceSource,
  type TaxCode,
  type TaxSettings,
  type TsiCheck,
} from '@opentradie/core';
import {
  recordAudit,
  recordJobEvent,
  writeOutboxEvent,
  type Queryable,
} from '@opentradie/database';
import {
  buildInvoiceDocumentModel,
  DocumentIncompleteError,
  renderInvoicePdf,
} from '@opentradie/documents';
import { POST_INVOICE_TOPIC, type FileStore } from '@opentradie/platform';
import { HttpError, iso, type UserContext } from '../http.js';
import type { InvoiceDto, InvoiceLineInput, InvoiceStatus } from '../invoice-schemas.js';
import { linesFromRequest, taxSettingsFor } from './quotes.js';
import { loadBusiness, loadRates, type Business } from './records.js';

/**
 * Invoices: deterministic, owner-approved documents built from an accepted quote, recorded time
 * (priced from owner-approved rates) and recorded materials (cost x owner-approved markup).
 * No amount ever comes from a client or an agent: every total is computed here by the core engine.
 */

export type LineSource =
  | { type: 'quote_line'; quoteLineId: string }
  | { type: 'time_entry'; timeEntryId: string }
  | { type: 'material'; materialId: string }
  | { type: 'manual' };

interface SourcedLine {
  input: LineInput;
  source: LineSource;
}

export interface InvoiceActor {
  type: 'user';
  userId: string;
}

export function formatInvoiceNumber(sequence: number): string {
  return `INV-${sequence < 10_000 ? String(sequence).padStart(4, '0') : String(sequence)}`;
}

/** Next per-business invoice number. The row lock serialises concurrent allocations. */
export async function allocateInvoiceNumber(client: Queryable, tenantId: string): Promise<string> {
  const result = await client.query<{ n: number }>(
    'UPDATE businesses SET next_invoice_number=next_invoice_number+1 WHERE id=$1 RETURNING next_invoice_number-1 AS n',
    [tenantId],
  );
  if (!result.rows[0]) throw new HttpError(503, 'BUSINESS_UNAVAILABLE', 'Business not set up.');
  return formatInvoiceNumber(result.rows[0].n);
}

function totalsOrReject(lines: readonly LineInput[], settings: TaxSettings): DocumentTotals {
  try {
    return computeDocumentTotals(lines, settings);
  } catch (error) {
    if (error instanceof RangeError)
      throw new HttpError(
        422,
        'INVALID_INVOICE_LINES',
        `Check the invoice lines: ${error.message}`,
      );
    throw error;
  }
}

interface StoredLineRow {
  id: string;
  kind: LineKind;
  description: string;
  unit: LineUnit;
  quantityMilli: number;
  taxCode: TaxCode;
  priceSource: PriceSource;
  rateCode: string | null;
  unitPriceCents: number;
  costCents: number | null;
  markupBp: number | null;
  discountBp: number;
  enteredBy: string | null;
}

function storedToInput(row: StoredLineRow): LineInput {
  return {
    kind: row.kind,
    description: row.description,
    unit: row.unit,
    quantityMilli: row.quantityMilli,
    taxCode: row.taxCode,
    lineDiscountBasisPoints: row.discountBp,
    price:
      row.priceSource === 'approved_rate'
        ? { source: 'approved_rate', rateCode: row.rateCode!, unitPriceCents: row.unitPriceCents }
        : row.priceSource === 'cost_plus_markup'
          ? {
              source: 'cost_plus_markup',
              costCents: row.costCents!,
              markupBasisPoints: row.markupBp!,
            }
          : {
              source: 'owner_entered',
              unitPriceCents: row.unitPriceCents,
              enteredByRole: 'owner',
              enteredByUserId: row.enteredBy!,
            },
  };
}

const storedLineColumns = `id,kind,description,unit,quantity_milli AS "quantityMilli",tax_code AS "taxCode",price_source AS "priceSource",
  rate_code AS "rateCode",unit_price_cents AS "unitPriceCents",cost_cents AS "costCents",markup_bp AS "markupBp",
  discount_bp AS "discountBp",entered_by AS "enteredBy"`;

async function loadSourcedLines(
  client: Queryable,
  tenantId: string,
  invoiceId: string,
): Promise<Array<SourcedLine & { id: string }>> {
  const result = await client.query<
    StoredLineRow & {
      sourceType: LineSource['type'];
      quoteLineId: string | null;
      timeEntryId: string | null;
      materialId: string | null;
    }
  >(
    `SELECT ${storedLineColumns},source_type AS "sourceType",source_quote_line_id AS "quoteLineId",
       source_time_entry_id AS "timeEntryId",source_material_id AS "materialId"
     FROM invoice_lines WHERE tenant_id=$1 AND invoice_id=$2 ORDER BY position`,
    [tenantId, invoiceId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    input: storedToInput(row),
    source:
      row.sourceType === 'quote_line'
        ? { type: 'quote_line', quoteLineId: row.quoteLineId! }
        : row.sourceType === 'time_entry'
          ? { type: 'time_entry', timeEntryId: row.timeEntryId! }
          : row.sourceType === 'material'
            ? { type: 'material', materialId: row.materialId! }
            : { type: 'manual' },
  }));
}

/**
 * Price lines with the core engine, replace the invoice's lines and totals, and move the
 * time-entry and material claims to match. Claims are taken only from unclaimed rows, so a
 * time entry or material can never be billed by two live invoices.
 */
async function writeInvoiceLines(
  client: Queryable,
  input: {
    tenantId: string;
    invoiceId: string;
    lines: readonly SourcedLine[];
    settings: TaxSettings;
  },
): Promise<DocumentTotals> {
  const totals = totalsOrReject(
    input.lines.map((line) => line.input),
    input.settings,
  );
  const { tenantId, invoiceId } = input;
  await client.query('DELETE FROM invoice_lines WHERE tenant_id=$1 AND invoice_id=$2', [
    tenantId,
    invoiceId,
  ]);
  for (const [position, line] of totals.lines.entries()) {
    const { input: lineInput, source } = input.lines[position]!;
    const price = lineInput.price;
    await client.query(
      `INSERT INTO invoice_lines(id,tenant_id,invoice_id,position,kind,description,unit,quantity_milli,unit_price_cents,tax_code,
         price_source,rate_code,cost_cents,markup_bp,discount_bp,gross_cents,discount_cents,line_total_cents,entered_by,
         source_type,source_quote_line_id,source_time_entry_id,source_material_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [
        randomUUID(),
        tenantId,
        invoiceId,
        position,
        line.kind,
        line.description,
        line.unit,
        line.quantityMilli,
        line.unitPriceCents,
        line.taxCode,
        line.priceSource,
        line.rateCode,
        price.source === 'cost_plus_markup' ? price.costCents : null,
        price.source === 'cost_plus_markup' ? price.markupBasisPoints : null,
        line.lineDiscountBasisPoints,
        line.grossCents,
        line.lineDiscountCents,
        line.amountCents,
        price.source === 'owner_entered' ? price.enteredByUserId : null,
        source.type,
        source.type === 'quote_line' ? source.quoteLineId : null,
        source.type === 'time_entry' ? source.timeEntryId : null,
        source.type === 'material' ? source.materialId : null,
      ],
    );
  }
  const timeIds = input.lines.flatMap((line) =>
    line.source.type === 'time_entry' ? [line.source.timeEntryId] : [],
  );
  const materialIds = input.lines.flatMap((line) =>
    line.source.type === 'material' ? [line.source.materialId] : [],
  );
  for (const [table, ids, label] of [
    ['job_time_entries', timeIds, 'time entries'],
    ['job_materials', materialIds, 'materials'],
  ] as const) {
    await client.query(
      `UPDATE ${table} SET invoice_id=NULL WHERE tenant_id=$1 AND invoice_id=$2 AND NOT (id = ANY($3::uuid[]))`,
      [tenantId, invoiceId, ids],
    );
    if (ids.length === 0) continue;
    const claimed = await client.query(
      `UPDATE ${table} SET invoice_id=$2 WHERE tenant_id=$1 AND id = ANY($3::uuid[]) AND (invoice_id IS NULL OR invoice_id=$2)`,
      [tenantId, invoiceId, ids],
    );
    if (claimed.rowCount !== new Set(ids).size)
      throw new HttpError(
        409,
        'ALREADY_INVOICED',
        `Some ${label} are already on another invoice. Reload and try again.`,
      );
  }
  await client.query(
    `UPDATE invoices SET subtotal_cents=$3,tax_cents=$4,total_cents=$5,tax_breakdown=$6,updated_at=now()
     WHERE tenant_id=$1 AND id=$2`,
    [
      tenantId,
      invoiceId,
      totals.subtotalExclCents,
      totals.totalTaxCents,
      totals.totalInclCents,
      JSON.stringify(totals.taxByCode),
    ],
  );
  return totals;
}

export interface CreateInvoiceInput {
  tenantId: string;
  actor: InvoiceActor;
  requestId: string;
  jobId: string;
  quoteId?: string | undefined;
  includeQuote?: boolean | undefined;
  includeTimeEntries?: boolean | undefined;
  includeMaterials?: boolean | undefined;
  /** Extra audit metadata (identifiers only), e.g. the agent proposal that asked for it. */
  auditMetadata?: Record<string, unknown>;
}

/**
 * Create a draft invoice for a completed job. Lines come from the accepted quote (copied as
 * approved) and/or the job's uninvoiced time entries (priced from the owner-approved rate they
 * reference) and priced materials (recorded cost x owner-approved markup). Unpriced materials
 * are left out and reported.
 */
export async function createInvoiceFromJob(
  client: Queryable,
  input: CreateInvoiceInput,
): Promise<{ invoiceId: string; excludedUnpricedMaterials: number }> {
  const { tenantId } = input;
  const job = (
    await client.query<{ id: string; customerId: string; status: string; title: string }>(
      'SELECT id,customer_id AS "customerId",status,title FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [tenantId, input.jobId],
    )
  ).rows[0];
  if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'Job not found.');
  if (job.status !== 'completed')
    throw new HttpError(409, 'JOB_NOT_COMPLETED', 'Mark the job completed before invoicing it.');

  const quote = input.quoteId
    ? (await client.query<QuoteRow>(`${quoteSelect} AND id=$3`, [tenantId, job.id, input.quoteId]))
        .rows[0]
    : (
        await client.query<QuoteRow>(
          `${quoteSelect} AND status='accepted' ORDER BY accepted_at DESC LIMIT 1`,
          [tenantId, job.id],
        )
      ).rows[0];
  if (input.quoteId && !quote) throw new HttpError(404, 'QUOTE_NOT_FOUND', 'Quote not found.');
  if (quote && quote.status !== 'accepted' && input.includeQuote !== false)
    throw new HttpError(
      409,
      'QUOTE_NOT_ACCEPTED',
      'Only an accepted quote can be copied to an invoice.',
    );
  const includeQuote = input.includeQuote ?? Boolean(quote);
  if (includeQuote && !quote)
    throw new HttpError(409, 'NO_ACCEPTED_QUOTE', 'This job has no accepted quote to invoice.');
  const includeTime = input.includeTimeEntries ?? !includeQuote;
  const includeMaterials = input.includeMaterials ?? !includeQuote;

  const business = await loadBusiness(client, tenantId);
  // A quote is invoiced with the tax settings it was accepted under, so its totals carry over.
  const settings: TaxSettings =
    includeQuote && quote
      ? {
          gstRegistered: quote.gstRegistered,
          pricesEntered: quote.pricesEntered,
          standardRateBasisPoints: quote.taxBasisPoints,
        }
      : taxSettingsFor(business);

  const lines: SourcedLine[] = [];
  if (includeQuote && quote) {
    const already = await client.query(
      "SELECT 1 FROM invoices WHERE tenant_id=$1 AND source_quote_id=$2 AND status<>'void'",
      [tenantId, quote.id],
    );
    if (already.rowCount)
      throw new HttpError(
        409,
        'QUOTE_ALREADY_INVOICED',
        'This quote is already on an invoice. Void that invoice first to invoice it again.',
      );
    const quoteLines = await client.query<StoredLineRow>(
      `SELECT ${storedLineColumns} FROM quote_line_items WHERE tenant_id=$1 AND quote_id=$2 ORDER BY position`,
      [tenantId, quote.id],
    );
    for (const row of quoteLines.rows)
      lines.push({
        input: storedToInput(row),
        source: { type: 'quote_line', quoteLineId: row.id },
      });
  }
  if (includeTime) {
    const entries = await client.query<{
      id: string;
      quantityMilli: number;
      description: string | null;
      workDate: string | null;
      code: string;
      label: string;
      unit: LineUnit;
      unitPriceCents: number;
    }>(
      `SELECT t.id,t.quantity_milli AS "quantityMilli",t.description,to_char(t.work_date,'YYYY-MM-DD') AS "workDate",
         r.code,r.label,r.unit,r.unit_price_cents AS "unitPriceCents"
       FROM job_time_entries t JOIN approved_rates r ON r.tenant_id=t.tenant_id AND r.id=t.rate_id
       WHERE t.tenant_id=$1 AND t.job_id=$2 AND t.invoice_id IS NULL ORDER BY t.created_at, t.id FOR UPDATE OF t`,
      [tenantId, job.id],
    );
    for (const entry of entries.rows)
      lines.push({
        input: {
          kind: 'labour',
          description: [entry.label, entry.description, entry.workDate]
            .filter(Boolean)
            .join(' - ')
            .slice(0, 500),
          unit: entry.unit,
          quantityMilli: entry.quantityMilli,
          // The price is the owner-approved rate the entry references; never a stored amount.
          price: {
            source: 'approved_rate',
            rateCode: entry.code,
            unitPriceCents: entry.unitPriceCents,
          },
          taxCode: 'standard',
        },
        source: { type: 'time_entry', timeEntryId: entry.id },
      });
  }
  let excludedUnpricedMaterials = 0;
  if (includeMaterials) {
    const materials = await client.query<{
      id: string;
      description: string;
      unit: LineUnit;
      quantityMilli: number;
      costCents: number | null;
      markupBp: number | null;
      sellUnitCents: number | null;
      priceSource: 'cost_plus_markup' | 'unpriced';
    }>(
      `SELECT id,description,unit,quantity_milli AS "quantityMilli",unit_cost_cents AS "costCents",markup_bp AS "markupBp",
         sell_unit_cents AS "sellUnitCents",price_source AS "priceSource"
       FROM job_materials WHERE tenant_id=$1 AND job_id=$2 AND invoice_id IS NULL ORDER BY created_at, id FOR UPDATE`,
      [tenantId, job.id],
    );
    for (const material of materials.rows) {
      if (material.priceSource !== 'cost_plus_markup') {
        excludedUnpricedMaterials += 1;
        continue;
      }
      // The stored sell price must still be exactly cost x markup.
      if (costPlusMarkupCents(material.costCents!, material.markupBp!) !== material.sellUnitCents)
        throw new HttpError(
          409,
          'MATERIAL_PRICE_MISMATCH',
          'A material sell price does not match its cost and markup.',
        );
      lines.push({
        input: {
          kind: 'material',
          description: material.description,
          unit: material.unit,
          quantityMilli: material.quantityMilli,
          price: {
            source: 'cost_plus_markup',
            costCents: material.costCents!,
            markupBasisPoints: material.markupBp!,
          },
          taxCode: 'standard',
        },
        source: { type: 'material', materialId: material.id },
      });
    }
  }
  if (lines.length === 0)
    throw new HttpError(
      422,
      'NOTHING_TO_INVOICE',
      excludedUnpricedMaterials
        ? 'Nothing to invoice: the only materials have no price yet. Price them first.'
        : 'Nothing to invoice: the job has no accepted quote, uninvoiced time or priced materials.',
    );

  const invoiceId = randomUUID();
  const invoiceNumber = await allocateInvoiceNumber(client, tenantId);
  const issueDate = localDate(new Date(), business.timeZone);
  const dueDate = addDays(issueDate, business.paymentTermsDays);
  await client.query(
    `INSERT INTO invoices(id,tenant_id,invoice_number,customer_id,job_id,source_quote_id,issue_date,due_date,currency,gst_registered,
       prices_entered,tax_basis_points,created_by_type,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'user',$13)`,
    [
      invoiceId,
      tenantId,
      invoiceNumber,
      job.customerId,
      job.id,
      includeQuote && quote ? quote.id : null,
      issueDate,
      dueDate,
      business.currency,
      settings.gstRegistered,
      settings.pricesEntered,
      settings.standardRateBasisPoints,
      input.actor.userId,
    ],
  );
  const totals = await writeInvoiceLines(client, { tenantId, invoiceId, lines, settings });
  const counts = {
    quoteLines: lines.filter((line) => line.source.type === 'quote_line').length,
    timeEntries: lines.filter((line) => line.source.type === 'time_entry').length,
    materials: lines.filter((line) => line.source.type === 'material').length,
  };
  await recordJobEvent(client, {
    tenantId,
    jobId: job.id,
    type: 'invoice_drafted',
    actorType: 'user',
    actorId: input.actor.userId,
    summary: `Invoice ${invoiceNumber} drafted`,
    metadata: { invoiceId, ...counts, ...(input.auditMetadata ?? {}) },
  });
  await recordAudit(client, {
    tenantId,
    actorType: 'user',
    actorId: input.actor.userId,
    action: 'invoice.drafted',
    entityType: 'invoice',
    entityId: invoiceId,
    requestId: input.requestId,
    metadata: {
      invoiceNumber,
      jobId: job.id,
      quoteId: includeQuote && quote ? quote.id : null,
      ...counts,
      excludedUnpricedMaterials,
      totalCents: totals.totalInclCents,
      ...(input.auditMetadata ?? {}),
    },
  });
  return { invoiceId, excludedUnpricedMaterials };
}

interface QuoteRow {
  id: string;
  status: string;
  gstRegistered: boolean;
  pricesEntered: 'exclusive' | 'inclusive';
  taxBasisPoints: number;
}
const quoteSelect = `SELECT id,status,gst_registered AS "gstRegistered",prices_entered AS "pricesEntered",tax_basis_points AS "taxBasisPoints"
  FROM quotes WHERE tenant_id=$1 AND job_id=$2`;

export interface LockedInvoice {
  id: string;
  status: InvoiceStatus;
  version: number;
  jobId: string;
  customerId: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  gstRegistered: boolean;
  pricesEntered: 'exclusive' | 'inclusive';
  taxBasisPoints: number;
  totalCents: number;
  notes: string | null;
  sourceQuoteId: string | null;
}

export async function lockInvoice(
  client: Queryable,
  tenantId: string,
  id: string,
  version: number | null,
): Promise<LockedInvoice> {
  const result = await client.query<LockedInvoice>(
    `SELECT id,status,version,job_id AS "jobId",customer_id AS "customerId",invoice_number AS "invoiceNumber",
       to_char(issue_date,'YYYY-MM-DD') AS "issueDate",to_char(due_date,'YYYY-MM-DD') AS "dueDate",
       gst_registered AS "gstRegistered",prices_entered AS "pricesEntered",tax_basis_points AS "taxBasisPoints",
       total_cents AS "totalCents",notes,source_quote_id AS "sourceQuoteId"
     FROM invoices WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
    [tenantId, id],
  );
  const invoice = result.rows[0];
  if (!invoice) throw new HttpError(404, 'INVOICE_NOT_FOUND', 'Invoice not found.');
  if (version !== null && invoice.version !== version)
    throw new HttpError(409, 'STALE_INVOICE', 'The invoice has changed. Reload it and try again.');
  return invoice;
}

function settingsOf(invoice: {
  gstRegistered: boolean;
  pricesEntered: 'exclusive' | 'inclusive';
  taxBasisPoints: number;
}): TaxSettings {
  return {
    gstRegistered: invoice.gstRegistered,
    pricesEntered: invoice.pricesEntered,
    standardRateBasisPoints: invoice.taxBasisPoints,
  };
}

/** Owner edit of a draft: keep, adjust, remove or add lines. The server prices everything. */
export async function updateInvoiceDraft(
  client: Queryable,
  input: {
    user: UserContext;
    requestId: string;
    invoiceId: string;
    version: number;
    lines: readonly InvoiceLineInput[];
    issueDate?: string | undefined;
    dueDate?: string | undefined;
    notes?: string | null | undefined;
  },
): Promise<void> {
  const { user } = input;
  const invoice = await lockInvoice(client, user.tenantId, input.invoiceId, input.version);
  if (invoice.status !== 'draft')
    throw new HttpError(409, 'INVOICE_NOT_DRAFT', 'Only draft invoices can be edited.');
  const existing = new Map(
    (await loadSourcedLines(client, user.tenantId, invoice.id)).map((line) => [line.id, line]),
  );
  const [rates, business] = await Promise.all([
    loadRates(client, user.tenantId),
    loadBusiness(client, user.tenantId),
  ]);
  const seen = new Set<string>();
  const lines: SourcedLine[] = [];
  for (const requested of input.lines) {
    if ('lineId' in requested) {
      const kept = existing.get(requested.lineId);
      if (!kept || seen.has(requested.lineId))
        throw new HttpError(422, 'UNKNOWN_INVOICE_LINE', 'An edited line is not on this invoice.');
      seen.add(requested.lineId);
      lines.push({
        source: kept.source,
        input: {
          ...kept.input,
          ...(requested.quantityMilli !== undefined
            ? { quantityMilli: requested.quantityMilli }
            : {}),
          ...(requested.description !== undefined ? { description: requested.description } : {}),
          ...(requested.discountBasisPoints !== undefined
            ? { lineDiscountBasisPoints: requested.discountBasisPoints }
            : {}),
          ...(requested.taxCode !== undefined ? { taxCode: requested.taxCode } : {}),
        },
      });
    } else {
      const [line] = linesFromRequest([requested], { rates, business, user });
      lines.push({ input: line!, source: { type: 'manual' } });
    }
  }
  const issueDate = input.issueDate ?? invoice.issueDate;
  const dueDate = input.dueDate ?? invoice.dueDate;
  for (const [label, value] of [
    ['issueDate', issueDate],
    ['dueDate', dueDate],
  ] as const) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
      throw new HttpError(422, 'INVALID_DATE', `${label} must be a YYYY-MM-DD calendar date.`);
  }
  if (dueDate < issueDate)
    throw new HttpError(422, 'INVALID_DATE', 'The due date cannot be before the invoice date.');
  const totals = await writeInvoiceLines(client, {
    tenantId: user.tenantId,
    invoiceId: invoice.id,
    lines,
    settings: settingsOf(invoice),
  });
  await client.query(
    `UPDATE invoices SET version=version+1,issue_date=$3,due_date=$4,notes=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2`,
    [
      user.tenantId,
      invoice.id,
      issueDate,
      dueDate,
      input.notes === undefined ? invoice.notes : input.notes || null,
    ],
  );
  await recordAudit(client, {
    tenantId: user.tenantId,
    actorType: 'user',
    actorId: user.id,
    action: 'invoice.updated',
    entityType: 'invoice',
    entityId: invoice.id,
    requestId: input.requestId,
    metadata: {
      fromVersion: input.version,
      toVersion: input.version + 1,
      lines: totals.lines.length,
      totalCents: totals.totalInclCents,
    },
  });
}

interface DocumentFacts {
  business: Business;
  customer: {
    name: string;
    email: string | null;
    phone: string | null;
    address: string | null;
  };
  site: string | null;
}

async function documentFacts(
  client: Queryable,
  tenantId: string,
  invoice: { jobId: string; customerId: string },
): Promise<DocumentFacts> {
  const business = await loadBusiness(client, tenantId);
  const row = (
    await client.query<DocumentFacts['customer'] & { site: string | null }>(
      `SELECT c.name,c.email,c.phone,c.address,j.site_address AS site
       FROM customers c JOIN jobs j ON j.tenant_id=c.tenant_id AND j.id=$3
       WHERE c.tenant_id=$1 AND c.id=$2`,
      [tenantId, invoice.customerId, invoice.jobId],
    )
  ).rows[0]!;
  const { site, ...customer } = row;
  return { business, customer, site };
}

/**
 * Taxable supply information check for what the invoice document will show. Anything in
 * `missing` or `problems` blocks approval with that explicit list.
 */
export function invoiceReadiness(
  facts: DocumentFacts,
  invoice: { gstRegistered: boolean; issueDate: string; totalCents: number },
  lines: readonly LineInput[],
): TsiCheck {
  const registered = invoice.gstRegistered;
  const check = taxableSupplyInformationRequirements({
    gstRegistered: registered,
    title: documentTitle('invoice', registered),
    supplierName: facts.business.name,
    supplierGstNumber: registered ? facts.business.gstNumber : null,
    date: invoice.issueDate,
    recipient: facts.customer,
    lines: lines.map((line) => ({
      description: line.description,
      quantityMilli: line.quantityMilli,
    })),
    totalInclCents: invoice.totalCents,
    showsGstAmount: registered,
    statesTotalIncludesGst: registered,
    showsExclusiveTotal: registered,
  });
  const missing = [...check.missing];
  if (lines.length === 0) missing.push('at least one invoice line');
  // Documents always print the GST number for a registered business, whatever the amount.
  if (registered && !facts.business.gstNumber && !missing.includes('supplier GST number'))
    missing.push('supplier GST number');
  return { ...check, missing };
}

/** Owner approval: TSI check, PDF document, then (same transaction) the posting outbox event. */
export async function approveInvoice(
  client: Queryable,
  input: {
    user: UserContext;
    requestId: string;
    invoiceId: string;
    version: number;
    fileStore: FileStore;
    /** Whether an accounting provider is configured; posting is queued only then. */
    accountingEnabled: boolean;
  },
): Promise<void> {
  const { user } = input;
  const invoice = await lockInvoice(client, user.tenantId, input.invoiceId, input.version);
  if (invoice.status !== 'draft')
    throw new HttpError(409, 'INVOICE_NOT_DRAFT', 'Only a draft invoice can be approved.');
  const lines = (await loadSourcedLines(client, user.tenantId, invoice.id)).map(
    (line) => line.input,
  );
  const facts = await documentFacts(client, user.tenantId, invoice);
  const readiness = invoiceReadiness(facts, invoice, lines);
  if (readiness.missing.length || readiness.problems.length)
    throw new HttpError(
      422,
      'INVOICE_INCOMPLETE',
      'The invoice is missing information it must show before it can be approved.',
      { missing: readiness.missing, problems: readiness.problems },
    );
  const model = buildInvoiceDocumentModel({
    business: {
      name: facts.business.name,
      gstNumber: facts.business.gstNumber ? formatNzGstNumber(facts.business.gstNumber) : null,
    },
    customer: facts.customer,
    site: facts.site,
    tax: settingsOf(invoice),
    invoiceNumber: invoice.invoiceNumber,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    lines,
    ...(invoice.notes ? { terms: invoice.notes } : {}),
    quoteReference: invoice.sourceQuoteId
      ? ((
          await client.query<{ n: string }>(
            "SELECT quote_number || CASE WHEN revision>1 THEN ' version ' || revision ELSE '' END AS n FROM quotes WHERE tenant_id=$1 AND id=$2",
            [user.tenantId, invoice.sourceQuoteId],
          )
        ).rows[0]?.n ?? null)
      : null,
  });
  if (model.totalsCents.totalInclCents !== invoice.totalCents)
    throw new Error('Invoice totals differ from the stored totals.');
  let pdf: Buffer;
  try {
    pdf = await renderInvoicePdf(model);
  } catch (error) {
    if (error instanceof DocumentIncompleteError)
      throw new HttpError(
        422,
        'INVOICE_INCOMPLETE',
        'The invoice is missing information it must show before it can be approved.',
        { missing: error.missing, problems: [] },
      );
    throw error;
  }
  const key = `tenants/${user.tenantId}/invoices/${invoice.id}/${invoice.invoiceNumber}-v${invoice.version}.pdf`;
  const stored = await input.fileStore.put(key, pdf, { contentType: 'application/pdf' });
  if (createHash('sha256').update(pdf).digest('hex') !== stored.sha256)
    throw new Error('Stored document checksum mismatch.');
  const documentId = randomUUID();
  await client.query(
    `INSERT INTO documents(id,tenant_id,customer_id,job_id,invoice_id,kind,storage_key,file_name,media_type,size_bytes,sha256)
     VALUES($1,$2,$3,$4,$5,'invoice_pdf',$6,$7,'application/pdf',$8,$9)`,
    [
      documentId,
      user.tenantId,
      invoice.customerId,
      invoice.jobId,
      invoice.id,
      key,
      `${invoice.invoiceNumber}.pdf`,
      stored.sizeBytes,
      stored.sha256,
    ],
  );
  await client.query(
    `UPDATE invoices SET status='approved',approved_by=$3,approved_at=now(),pdf_document_id=$4,updated_at=now()
     WHERE tenant_id=$1 AND id=$2`,
    [user.tenantId, invoice.id, user.id, documentId],
  );
  // Same transaction: the approval and the instruction to post it commit together (ADR 0012).
  if (input.accountingEnabled)
    await writeOutboxEvent(client, {
      tenantId: user.tenantId,
      topic: POST_INVOICE_TOPIC,
      payload: { invoiceId: invoice.id, version: invoice.version },
      dedupeKey: `post_invoice:${invoice.id}:v${invoice.version}`,
    });
  await recordJobEvent(client, {
    tenantId: user.tenantId,
    jobId: invoice.jobId,
    type: 'invoice_approved',
    actorType: 'user',
    actorId: user.id,
    summary: `Invoice ${invoice.invoiceNumber} approved`,
    metadata: { invoiceId: invoice.id, documentId },
  });
  await recordAudit(client, {
    tenantId: user.tenantId,
    actorType: 'user',
    actorId: user.id,
    action: 'invoice.approved',
    entityType: 'invoice',
    entityId: invoice.id,
    requestId: input.requestId,
    metadata: {
      version: invoice.version,
      totalCents: invoice.totalCents,
      tsiTier: readiness.tier,
      documentId,
      postingQueued: input.accountingEnabled,
    },
  });
}

/** Void a draft. Its time entries and materials become available to invoice again. */
export async function voidInvoiceDraft(
  client: Queryable,
  input: { user: UserContext; requestId: string; invoiceId: string; version: number },
): Promise<void> {
  const { user } = input;
  const invoice = await lockInvoice(client, user.tenantId, input.invoiceId, input.version);
  if (invoice.status !== 'draft')
    throw new HttpError(
      409,
      'INVOICE_NOT_DRAFT',
      'Only a draft invoice can be voided here. Correct an approved invoice in the accounting system with a credit note.',
    );
  for (const table of ['job_time_entries', 'job_materials'])
    await client.query(`UPDATE ${table} SET invoice_id=NULL WHERE tenant_id=$1 AND invoice_id=$2`, [
      user.tenantId,
      invoice.id,
    ]);
  await client.query(
    `UPDATE invoices SET status='void',voided_by=$3,voided_at=now(),version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2`,
    [user.tenantId, invoice.id, user.id],
  );
  await recordJobEvent(client, {
    tenantId: user.tenantId,
    jobId: invoice.jobId,
    type: 'invoice_voided',
    actorType: 'user',
    actorId: user.id,
    summary: `Draft invoice ${invoice.invoiceNumber} voided`,
    metadata: { invoiceId: invoice.id },
  });
  await recordAudit(client, {
    tenantId: user.tenantId,
    actorType: 'user',
    actorId: user.id,
    action: 'invoice.voided',
    entityType: 'invoice',
    entityId: invoice.id,
    requestId: input.requestId,
    metadata: { version: invoice.version },
  });
}

/** Owner retry of a failed sync: back to approved, with a fresh outbox event. */
export async function retryInvoiceSync(
  client: Queryable,
  input: { user: UserContext; requestId: string; invoiceId: string },
): Promise<void> {
  const { user } = input;
  const invoice = await lockInvoice(client, user.tenantId, input.invoiceId, null);
  if (invoice.status !== 'sync_failed')
    throw new HttpError(
      409,
      'INVOICE_NOT_FAILED',
      'Only an invoice whose sync failed can be retried.',
    );
  await client.query(
    `UPDATE invoices SET status='approved',sync_error_kind=NULL,sync_error_message=NULL,sync_error_issues='[]',updated_at=now()
     WHERE tenant_id=$1 AND id=$2`,
    [user.tenantId, invoice.id],
  );
  // A new event (new dedupe key) for a new attempt. The provider idempotency key is still derived
  // from (invoice id, version), so a retry can never create a second ledger invoice.
  await writeOutboxEvent(client, {
    tenantId: user.tenantId,
    topic: POST_INVOICE_TOPIC,
    payload: { invoiceId: invoice.id, version: invoice.version },
    dedupeKey: `post_invoice:${invoice.id}:v${invoice.version}:retry:${randomUUID()}`,
  });
  await recordAudit(client, {
    tenantId: user.tenantId,
    actorType: 'user',
    actorId: user.id,
    action: 'invoice.sync_retried',
    entityType: 'invoice',
    entityId: invoice.id,
    requestId: input.requestId,
    metadata: {},
  });
}

// ---------------------------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------------------------

const invoiceColumns = `i.id,i.invoice_number AS "invoiceNumber",i.status,i.version,i.job_id AS "jobId",j.title AS "jobTitle",
  i.customer_id AS "customerId",c.name AS "customerName",i.source_quote_id AS "sourceQuoteId",
  to_char(i.issue_date,'YYYY-MM-DD') AS "issueDate",to_char(i.due_date,'YYYY-MM-DD') AS "dueDate",i.currency,
  i.gst_registered AS "gstRegistered",i.prices_entered AS "pricesEntered",i.tax_basis_points AS "taxBasisPoints",
  i.tax_breakdown AS "taxBreakdown",i.subtotal_cents AS "subtotalCents",i.tax_cents AS "taxCents",i.total_cents AS "totalCents",
  i.notes,i.created_at AS "createdAt",i.approved_at AS "approvedAt",i.voided_at AS "voidedAt",
  i.pdf_document_id AS "pdfDocumentId",i.accounting_provider AS "accountingProvider",i.external_invoice_id AS "externalInvoiceId",
  i.provider_invoice_number AS "providerInvoiceNumber",i.provider_status AS "providerStatus",
  i.provider_total_cents AS "providerTotalCents",i.posted_at AS "postedAt",i.amount_paid_cents AS "amountPaidCents",
  i.amount_due_cents AS "amountDueCents",i.last_reconciled_at AS "lastReconciledAt",i.sync_error_kind AS "syncErrorKind",
  i.sync_error_message AS "syncErrorMessage",i.sync_error_issues AS "syncErrorIssues"`;

async function invoiceRows(
  client: Queryable,
  tenantId: string,
  where: string,
  values: unknown[],
  detail: boolean,
): Promise<InvoiceDto[]> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${invoiceColumns} FROM invoices i
       JOIN customers c ON c.tenant_id=i.tenant_id AND c.id=i.customer_id
       JOIN jobs j ON j.tenant_id=i.tenant_id AND j.id=i.job_id
     WHERE i.tenant_id=$1 ${where} ORDER BY i.created_at DESC LIMIT 200`,
    [tenantId, ...values],
  );
  if (result.rows.length === 0) return [];
  const ids = result.rows.map((row) => row.id as string);
  const lines = await client.query<Record<string, unknown>>(
    `SELECT invoice_id AS "invoiceId",id,rate_code AS "rateCode",description,unit,quantity_milli AS "quantityMilli",kind,tax_code AS "taxCode",
       price_source AS "priceSource",unit_price_cents AS "unitPriceCents",cost_cents AS "costCents",markup_bp AS "markupBasisPoints",
       discount_bp AS "discountBasisPoints",discount_cents AS "discountCents",line_total_cents AS "lineTotalCents",
       source_type AS "sourceType",source_time_entry_id AS "sourceTimeEntryId",source_material_id AS "sourceMaterialId",
       entered_by AS "enteredBy"
     FROM invoice_lines WHERE tenant_id=$1 AND invoice_id = ANY($2::uuid[]) ORDER BY position`,
    [tenantId, ids],
  );
  const attempts = detail
    ? await client.query<Record<string, unknown>>(
        `SELECT invoice_id AS "invoiceId",attempt,status,error_kind AS "errorKind",started_at AS "startedAt",finished_at AS "finishedAt"
         FROM accounting_sync_attempts WHERE tenant_id=$1 AND invoice_id = ANY($2::uuid[]) ORDER BY started_at DESC LIMIT 20`,
        [tenantId, ids],
      )
    : { rows: [] };
  const facts = detail
    ? await documentFacts(client, tenantId, {
        jobId: result.rows[0]!.jobId as string,
        customerId: result.rows[0]!.customerId as string,
      })
    : null;
  return result.rows.map((row) => {
    const own = lines.rows.filter((line) => line.invoiceId === row.id);
    const inputs = own.map((line) =>
      storedToInput({
        ...(line as unknown as StoredLineRow),
        markupBp: line.markupBasisPoints as number | null,
        discountBp: line.discountBasisPoints as number,
      }),
    );
    const readiness: TsiCheck =
      facts && row.status === 'draft'
        ? invoiceReadiness(
            facts,
            {
              gstRegistered: row.gstRegistered as boolean,
              issueDate: row.issueDate as string,
              totalCents: row.totalCents as number,
            },
            inputs,
          )
        : { tier: 'none', missing: [], problems: [] };
    const warnings: string[] = [];
    if (own.some((line) => line.kind === 'discount'))
      warnings.push(
        'Discount lines cannot be posted to the accounting system yet; use a percentage discount on a line instead.',
      );
    if (
      row.providerTotalCents !== null &&
      row.providerTotalCents !== undefined &&
      row.providerTotalCents !== row.totalCents
    )
      warnings.push(
        'The accounting system total differs from this invoice (for example GST rounding). The accounting system is authoritative for the ledger; check it there.',
      );
    if (row.providerStatus === 'voided' || row.providerStatus === 'deleted')
      warnings.push(
        `The accounting system reports this invoice as ${row.providerStatus as string}.`,
      );
    return {
      id: row.id as string,
      invoiceNumber: row.invoiceNumber as string,
      status: row.status as InvoiceStatus,
      version: row.version as number,
      jobId: row.jobId as string,
      jobTitle: row.jobTitle as string,
      customerId: row.customerId as string,
      customerName: row.customerName as string,
      sourceQuoteId: (row.sourceQuoteId as string | null) ?? null,
      issueDate: row.issueDate as string,
      dueDate: row.dueDate as string,
      currency: row.currency as string,
      gstRegistered: row.gstRegistered as boolean,
      pricesEntered: row.pricesEntered as 'exclusive' | 'inclusive',
      taxBasisPoints: row.taxBasisPoints as number,
      taxBreakdown: row.taxBreakdown as InvoiceDto['taxBreakdown'],
      subtotalCents: row.subtotalCents as number,
      taxCents: row.taxCents as number,
      totalCents: row.totalCents as number,
      notes: (row.notes as string | null) ?? null,
      lines: own.map(({ invoiceId: _invoiceId, enteredBy: _enteredBy, ...line }) => ({
        ...line,
        quantity: (line.quantityMilli as number) / 1000,
      })) as InvoiceDto['lines'],
      createdAt: iso(row.createdAt as Date)!,
      approvedAt: iso(row.approvedAt as Date | null),
      voidedAt: iso(row.voidedAt as Date | null),
      pdfAvailable: row.pdfDocumentId !== null,
      readiness,
      accounting: {
        provider: (row.accountingProvider as string | null) ?? null,
        externalInvoiceId: (row.externalInvoiceId as string | null) ?? null,
        providerInvoiceNumber: (row.providerInvoiceNumber as string | null) ?? null,
        providerStatus: (row.providerStatus as string | null) ?? null,
        providerTotalCents: (row.providerTotalCents as number | null) ?? null,
        postedAt: iso(row.postedAt as Date | null),
        amountPaidCents: (row.amountPaidCents as number | null) ?? null,
        amountDueCents: (row.amountDueCents as number | null) ?? null,
        lastReconciledAt: iso(row.lastReconciledAt as Date | null),
        syncError: row.syncErrorKind
          ? {
              kind: row.syncErrorKind as string,
              message: (row.syncErrorMessage as string | null) ?? '',
              issues: row.syncErrorIssues as string[],
            }
          : null,
        attempts: attempts.rows
          .filter((attempt) => attempt.invoiceId === row.id)
          .map((attempt) => ({
            attempt: attempt.attempt as number,
            status: attempt.status as string,
            errorKind: (attempt.errorKind as string | null) ?? null,
            startedAt: iso(attempt.startedAt as Date)!,
            finishedAt: iso(attempt.finishedAt as Date | null),
          })),
        warnings,
      },
    };
  });
}

export async function listInvoices(
  client: Queryable,
  tenantId: string,
  filter: { status?: InvoiceStatus | undefined; jobId?: string | undefined } = {},
): Promise<InvoiceDto[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filter.status) {
    values.push(filter.status);
    clauses.push(`AND i.status=$${values.length + 1}`);
  }
  if (filter.jobId) {
    values.push(filter.jobId);
    clauses.push(`AND i.job_id=$${values.length + 1}`);
  }
  return invoiceRows(client, tenantId, clauses.join(' '), values, false);
}

export async function getInvoice(
  client: Queryable,
  tenantId: string,
  id: string,
): Promise<InvoiceDto> {
  const [invoice] = await invoiceRows(client, tenantId, 'AND i.id=$2', [id], true);
  if (!invoice) throw new HttpError(404, 'INVOICE_NOT_FOUND', 'Invoice not found.');
  return invoice;
}
