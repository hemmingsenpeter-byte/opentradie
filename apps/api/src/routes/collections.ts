import {
  collectionsPolicyErrors,
  decideCollectionStage,
  type CollectionsPolicy,
} from '@opentradie/core';
import { recordAudit, recordJobEvent } from '@opentradie/database';
import type { PostgresJobQueue } from '@opentradie/platform';
import { z } from 'zod';
import { HttpError, type RouteRegistry } from '../http.js';
import { errorResponse, idParams } from '../schemas.js';
import {
  followUpHistory,
  loadCollectionsPolicy,
  saveCollectionsPolicy,
  scheduleCollectionsScan,
} from '../services/collections.js';

const days = z.number().int().min(1).max(365);
export const collectionsSettingsBody = z
  .object({
    enabled: z.boolean().optional(),
    preDueCourtesyEnabled: z.boolean().optional(),
    preDueDays: days.optional(),
    overdue1Days: days.optional(),
    overdue2Days: days.optional(),
    overdueFinalDays: days.optional(),
    escalateDays: days.optional(),
    autoSend: z
      .object({
        pre_due_courtesy: z.boolean().optional(),
        overdue_1: z.boolean().optional(),
        overdue_2: z.boolean().optional(),
        overdue_final: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const holdBody = z
  .object({ hold: z.boolean(), reason: z.string().trim().max(300).optional() })
  .strict();

const publicPolicy = (policy: CollectionsPolicy) => ({
  enabled: policy.enabled,
  preDueCourtesyEnabled: policy.preDueCourtesyEnabled,
  preDueDays: policy.preDueDays,
  overdue1Days: policy.overdue1Days,
  overdue2Days: policy.overdue2Days,
  overdueFinalDays: policy.overdueFinalDays,
  escalateDays: policy.escalateDays,
  autoSend: policy.autoSend,
});

export function registerCollectionsRoutes(
  api: RouteRegistry,
  deps: { queue: PostgresJobQueue; now?: () => Date },
) {
  const { queue } = deps;

  api.route(
    {
      method: 'GET',
      url: '/api/settings/collections',
      summary: 'Payment follow-up policy: off by default; every stage needs approval by default',
      tags: ['invoices'],
      auth: 'owner',
      responses: { 200: { description: 'Policy' } },
    },
    async ({ user }) => ({
      body: publicPolicy(await loadCollectionsPolicy(api.pool, user.tenantId)),
    }),
  );

  api.route(
    {
      method: 'PATCH',
      url: '/api/settings/collections',
      summary: 'Update the payment follow-up policy (owner, audited)',
      tags: ['invoices'],
      auth: 'owner',
      idempotent: true,
      body: collectionsSettingsBody,
      responses: {
        200: { description: 'Updated policy' },
        422: { description: 'INVALID_FOLLOW_UP_POLICY', schema: errorResponse },
      },
    },
    async ({ user, body, request, idempotent }) =>
      idempotent(async (client) => {
        const current = await loadCollectionsPolicy(client, user.tenantId);
        const { autoSend, ...rest } = body;
        const next: CollectionsPolicy = {
          ...publicPolicy(current),
          ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
          autoSend: {
            ...current.autoSend,
            ...Object.fromEntries(
              Object.entries(autoSend ?? {}).filter(([, v]) => v !== undefined),
            ),
          },
        };
        const errors = collectionsPolicyErrors(next);
        if (errors.length)
          throw new HttpError(422, 'INVALID_FOLLOW_UP_POLICY', errors.join(' '), { errors });
        await saveCollectionsPolicy(client, user.tenantId, user.id, next);
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'collections.settings_updated',
          entityType: 'business',
          entityId: user.tenantId,
          requestId: request.id,
          metadata: {
            fields: Object.keys(body),
            enabled: next.enabled,
            autoSendStages: Object.entries(next.autoSend)
              .filter(([, on]) => on)
              .map(([stage]) => stage),
          },
        });
        if (next.enabled && !current.enabled)
          await scheduleCollectionsScan(queue, client, user.tenantId, new Date());
        return { body: publicPolicy(next) };
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/collections/scan',
      summary: 'Queue a payment follow-up scan now (it also runs hourly while enabled)',
      tags: ['invoices'],
      auth: 'owner',
      idempotent: true,
      responses: { 202: { description: 'Queued' } },
    },
    async ({ user, request, idempotent }) =>
      idempotent(async (client) => {
        await scheduleCollectionsScan(
          queue,
          client,
          user.tenantId,
          new Date(),
          `collections:manual:${request.id}`,
        );
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'collections.scan_requested',
          entityType: 'business',
          entityId: user.tenantId,
          requestId: request.id,
        });
        return { status: 202, body: { queued: true } };
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/invoices/:id/collections-hold',
      summary: 'Put an invoice on (or take it off) follow-up hold, e.g. while disputed',
      tags: ['invoices'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: holdBody,
      responses: { 200: { description: 'Hold updated' }, 404: { description: 'NOT_FOUND' } },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const updated = await client.query<{ jobId: string; invoiceNumber: string }>(
          `UPDATE invoices SET collections_hold=$3,collections_hold_reason=$4,
             collections_hold_at=CASE WHEN $3 THEN now() ELSE NULL END,updated_at=now()
           WHERE tenant_id=$1 AND id=$2 RETURNING job_id AS "jobId",invoice_number AS "invoiceNumber"`,
          [user.tenantId, params.id, body.hold, body.hold ? (body.reason ?? null) : null],
        );
        const invoice = updated.rows[0];
        if (!invoice) throw new HttpError(404, 'NOT_FOUND', 'Invoice not found.');
        await recordJobEvent(client, {
          tenantId: user.tenantId,
          jobId: invoice.jobId,
          type: 'invoice_collections_hold',
          actorType: 'user',
          actorId: user.id,
          summary: body.hold
            ? `Payment follow-ups paused for invoice ${invoice.invoiceNumber}`
            : `Payment follow-ups resumed for invoice ${invoice.invoiceNumber}`,
          metadata: { invoiceId: params.id, hold: body.hold },
        });
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: body.hold ? 'invoice.collections_hold_set' : 'invoice.collections_hold_cleared',
          entityType: 'invoice',
          entityId: params.id,
          requestId: request.id,
          metadata: { reasonGiven: Boolean(body.reason) },
        });
        return {
          body: {
            id: params.id,
            hold: body.hold,
            reason: body.hold ? (body.reason ?? null) : null,
          },
        };
      }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/invoices/:id/follow-ups',
      summary: 'Payment follow-up history, hold state and the stage due now',
      tags: ['invoices'],
      auth: 'user',
      params: idParams,
      responses: { 200: { description: 'Follow-ups' }, 404: { description: 'NOT_FOUND' } },
    },
    async ({ user, params }) => {
      const invoice = (
        await api.pool.query<{
          status: string;
          dueDate: string;
          totalCents: string;
          hold: boolean;
          reason: string | null;
          erased: boolean;
          timeZone: string;
          snapshotDue: string | null;
          snapshotStatus: string | null;
        }>(
          `SELECT i.status,to_char(i.due_date,'YYYY-MM-DD') AS "dueDate",i.total_cents AS "totalCents",
             i.collections_hold AS hold,i.collections_hold_reason AS reason,(c.erased_at IS NOT NULL) AS erased,
             b.time_zone AS "timeZone",s.amount_due_cents AS "snapshotDue",s.provider_status AS "snapshotStatus"
           FROM invoices i JOIN customers c ON c.tenant_id=i.tenant_id AND c.id=i.customer_id
             JOIN businesses b ON b.id=i.tenant_id
             LEFT JOIN LATERAL (SELECT amount_due_cents,provider_status FROM payment_snapshots p
               WHERE p.tenant_id=i.tenant_id AND p.invoice_id=i.id ORDER BY fetched_at DESC LIMIT 1) s ON true
           WHERE i.tenant_id=$1 AND i.id=$2`,
          [user.tenantId, params.id],
        )
      ).rows[0];
      if (!invoice) throw new HttpError(404, 'NOT_FOUND', 'Invoice not found.');
      const history = await followUpHistory(api.pool, user.tenantId, params.id);
      const policy = await loadCollectionsPolicy(api.pool, user.tenantId);
      const decision = decideCollectionStage(
        {
          status: invoice.status,
          dueDate: invoice.dueDate,
          totalCents: Number(invoice.totalCents),
          snapshotAmountDueCents: invoice.snapshotDue === null ? null : Number(invoice.snapshotDue),
          snapshotProviderStatus: invoice.snapshotStatus,
          onHold: invoice.hold,
          customerErased: invoice.erased,
          preparedStages: history.map((item) => item.stage),
        },
        policy,
        deps.now?.() ?? new Date(),
        invoice.timeZone,
      );
      return {
        body: {
          enabled: policy.enabled,
          hold: invoice.hold,
          holdReason: invoice.reason,
          next: decision,
          history,
        },
      };
    },
  );
}
