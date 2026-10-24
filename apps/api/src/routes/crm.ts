import {
  customerReportCsv,
  normaliseTagName,
  reportPeriod,
  type DateRange,
  type ReportPeriod,
} from '@opentradie/core';
import { recordAudit, TAG_COLOURS, type Database, type Transaction } from '@opentradie/database';
import { z } from 'zod';
import { HttpError, type RouteRegistry, type UserContext } from '../http.js';
import { errorResponse, idParams } from '../schemas.js';
import {
  customerReport,
  dismissDuplicate,
  ensureTag,
  getTag,
  listDuplicates,
  listTags,
  mergeCustomers,
  mergePreview,
  setCustomerTags,
} from '../services/crm.js';
import { getCustomer } from '../services/records.js';

const id = z.string().uuid();
const tagName = z.string().trim().min(1).max(40);
const tagColour = z.enum(TAG_COLOURS);
const tagResponse = z.object({
  id,
  name: z.string(),
  colour: z.string(),
  customerCount: z.number().int(),
  createdAt: z.string(),
});
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const reportQuery = z
  .object({
    period: z.enum(['this_month', 'last_month', 'this_financial_year']).optional(),
    from: date.optional(),
    to: date.optional(),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .strict();

function audit(client: Transaction, user: UserContext, requestId: string) {
  return (action: string, entityType: string, entityId: string, metadata = {}) =>
    recordAudit(client, {
      tenantId: user.tenantId,
      actorType: 'user',
      actorId: user.id,
      action,
      entityType,
      entityId,
      requestId,
      metadata,
    });
}

const unique = (error: unknown) => (error as { code?: string }).code === '23505';

/** Customer tags, duplicates and merge, and customer reports (ADR 0034). */
export function registerCrmRoutes(api: RouteRegistry, deps: { db: Database }) {
  const { db } = deps;

  // ---------- tags ----------
  api.route(
    {
      method: 'GET',
      url: '/api/tags',
      summary: 'List customer tags with how many active customers carry each',
      tags: ['customers'],
      auth: 'user',
      responses: { 200: { description: 'Tags', schema: z.object({ tags: z.array(tagResponse) }) } },
    },
    async ({ user }) => ({ body: { tags: await listTags(db.pool, user.tenantId) } }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/tags',
      summary: 'Create a tag (names are stored lower-case; an existing name is refused)',
      tags: ['customers'],
      auth: 'owner',
      idempotent: true,
      body: z.object({ name: tagName, colour: tagColour.default('slate') }).strict(),
      responses: {
        201: { description: 'Created tag', schema: tagResponse },
        409: { description: 'TAG_EXISTS', schema: errorResponse },
      },
    },
    async ({ user, body, request, idempotent }) =>
      idempotent(async (client) => {
        const tag = await ensureTag(client, user.tenantId, body.name, body.colour);
        if (!tag.created)
          throw new HttpError(409, 'TAG_EXISTS', 'A tag with that name already exists.');
        await audit(client, user, request.id)('tag.created', 'tag', tag.id);
        return { status: 201, body: await getTag(client, user.tenantId, tag.id) };
      }),
  );

  api.route(
    {
      method: 'PATCH',
      url: '/api/tags/:id',
      summary: 'Rename or recolour a tag',
      tags: ['customers'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: z
        .object({ name: tagName.optional(), colour: tagColour.optional() })
        .strict()
        .refine(
          (value) => value.name !== undefined || value.colour !== undefined,
          'Nothing to change.',
        ),
      responses: {
        200: { description: 'Updated tag', schema: tagResponse },
        404: { description: 'Not found', schema: errorResponse },
        409: { description: 'TAG_EXISTS', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const name = body.name === undefined ? null : normaliseTagName(body.name);
        const result = await client
          .query(
            'UPDATE tags SET name=coalesce($3,name), colour=coalesce($4,colour) WHERE tenant_id=$1 AND id=$2',
            [user.tenantId, params.id, name, body.colour ?? null],
          )
          .catch((error: unknown) => {
            if (unique(error))
              throw new HttpError(409, 'TAG_EXISTS', 'A tag with that name already exists.');
            throw error;
          });
        if (!result.rowCount) throw new HttpError(404, 'TAG_NOT_FOUND', 'Tag not found.');
        await audit(client, user, request.id)('tag.updated', 'tag', params.id, {
          fields: Object.keys(body),
        });
        return { body: await getTag(client, user.tenantId, params.id) };
      }),
  );

  api.route(
    {
      method: 'DELETE',
      url: '/api/tags/:id',
      summary: 'Delete a tag and remove it from every customer',
      tags: ['customers'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      responses: {
        200: {
          description: 'Deleted',
          schema: z.object({ deleted: z.literal(true), removedFrom: z.number() }),
        },
        404: { description: 'Not found', schema: errorResponse },
      },
    },
    async ({ user, params, request, idempotent }) =>
      idempotent(async (client) => {
        const removed = await client.query(
          'DELETE FROM customer_tags WHERE tenant_id=$1 AND tag_id=$2',
          [user.tenantId, params.id],
        );
        const result = await client.query('DELETE FROM tags WHERE tenant_id=$1 AND id=$2', [
          user.tenantId,
          params.id,
        ]);
        if (!result.rowCount) throw new HttpError(404, 'TAG_NOT_FOUND', 'Tag not found.');
        await audit(client, user, request.id)('tag.deleted', 'tag', params.id, {
          removedFrom: removed.rowCount ?? 0,
        });
        return { body: { deleted: true, removedFrom: removed.rowCount ?? 0 } };
      }),
  );

  api.route(
    {
      method: 'PUT',
      url: '/api/customers/:id/tags',
      summary: "Replace a customer's tags",
      tags: ['customers'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: z.object({ tagIds: z.array(id).max(30) }).strict(),
      responses: {
        200: { description: 'Customer with tags' },
        404: { description: 'Customer or tag not found', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const change = await setCustomerTags(client, user.tenantId, params.id, body.tagIds);
        await audit(client, user, request.id)(
          'customer.tags_updated',
          'customer',
          params.id,
          change,
        );
        return { body: await getCustomer(client, user.tenantId, params.id) };
      }),
  );

  // ---------- duplicates and merge ----------
  api.route(
    {
      method: 'GET',
      url: '/api/customers/duplicates',
      summary:
        'Possible duplicate customers (same email, NZ phone, or similar name at the same address)',
      tags: ['customers'],
      auth: 'user',
      responses: { 200: { description: 'Candidate pairs, highest score first' } },
    },
    async ({ user }) => ({ body: { pairs: await listDuplicates(db.pool, user.tenantId) } }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/customers/:id/not-duplicate',
      summary: 'Mark two customers as not duplicates so the pair is no longer suggested',
      tags: ['customers'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: z.object({ otherId: id }).strict(),
      responses: {
        200: { description: 'Dismissed' },
        404: { description: 'Not found', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const result = await dismissDuplicate(client, user, params.id, body.otherId);
        await audit(client, user, request.id)(
          'customer.duplicate_dismissed',
          'customer',
          params.id,
          {
            otherId: body.otherId,
          },
        );
        return { body: result };
      }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/customers/:id/merge-preview',
      summary: 'What merging this customer into another would move, with warnings',
      tags: ['customers'],
      auth: 'user',
      params: idParams,
      query: z.object({ into: id.optional() }).strict(),
      responses: {
        200: { description: 'Merge preview' },
        404: { description: 'Not found', schema: errorResponse },
        422: { description: 'Merge not allowed', schema: errorResponse },
      },
    },
    async ({ user, params, query }) => {
      if (!query.into) {
        await getCustomer(db.pool, user.tenantId, params.id);
        throw new HttpError(422, 'INTO_REQUIRED', 'Choose the customer to merge into.');
      }
      return { body: await mergePreview(db.pool, user.tenantId, params.id, query.into) };
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/customers/:id/merge',
      summary:
        'Merge this customer into another in one transaction; the merged record is archived and points at the survivor',
      tags: ['customers'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: z.object({ intoId: id, confirm: z.string().trim().min(1).max(200) }).strict(),
      responses: {
        200: { description: 'Merged' },
        404: { description: 'Not found (including other tenants)', schema: errorResponse },
        409: { description: 'ALREADY_MERGED into someone else', schema: errorResponse },
        422: {
          description:
            'MERGE_INTO_SELF, MERGE_TARGET_INVALID, MERGE_SOURCE_ERASED or CONFIRMATION_MISMATCH',
          schema: errorResponse,
        },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => ({
        body: await mergeCustomers(client, user, params.id, body.intoId, body.confirm, request.id),
      })),
  );

  // ---------- reports ----------
  api.route(
    {
      method: 'GET',
      url: '/api/reports/customers',
      summary:
        'Customer report for a period: jobs, quote win rate, invoiced (approved or later, not void), paid and outstanding, in integer cents; format=csv for a spreadsheet',
      tags: ['reports'],
      auth: 'user',
      query: reportQuery,
      responses: {
        200: { description: 'Report (JSON) or CSV' },
        422: { description: 'Bad period', schema: errorResponse },
      },
    },
    async ({ user, query, reply }) => {
      let range: DateRange;
      if (query.from && query.to) range = { from: query.from, to: query.to };
      else {
        const zone = await db.pool.query<{ today: string }>(
          "SELECT to_char(now() AT TIME ZONE time_zone,'YYYY-MM-DD') AS today FROM businesses WHERE id=$1",
          [user.tenantId],
        );
        range = reportPeriod(
          (query.period ?? 'this_month') as ReportPeriod,
          zone.rows[0]?.today ?? new Date().toISOString().slice(0, 10),
        );
      }
      if (
        range.from > range.to ||
        Number.isNaN(Date.parse(range.from)) ||
        Number.isNaN(Date.parse(range.to))
      )
        throw new HttpError(422, 'INVALID_PERIOD', 'The period must start on or before its end.');
      const report = await customerReport(db.pool, user.tenantId, range);
      if (query.format === 'csv') {
        reply.header('content-type', 'text/csv; charset=utf-8');
        reply.header(
          'content-disposition',
          `attachment; filename="customers-${range.from}-to-${range.to}.csv"`,
        );
        return { body: customerReportCsv(report) };
      }
      return { body: report };
    },
  );
}
