import { approvalBlockers, type ApprovedRate, type QuotePolicy } from '@opentradie/core';
import type { Queryable } from '@opentradie/database';
import type { z } from 'zod';
import { HttpError, iso } from '../http.js';
import type {
  customerResponse,
  documentResponse,
  jobEventResponse,
  jobResponse,
  propertyResponse,
  quoteResponse,
} from '../schemas.js';

export type CustomerDto = z.infer<typeof customerResponse>;
export type JobDto = z.infer<typeof jobResponse>;
export type PropertyDto = z.infer<typeof propertyResponse>;
export type JobEventDto = z.infer<typeof jobEventResponse>;
export type DocumentDto = z.infer<typeof documentResponse>;
export type QuoteDto = z.infer<typeof quoteResponse>;

export interface Business {
  id: string;
  name: string;
  trade: string;
  currency: string;
  timeZone: string;
  locale: string;
  taxLabel: string;
  taxBasisPoints: number;
  callOutRateCode: string | null;
  demoData: boolean;
  gstRegistered: boolean;
  /** Digits only; formatted for display by the client and documents. */
  gstNumber: string | null;
  pricesEntered: 'exclusive' | 'inclusive';
  quoteValidityDays: number;
  defaultMaterialMarkupBasisPoints: number;
  /** Days from the invoice date to its due date. */
  paymentTermsDays: number;
  /** Revenue account code used for posted invoice lines. */
  accountingSalesAccountCode: string;
}

export async function loadBusiness(client: Queryable, tenantId: string): Promise<Business> {
  const result = await client.query<Business>(
    `SELECT id,name,trade,currency,time_zone AS "timeZone",locale,tax_label AS "taxLabel",tax_basis_points AS "taxBasisPoints",
       call_out_rate_code AS "callOutRateCode",demo_data AS "demoData",gst_registered AS "gstRegistered",gst_number AS "gstNumber",
       prices_entered AS "pricesEntered",quote_validity_days AS "quoteValidityDays",default_material_markup_bp AS "defaultMaterialMarkupBasisPoints",
       payment_terms_days AS "paymentTermsDays",accounting_sales_account_code AS "accountingSalesAccountCode"
     FROM businesses WHERE id=$1`,
    [tenantId],
  );
  if (!result.rows[0])
    throw new HttpError(
      503,
      'BUSINESS_UNAVAILABLE',
      'Business setup has not been completed. Run the database seed.',
    );
  return result.rows[0];
}

export function quotePolicy(business: Business): QuotePolicy {
  return {
    taxBasisPoints: business.taxBasisPoints,
    taxLabel: business.taxLabel,
    callOutRateCode: business.callOutRateCode,
  };
}

export async function loadRates(client: Queryable, tenantId: string): Promise<ApprovedRate[]> {
  const result = await client.query<ApprovedRate>(
    'SELECT code,label,unit,unit_price_cents AS "unitPriceCents" FROM approved_rates WHERE tenant_id=$1 AND active=true ORDER BY code',
    [tenantId],
  );
  return result.rows;
}

const customerColumns = `c.id,c.name,c.preferred_name AS "preferredName",c.email,c.phone,c.address,(c.archived_at IS NOT NULL) AS archived,c.created_at AS "createdAt",
  c.merged_into_id AS "mergedIntoId",
  coalesce((SELECT json_agg(json_build_object('id',t.id,'name',t.name,'colour',t.colour) ORDER BY t.name)
    FROM customer_tags ct JOIN tags t ON t.tenant_id=ct.tenant_id AND t.id=ct.tag_id
    WHERE ct.tenant_id=c.tenant_id AND ct.customer_id=c.id), '[]'::json) AS tags`;
/** Customers carrying the tag named $N (normalised name), when a tag filter is given. */
const tagFilter = (n: number) =>
  `($${n}::text IS NULL OR EXISTS (SELECT 1 FROM customer_tags ct JOIN tags t ON t.tenant_id=ct.tenant_id AND t.id=ct.tag_id
     WHERE ct.tenant_id=c.tenant_id AND ct.customer_id=c.id AND t.name=$${n}))`;

export function customerDto(row: Record<string, unknown>): CustomerDto {
  return { ...(row as CustomerDto), createdAt: iso(row.createdAt as Date)! };
}

export async function listCustomers(
  client: Queryable,
  tenantId: string,
  q: string | undefined,
  limit: number,
  tag: string | null = null,
): Promise<CustomerDto[]> {
  const result = q
    ? await client.query(
        `SELECT ${customerColumns} FROM customers c WHERE c.tenant_id=$1 AND c.archived_at IS NULL
           AND (c.search_vector @@ plainto_tsquery('simple',$2) OR c.name ILIKE $3 OR c.preferred_name ILIKE $3 OR c.email ILIKE $3)
           AND ${tagFilter(5)}
         ORDER BY ts_rank(c.search_vector, plainto_tsquery('simple',$2)) DESC, c.name LIMIT $4`,
        [tenantId, q, likePattern(q), limit, tag],
      )
    : await client.query(
        `SELECT ${customerColumns} FROM customers c WHERE c.tenant_id=$1 AND c.archived_at IS NULL AND ${tagFilter(3)}
         ORDER BY c.name LIMIT $2`,
        [tenantId, limit, tag],
      );
  return result.rows.map(customerDto);
}

export async function getCustomer(
  client: Queryable,
  tenantId: string,
  id: string,
): Promise<CustomerDto> {
  const result = await client.query(
    `SELECT ${customerColumns} FROM customers c WHERE c.tenant_id=$1 AND c.id=$2`,
    [tenantId, id],
  );
  if (!result.rows[0]) throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
  return customerDto(result.rows[0]);
}

const jobColumns = `j.id,j.customer_id AS "customerId",c.name AS "customerName",j.title,j.description,j.status,j.site_address AS "siteAddress",j.property_id AS "propertyId",j.origin,
  (SELECT n.text FROM job_notes n WHERE n.tenant_id=j.tenant_id AND n.job_id=j.id ORDER BY n.created_at DESC LIMIT 1) AS notes,
  j.completed_at AS "completedAt",j.created_at AS "createdAt"`;

function jobDto(row: Record<string, unknown>): JobDto {
  return {
    ...(row as JobDto),
    completedAt: iso(row.completedAt as Date | null),
    createdAt: iso(row.createdAt as Date)!,
  };
}

export async function listJobs(
  client: Queryable,
  tenantId: string,
  filter: {
    q?: string | undefined;
    status?: string | undefined;
    customerId?: string | undefined;
    limit: number;
  },
): Promise<JobDto[]> {
  const result = await client.query(
    `SELECT ${jobColumns} FROM jobs j JOIN customers c ON c.tenant_id=j.tenant_id AND c.id=j.customer_id
     WHERE j.tenant_id=$1
       AND ($2::text IS NULL OR j.search_vector @@ plainto_tsquery('simple',$2) OR j.title ILIKE $3)
       AND ($4::text IS NULL OR j.status=$4)
       AND ($5::uuid IS NULL OR j.customer_id=$5)
     ORDER BY j.created_at DESC LIMIT $6`,
    [
      tenantId,
      filter.q ?? null,
      filter.q ? likePattern(filter.q) : null,
      filter.status ?? null,
      filter.customerId ?? null,
      filter.limit,
    ],
  );
  return result.rows.map(jobDto);
}

export async function getJob(client: Queryable, tenantId: string, id: string): Promise<JobDto> {
  const result = await client.query(
    `SELECT ${jobColumns} FROM jobs j JOIN customers c ON c.tenant_id=j.tenant_id AND c.id=j.customer_id WHERE j.tenant_id=$1 AND j.id=$2`,
    [tenantId, id],
  );
  if (!result.rows[0]) throw new HttpError(404, 'JOB_NOT_FOUND', 'Job not found.');
  return jobDto(result.rows[0]);
}

const propertyColumns = `p.id,p.customer_id AS "customerId",p.label,p.address_line1 AS "addressLine1",p.address_line2 AS "addressLine2",
  p.suburb,p.city,p.postcode,p.access_notes AS "accessNotes",(p.archived_at IS NOT NULL) AS archived,p.created_at AS "createdAt"`;

/** One-line display address, e.g. "14 Kauri Street, Grey Lynn, Auckland 1021". */
export function formatAddress(value: {
  addressLine1: string;
  addressLine2?: string | null;
  suburb?: string | null;
  city?: string | null;
  postcode?: string | null;
}): string {
  const cityLine = [value.city, value.postcode].filter(Boolean).join(' ');
  return [value.addressLine1, value.addressLine2, value.suburb, cityLine]
    .filter((part) => part && part.trim())
    .join(', ');
}

function propertyDto(row: Record<string, unknown>): PropertyDto {
  const dto = row as Omit<PropertyDto, 'address' | 'createdAt'> & { createdAt: Date };
  return { ...dto, address: formatAddress(dto), createdAt: iso(dto.createdAt)! };
}

export async function listProperties(
  client: Queryable,
  tenantId: string,
  filter: { q?: string | undefined; customerId?: string | undefined; limit: number },
): Promise<PropertyDto[]> {
  const result = await client.query(
    `SELECT ${propertyColumns} FROM properties p
     WHERE p.tenant_id=$1 AND p.archived_at IS NULL
       AND ($2::uuid IS NULL OR p.customer_id=$2)
       AND ($3::text IS NULL OR p.search_vector @@ plainto_tsquery('simple',$3) OR p.address_line1 ILIKE $4 OR p.label ILIKE $4 OR p.suburb ILIKE $4)
     ORDER BY p.customer_id, p.created_at LIMIT $5`,
    [
      tenantId,
      filter.customerId ?? null,
      filter.q ?? null,
      filter.q ? likePattern(filter.q) : null,
      filter.limit,
    ],
  );
  return result.rows.map(propertyDto);
}

export async function getProperty(
  client: Queryable,
  tenantId: string,
  id: string,
): Promise<PropertyDto> {
  const result = await client.query(
    `SELECT ${propertyColumns} FROM properties p WHERE p.tenant_id=$1 AND p.id=$2`,
    [tenantId, id],
  );
  if (!result.rows[0]) throw new HttpError(404, 'PROPERTY_NOT_FOUND', 'Property not found.');
  return propertyDto(result.rows[0]);
}

/** A property usable for a job of this customer: same tenant, same customer, not archived. */
export async function propertyForCustomer(
  client: Queryable,
  tenantId: string,
  customerId: string,
  propertyId: string,
): Promise<PropertyDto> {
  const property = await getProperty(client, tenantId, propertyId);
  if (property.customerId !== customerId)
    throw new HttpError(
      422,
      'PROPERTY_CUSTOMER_MISMATCH',
      'That property belongs to a different customer.',
    );
  if (property.archived)
    throw new HttpError(422, 'PROPERTY_ARCHIVED', 'That property has been archived.');
  return property;
}

export async function listJobEvents(
  client: Queryable,
  tenantId: string,
  jobId: string,
): Promise<JobEventDto[]> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT e.id,e.type,e.actor_type AS "actorType",e.actor_id AS "actorId",u.display_name AS "actorName",
       e.from_status AS "fromStatus",e.to_status AS "toStatus",e.summary,e.metadata,n.text AS "noteText",e.created_at AS "createdAt"
     FROM job_events e
       LEFT JOIN users u ON u.tenant_id=e.tenant_id AND u.id=e.actor_id
       LEFT JOIN job_notes n ON e.type='note_added' AND n.tenant_id=e.tenant_id AND n.id::text=e.metadata->>'noteId'
     WHERE e.tenant_id=$1 AND e.job_id=$2 ORDER BY e.created_at DESC, e.id`,
    [tenantId, jobId],
  );
  return result.rows.map((row) => ({
    ...(row as unknown as JobEventDto),
    createdAt: iso(row.createdAt as Date)!,
  }));
}

export async function listJobDocuments(
  client: Queryable,
  tenantId: string,
  jobId: string,
): Promise<DocumentDto[]> {
  const result = await client.query<Record<string, unknown>>(
    'SELECT id,kind,file_name AS "fileName",media_type AS "mediaType",size_bytes AS "sizeBytes",sha256,quote_id AS "quoteId",created_at AS "createdAt" FROM documents WHERE tenant_id=$1 AND job_id=$2 ORDER BY created_at DESC',
    [tenantId, jobId],
  );
  return result.rows.map((row) => ({
    ...(row as unknown as DocumentDto),
    createdAt: iso(row.createdAt as Date)!,
  }));
}

export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, '\\$&')}%`;
}

const quoteColumns = `q.id,q.job_id AS "jobId",q.customer_id AS "customerId",c.name AS "customerName",j.title AS "jobTitle",q.status,q.version,q.currency,
  q.quote_number AS "quoteNumber",q.revision,q.quote_group_id AS "quoteGroupId",q.previous_version_id AS "previousVersionId",
  to_char(q.valid_until,'YYYY-MM-DD') AS "validUntil",q.sent_at AS "sentAt",q.accepted_at AS "acceptedAt",q.declined_at AS "declinedAt",
  q.expired_at AS "expiredAt",q.superseded_at AS "supersededAt",q.decision_source AS "decisionSource",
  q.gst_registered AS "gstRegistered",q.prices_entered AS "pricesEntered",q.tax_breakdown AS "taxBreakdown",
  q.assumptions,q.missing_information AS "missingInformation",q.subtotal_cents AS "subtotalCents",q.tax_cents AS "taxCents",q.total_cents AS "totalCents",
  q.tax_basis_points AS "taxBasisPoints",q.created_at AS "createdAt",q.decided_at AS "decidedAt",
  a.id AS "approvalId",a.status AS "approvalStatus",a.decided_at AS "approvalDecidedAt",a.reason AS "approvalReason",
  qd.decision AS "customerDecision",qd.signer_name AS "signerName",qd.comment AS "decisionComment",qd.decided_at AS "customerDecidedAt",qd.source AS "customerDecisionSource",
  (SELECT d.id FROM documents d WHERE d.tenant_id=q.tenant_id AND d.quote_id=q.id AND d.kind='approved_quote' ORDER BY d.created_at DESC LIMIT 1) AS "documentId",
  (SELECT d.id FROM documents d WHERE d.tenant_id=q.tenant_id AND d.quote_id=q.id AND d.kind='quote_pdf' ORDER BY d.created_at DESC LIMIT 1) AS "pdfDocumentId"`;

async function quoteRows(
  client: Queryable,
  tenantId: string,
  where: string,
  values: unknown[],
): Promise<QuoteDto[]> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${quoteColumns} FROM quotes q
       JOIN customers c ON c.tenant_id=q.tenant_id AND c.id=q.customer_id
       JOIN jobs j ON j.tenant_id=q.tenant_id AND j.id=q.job_id
       LEFT JOIN approval_requests a ON a.tenant_id=q.tenant_id AND a.quote_id=q.id
       LEFT JOIN quote_decisions qd ON qd.tenant_id=q.tenant_id AND qd.quote_id=q.id
     WHERE q.tenant_id=$1 ${where} ORDER BY q.created_at DESC LIMIT 200`,
    [tenantId, ...values],
  );
  if (result.rows.length === 0) return [];
  const lines = await client.query<Record<string, unknown>>(
    `SELECT quote_id AS "quoteId",rate_code AS "rateCode",description,unit,quantity_milli AS "quantityMilli",kind,tax_code AS "taxCode",
       price_source AS "priceSource",unit_price_cents AS "unitPriceCents",cost_cents AS "costCents",markup_bp AS "markupBasisPoints",
       discount_bp AS "discountBasisPoints",discount_cents AS "discountCents",line_total_cents AS "lineTotalCents"
     FROM quote_line_items WHERE tenant_id=$1 AND quote_id = ANY($2::uuid[]) ORDER BY position`,
    [tenantId, result.rows.map((row) => row.id)],
  );
  return result.rows.map((row) => {
    const own = lines.rows
      .filter((line) => line.quoteId === row.id)
      .map(({ quoteId: _quoteId, ...line }) => ({
        ...line,
        // Display only; quantityMilli is the exact value.
        quantity: (line.quantityMilli as number) / 1000,
      })) as QuoteDto['lines'];
    const missingInformation = row.missingInformation as string[];
    const status = row.status as QuoteDto['status'];
    return {
      id: row.id as string,
      jobId: row.jobId as string,
      customerId: row.customerId as string,
      customerName: row.customerName as string,
      jobTitle: row.jobTitle as string,
      status,
      version: row.version as number,
      quoteNumber: row.quoteNumber as string,
      revision: row.revision as number,
      quoteGroupId: row.quoteGroupId as string,
      previousVersionId: (row.previousVersionId as string | null) ?? null,
      validUntil: (row.validUntil as string | null) ?? null,
      sentAt: iso(row.sentAt as Date | null),
      acceptedAt: iso(row.acceptedAt as Date | null),
      declinedAt: iso(row.declinedAt as Date | null),
      expiredAt: iso(row.expiredAt as Date | null),
      supersededAt: iso(row.supersededAt as Date | null),
      decisionSource: (row.decisionSource as 'owner' | 'customer' | null) ?? null,
      currency: row.currency as string,
      assumptions: row.assumptions as string[],
      missingInformation,
      lines: own,
      gstRegistered: row.gstRegistered as boolean,
      pricesEntered: row.pricesEntered as 'exclusive' | 'inclusive',
      taxBreakdown: row.taxBreakdown as QuoteDto['taxBreakdown'],
      subtotalCents: row.subtotalCents as number,
      taxCents: row.taxCents as number,
      totalCents: row.totalCents as number,
      taxBasisPoints: row.taxBasisPoints as number,
      canApprove:
        approvalBlockers({ status, lineCount: own.length, missingInformation }).length === 0,
      approval: row.approvalId
        ? {
            id: row.approvalId as string,
            status: row.approvalStatus as 'pending' | 'approved' | 'rejected',
            decidedAt: iso(row.approvalDecidedAt as Date | null),
            reason: (row.approvalReason as string | null) ?? null,
          }
        : null,
      customerDecision: row.customerDecision
        ? {
            decision: row.customerDecision as 'accepted' | 'declined',
            source: row.customerDecisionSource as 'customer' | 'owner',
            signerName: row.signerName as string,
            comment: (row.decisionComment as string | null) ?? null,
            decidedAt: iso(row.customerDecidedAt as Date)!,
          }
        : null,
      documentId: (row.documentId as string | null) ?? null,
      pdfDocumentId: (row.pdfDocumentId as string | null) ?? null,
      createdAt: iso(row.createdAt as Date)!,
      decidedAt: iso(row.decidedAt as Date | null),
    };
  });
}

export async function listQuotes(
  client: Queryable,
  tenantId: string,
  filter: { status?: string | undefined } = {},
): Promise<QuoteDto[]> {
  return filter.status
    ? quoteRows(client, tenantId, 'AND q.status=$2', [filter.status])
    : quoteRows(client, tenantId, '', []);
}

export async function getQuote(client: Queryable, tenantId: string, id: string): Promise<QuoteDto> {
  const [quote] = await quoteRows(client, tenantId, 'AND q.id=$2', [id]);
  if (!quote) throw new HttpError(404, 'QUOTE_NOT_FOUND', 'Quote not found.');
  return quote;
}
