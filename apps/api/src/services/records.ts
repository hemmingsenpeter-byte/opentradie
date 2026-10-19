import {
  approvalBlockers,
  type ApprovedRate,
  type QuoteCalculation,
  type QuotePolicy,
} from '@opentradie/core';
import type { Queryable } from '@opentradie/database';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { HttpError, iso } from '../http.js';
import type { customerResponse, jobResponse, quoteResponse } from '../schemas.js';

export type CustomerDto = z.infer<typeof customerResponse>;
export type JobDto = z.infer<typeof jobResponse>;
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
}

export async function loadBusiness(client: Queryable, tenantId: string): Promise<Business> {
  const result = await client.query<Business>(
    `SELECT id,name,trade,currency,time_zone AS "timeZone",locale,tax_label AS "taxLabel",tax_basis_points AS "taxBasisPoints",
       call_out_rate_code AS "callOutRateCode",demo_data AS "demoData" FROM businesses WHERE id=$1`,
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

const customerColumns = `c.id,c.name,c.preferred_name AS "preferredName",c.email,c.phone,c.address,(c.archived_at IS NOT NULL) AS archived,c.created_at AS "createdAt"`;

export function customerDto(row: Record<string, unknown>): CustomerDto {
  return { ...(row as CustomerDto), createdAt: iso(row.createdAt as Date)! };
}

export async function listCustomers(
  client: Queryable,
  tenantId: string,
  q: string | undefined,
  limit: number,
): Promise<CustomerDto[]> {
  const result = q
    ? await client.query(
        `SELECT ${customerColumns} FROM customers c WHERE c.tenant_id=$1 AND c.archived_at IS NULL
           AND (c.search_vector @@ plainto_tsquery('simple',$2) OR c.name ILIKE $3 OR c.preferred_name ILIKE $3 OR c.email ILIKE $3)
         ORDER BY ts_rank(c.search_vector, plainto_tsquery('simple',$2)) DESC, c.name LIMIT $4`,
        [tenantId, q, likePattern(q), limit],
      )
    : await client.query(
        `SELECT ${customerColumns} FROM customers c WHERE c.tenant_id=$1 AND c.archived_at IS NULL ORDER BY c.name LIMIT $2`,
        [tenantId, limit],
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

const jobColumns = `j.id,j.customer_id AS "customerId",c.name AS "customerName",j.title,j.description,j.status,j.site_address AS "siteAddress",j.origin,
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

export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, '\\$&')}%`;
}

const quoteColumns = `q.id,q.job_id AS "jobId",q.customer_id AS "customerId",c.name AS "customerName",j.title AS "jobTitle",q.status,q.version,q.currency,
  q.assumptions,q.missing_information AS "missingInformation",q.subtotal_cents AS "subtotalCents",q.tax_cents AS "taxCents",q.total_cents AS "totalCents",
  q.tax_basis_points AS "taxBasisPoints",q.created_at AS "createdAt",q.decided_at AS "decidedAt",
  a.id AS "approvalId",a.status AS "approvalStatus",a.decided_at AS "approvalDecidedAt",a.reason AS "approvalReason",
  (SELECT d.id FROM documents d WHERE d.tenant_id=q.tenant_id AND d.quote_id=q.id ORDER BY d.created_at DESC LIMIT 1) AS "documentId"`;

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
     WHERE q.tenant_id=$1 ${where} ORDER BY q.created_at DESC LIMIT 200`,
    [tenantId, ...values],
  );
  if (result.rows.length === 0) return [];
  const lines = await client.query<Record<string, unknown>>(
    `SELECT quote_id AS "quoteId",rate_code AS "rateCode",description,unit,quantity,unit_price_cents AS "unitPriceCents",line_total_cents AS "lineTotalCents"
     FROM quote_line_items WHERE tenant_id=$1 AND quote_id = ANY($2::uuid[]) ORDER BY position`,
    [tenantId, result.rows.map((row) => row.id)],
  );
  return result.rows.map((row) => {
    const own = lines.rows
      .filter((line) => line.quoteId === row.id)
      .map(({ quoteId: _quoteId, ...line }) => line) as QuoteDto['lines'];
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
      currency: row.currency as string,
      assumptions: row.assumptions as string[],
      missingInformation,
      lines: own,
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
      documentId: (row.documentId as string | null) ?? null,
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

export async function writeQuoteLines(
  client: Queryable,
  tenantId: string,
  quoteId: string,
  calculation: QuoteCalculation,
): Promise<void> {
  await client.query('DELETE FROM quote_line_items WHERE tenant_id=$1 AND quote_id=$2', [
    tenantId,
    quoteId,
  ]);
  for (const [position, line] of calculation.lines.entries()) {
    await client.query(
      'INSERT INTO quote_line_items(id,tenant_id,quote_id,position,rate_code,description,unit,quantity,unit_price_cents,line_total_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        randomUUID(),
        tenantId,
        quoteId,
        position,
        line.rateCode,
        line.description,
        line.unit,
        line.quantity,
        line.unitPriceCents,
        line.lineTotalCents,
      ],
    );
  }
}
