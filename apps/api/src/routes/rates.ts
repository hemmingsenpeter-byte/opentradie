import {
  diffRateCard,
  formatRatesCsv,
  parsePriceToCents,
  parseRateCardCsv,
  rateCodeSchema,
  RATE_UNITS,
  type RatePriceColumn,
} from '@opentradie/core';
import {
  insertApprovedRate,
  RATE_COLUMNS,
  recordAudit,
  recordRateVersion,
  type RateRecord,
  type RateValues,
  type Queryable,
  type Transaction,
} from '@opentradie/database';
import { z } from 'zod';
import { HttpError, iso, type RouteRegistry, type UserContext } from '../http.js';
import { errorResponse, rateResponse } from '../schemas.js';
import { loadBusiness, type Business } from '../services/records.js';

/**
 * Owner rate-card management (ADR 0030). One current row per code in approved_rates; every
 * version in approved_rate_history. Quote and invoice lines keep the unit price they were
 * issued with, so a price change affects new lines only. A retired rate stays in the table
 * (old lines reference it) but is excluded from loadRates, so quotes and agent proposals
 * cannot use it.
 */

const codeParams = z.object({ code: rateCodeSchema }).strict();
const price = z.string().trim().min(1).max(32);
const label = z.string().trim().min(1).max(200);
const unit = z.enum(RATE_UNITS);

const managedRate = rateResponse.extend({
  active: z.boolean(),
  approvedAt: z.string(),
  retiredAt: z.string().nullable(),
  updatedAt: z.string(),
});
const rateVersion = z.object({
  change: z.string(),
  label: z.string(),
  unit: z.enum(RATE_UNITS),
  unitPriceCents: z.number().int(),
  active: z.boolean(),
  changedBy: z.string().nullable(),
  effectiveFrom: z.string(),
});
const rateValues = rateResponse;
const importDiff = z.object({
  mode: z.enum(['preview', 'apply']),
  priceColumn: z.string().nullable(),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
  create: z.array(rateValues),
  update: z.array(
    z.object({
      code: z.string(),
      before: rateValues,
      after: rateValues,
      fields: z.array(z.string()),
    }),
  ),
  unchanged: z.array(z.string()),
  notInFile: z.array(z.string()),
  retiredInFile: z.array(z.string()),
  applied: z.boolean(),
});

const dto = (row: RateRecord) => ({
  code: row.code,
  label: row.label,
  unit: row.unit,
  unitPriceCents: row.unitPriceCents,
  active: row.active,
  approvedAt: iso(row.approvedAt)!,
  retiredAt: iso(row.retiredAt),
  updatedAt: iso(row.updatedAt)!,
});

const NOT_FOUND = () => new HttpError(404, 'NOT_FOUND', 'No rate with that code.');

async function listRates(client: Queryable, tenantId: string, includeRetired: boolean) {
  return (
    await client.query<RateRecord>(
      `SELECT ${RATE_COLUMNS} FROM approved_rates WHERE tenant_id=$1 AND ($2 OR active) ORDER BY active DESC, code`,
      [tenantId, includeRetired],
    )
  ).rows;
}

async function lockRate(client: Transaction, tenantId: string, code: string): Promise<RateRecord> {
  const row = (
    await client.query<RateRecord>(
      `SELECT ${RATE_COLUMNS} FROM approved_rates WHERE tenant_id=$1 AND code=$2 FOR UPDATE`,
      [tenantId, code],
    )
  ).rows[0];
  if (!row) throw NOT_FOUND();
  return row;
}

function cents(text: string): number {
  const parsed = parsePriceToCents(text);
  if (!parsed.ok) throw new HttpError(422, 'INVALID_PRICE', parsed.error);
  return parsed.cents;
}

/** The CSV price column that matches how this business enters prices. */
const priceColumnFor = (business: Business): RatePriceColumn =>
  !business.gstRegistered
    ? 'price_nzd'
    : business.pricesEntered === 'inclusive'
      ? 'price_incl_gst_nzd'
      : 'price_excl_gst_nzd';

async function writeUpdate(
  client: Transaction,
  user: UserContext,
  current: RateRecord,
  next: RateValues,
  change: 'updated' | 'imported',
) {
  const priceChanged = next.unitPriceCents !== current.unitPriceCents;
  await client.query(
    `UPDATE approved_rates SET label=$3,unit=$4,unit_price_cents=$5,updated_at=now(),
       approved_by=CASE WHEN $6 THEN $7::uuid ELSE approved_by END,
       approved_at=CASE WHEN $6 THEN now() ELSE approved_at END
     WHERE tenant_id=$1 AND id=$2`,
    [user.tenantId, current.id, next.label, next.unit, next.unitPriceCents, priceChanged, user.id],
  );
  await recordRateVersion(client, {
    tenantId: user.tenantId,
    rateId: current.id,
    change,
    rate: next,
    active: current.active,
    changedBy: user.id,
  });
}

export function registerRateRoutes(api: RouteRegistry) {
  api.route(
    {
      method: 'GET',
      url: '/api/rates',
      summary:
        'Owner-approved rate card. Active rates only unless includeRetired=true; retired rates cannot be used on new quote lines or agent proposals.',
      tags: ['rates'],
      auth: 'user',
      query: z.object({ includeRetired: z.enum(['true', 'false']).default('false') }).strict(),
      responses: {
        200: { description: 'Rates', schema: z.object({ rates: z.array(managedRate) }) },
      },
    },
    async ({ user, query }) => ({
      body: {
        rates: (await listRates(api.pool, user.tenantId, query.includeRetired === 'true')).map(dto),
      },
    }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/rates/export.csv',
      summary:
        'Download the rate card (active and retired) as CSV in the rates-template.csv format, ready to edit and re-import.',
      tags: ['rates'],
      auth: 'owner',
      responses: { 200: { description: 'text/csv' } },
    },
    async ({ user, reply }) => {
      const business = await loadBusiness(api.pool, user.tenantId);
      const rates = await listRates(api.pool, user.tenantId, true);
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="rates.csv"')
        .header('cache-control', 'private, no-store');
      return { body: formatRatesCsv(rates, priceColumnFor(business)) };
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/rates',
      summary:
        'Owner adds an approved rate. The price is sent as text (e.g. "1,234.50") and parsed to integer cents by the server.',
      tags: ['rates'],
      auth: 'owner',
      idempotent: true,
      body: z.object({ code: rateCodeSchema, label, unit, price }).strict(),
      responses: {
        201: { description: 'Created', schema: z.object({ rate: managedRate }) },
        403: { description: 'OWNER_REQUIRED', schema: errorResponse },
        409: { description: 'RATE_EXISTS', schema: errorResponse },
        422: { description: 'INVALID_PRICE', schema: errorResponse },
      },
    },
    async ({ user, body, request, idempotent }) =>
      idempotent(async (client) => {
        const rate: RateValues = {
          code: body.code,
          label: body.label,
          unit: body.unit,
          unitPriceCents: cents(body.price),
        };
        const exists = await client.query(
          'SELECT 1 FROM approved_rates WHERE tenant_id=$1 AND code=$2',
          [user.tenantId, rate.code],
        );
        if (exists.rowCount)
          throw new HttpError(
            409,
            'RATE_EXISTS',
            `A rate with code "${rate.code}" already exists. Edit it, or reactivate it if retired.`,
          );
        const id = await insertApprovedRate(client, user.tenantId, rate, user.id);
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'rate.created',
          entityType: 'approved_rate',
          entityId: id,
          requestId: request.id,
          metadata: { code: rate.code, unit: rate.unit, unitPriceCents: rate.unitPriceCents },
        });
        return {
          status: 201,
          body: { rate: dto(await lockRate(client, user.tenantId, rate.code)) },
        };
      }),
  );

  api.route(
    {
      method: 'PATCH',
      url: '/api/rates/:code',
      summary:
        'Owner edits a rate’s label, unit or price. Each change is a new version in the rate history; existing quote and invoice lines keep the price they were issued with.',
      tags: ['rates'],
      auth: 'owner',
      idempotent: true,
      params: codeParams,
      body: z
        .object({ label: label.optional(), unit: unit.optional(), price: price.optional() })
        .strict()
        .refine((b) => Object.keys(b).length > 0, 'Send at least one field to change.'),
      responses: {
        200: { description: 'Updated', schema: z.object({ rate: managedRate }) },
        403: { description: 'OWNER_REQUIRED', schema: errorResponse },
        404: { description: 'NOT_FOUND', schema: errorResponse },
        422: { description: 'INVALID_PRICE', schema: errorResponse },
      },
    },
    async ({ user, body, params, request, idempotent }) =>
      idempotent(async (client) => {
        const current = await lockRate(client, user.tenantId, params.code);
        const next: RateValues = {
          code: current.code,
          label: body.label ?? current.label,
          unit: body.unit ?? current.unit,
          unitPriceCents: body.price !== undefined ? cents(body.price) : current.unitPriceCents,
        };
        const fields = (['label', 'unit', 'unitPriceCents'] as const).filter(
          (field) => next[field] !== current[field],
        );
        if (fields.length) {
          await writeUpdate(client, user, current, next, 'updated');
          await recordAudit(client, {
            tenantId: user.tenantId,
            actorType: 'user',
            actorId: user.id,
            action: 'rate.updated',
            entityType: 'approved_rate',
            entityId: current.id,
            requestId: request.id,
            metadata: {
              code: current.code,
              fields,
              previousUnitPriceCents: current.unitPriceCents,
              unitPriceCents: next.unitPriceCents,
            },
          });
        }
        return { body: { rate: dto(await lockRate(client, user.tenantId, params.code)) } };
      }),
  );

  for (const action of ['retire', 'reactivate'] as const) {
    api.route(
      {
        method: 'POST',
        url: `/api/rates/:code/${action}`,
        summary:
          action === 'retire'
            ? 'Owner retires a rate: it can no longer be used on new quote lines or agent proposals. Existing quotes and invoices are unaffected.'
            : 'Owner reactivates a retired rate at its last approved price.',
        tags: ['rates'],
        auth: 'owner',
        idempotent: true,
        params: codeParams,
        responses: {
          200: { description: 'Rate', schema: z.object({ rate: managedRate }) },
          403: { description: 'OWNER_REQUIRED', schema: errorResponse },
          404: { description: 'NOT_FOUND', schema: errorResponse },
        },
      },
      async ({ user, params, request, idempotent }) =>
        idempotent(async (client) => {
          const current = await lockRate(client, user.tenantId, params.code);
          const active = action === 'reactivate';
          if (current.active !== active) {
            await client.query(
              `UPDATE approved_rates SET active=$3,retired_at=CASE WHEN $3 THEN NULL ELSE now() END,updated_at=now()
               WHERE tenant_id=$1 AND id=$2`,
              [user.tenantId, current.id, active],
            );
            await recordRateVersion(client, {
              tenantId: user.tenantId,
              rateId: current.id,
              change: active ? 'reactivated' : 'retired',
              rate: current,
              active,
              changedBy: user.id,
            });
            await recordAudit(client, {
              tenantId: user.tenantId,
              actorType: 'user',
              actorId: user.id,
              action: active ? 'rate.reactivated' : 'rate.retired',
              entityType: 'approved_rate',
              entityId: current.id,
              requestId: request.id,
              metadata: { code: current.code },
            });
          }
          return { body: { rate: dto(await lockRate(client, user.tenantId, params.code)) } };
        }),
    );
  }

  api.route(
    {
      method: 'GET',
      url: '/api/rates/:code/history',
      summary: 'Every approved version of a rate, newest first.',
      tags: ['rates'],
      auth: 'user',
      params: codeParams,
      responses: {
        200: {
          description: 'History',
          schema: z.object({ code: z.string(), versions: z.array(rateVersion) }),
        },
        404: { description: 'NOT_FOUND', schema: errorResponse },
      },
    },
    async ({ user, params }) => {
      const rate = await api.pool.query<{ id: string }>(
        'SELECT id FROM approved_rates WHERE tenant_id=$1 AND code=$2',
        [user.tenantId, params.code],
      );
      if (!rate.rowCount) throw NOT_FOUND();
      const versions = await api.pool.query<{ effectiveFrom: Date }>(
        `SELECT h.change,h.label,h.unit,h.unit_price_cents::int AS "unitPriceCents",h.active,
           u.display_name AS "changedBy",h.effective_from AS "effectiveFrom"
         FROM approved_rate_history h LEFT JOIN users u ON u.tenant_id=h.tenant_id AND u.id=h.changed_by
         WHERE h.tenant_id=$1 AND h.rate_id=$2 ORDER BY h.effective_from DESC, h.created_at DESC`,
        [user.tenantId, rate.rows[0]!.id],
      );
      return {
        body: {
          code: params.code,
          versions: versions.rows.map((row) => ({ ...row, effectiveFrom: iso(row.effectiveFrom) })),
        },
      };
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/rates/import',
      summary:
        'Owner imports a rate-card CSV (same validator as provisioning). mode=preview returns the diff without writing; mode=apply creates and updates rates in one transaction. Rates missing from the file are listed, never retired.',
      tags: ['rates'],
      auth: 'owner',
      idempotent: true,
      bodyLimit: 512 * 1024,
      body: z
        .object({ csv: z.string().min(1).max(400_000), mode: z.enum(['preview', 'apply']) })
        .strict(),
      responses: {
        200: { description: 'Diff (and whether it was applied)', schema: importDiff },
        403: { description: 'OWNER_REQUIRED', schema: errorResponse },
        422: { description: 'INVALID_RATE_CARD (errors listed)', schema: errorResponse },
      },
    },
    async ({ user, body, request, idempotent }) =>
      idempotent(async (client) => {
        const business = await loadBusiness(client, user.tenantId);
        const parsed = parseRateCardCsv(body.csv, {
          ...(business.gstRegistered ? { pricesEntered: business.pricesEntered } : {}),
        });
        if (parsed.errors.length)
          throw new HttpError(
            422,
            'INVALID_RATE_CARD',
            `${parsed.errors.length} problem(s) in the file. Nothing was changed.`,
            { errors: parsed.errors },
          );
        await client.query('SELECT 1 FROM approved_rates WHERE tenant_id=$1 FOR UPDATE', [
          user.tenantId,
        ]);
        const current = await listRates(client, user.tenantId, true);
        const diff = diffRateCard(current, parsed.rates);
        const apply = body.mode === 'apply';
        if (apply && (diff.create.length || diff.update.length)) {
          const byCode = new Map(current.map((rate) => [rate.code, rate]));
          for (const rate of diff.create)
            await insertApprovedRate(client, user.tenantId, rate, user.id, 'imported');
          for (const change of diff.update)
            await writeUpdate(client, user, byCode.get(change.code)!, change.after, 'imported');
          await recordAudit(client, {
            tenantId: user.tenantId,
            actorType: 'user',
            actorId: user.id,
            action: 'rate_card.imported',
            entityType: 'business',
            entityId: user.tenantId,
            requestId: request.id,
            metadata: {
              created: diff.create.map((rate) => rate.code),
              updated: diff.update.map((change) => change.code),
              notInFile: diff.notInFile.length,
            },
          });
        }
        return {
          body: {
            mode: body.mode,
            priceColumn: parsed.priceColumn,
            errors: [],
            ...diff,
            applied: apply && (diff.create.length > 0 || diff.update.length > 0),
          },
        };
      }),
  );
}
