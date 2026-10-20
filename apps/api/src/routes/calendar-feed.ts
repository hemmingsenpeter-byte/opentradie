/**
 * ICS export (ADR 0019 amendment): a private, revocable calendar feed URL per owner and a
 * single-appointment download. Only the SHA-256 of a feed token is stored; the URL is returned
 * once, when created or rotated. Feed events carry the job title and times only.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { serializeIcs, type IcsAppointment } from '@opentradie/core';
import { recordAudit, type Queryable } from '@opentradie/database';
import { z } from 'zod';
import { HttpError, type RouteRegistry } from '../http.js';
import { idParams } from '../schemas.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const feedParams = z.object({ token: z.string().max(200) }).strict();
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const NOT_FOUND = () => new HttpError(404, 'NOT_FOUND', 'Calendar feed not found.');

/** Feed window: recent past and the year ahead; cancelled appointments drop out of the feed. */
const FEED_SQL = `SELECT a.id,j.title,a.starts_at AS "startsAt",a.ends_at AS "endsAt",a.status,a.updated_at AS "updatedAt"
  FROM appointments a JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
  WHERE a.tenant_id=$1 AND a.status<>'cancelled' AND a.ends_at > now() - interval '30 days'
    AND a.starts_at < now() + interval '365 days'
  ORDER BY a.starts_at, a.id LIMIT 2000`;

async function calendarName(client: Queryable, tenantId: string) {
  const row = (
    await client.query<{ name: string }>('SELECT name FROM businesses WHERE id=$1', [tenantId])
  ).rows[0];
  return `${row?.name ?? 'OPENTRADIE'} appointments`;
}

export function registerCalendarFeedRoutes(api: RouteRegistry, deps: { appOrigin: string }) {
  const feedUrl = (token: string) => `${deps.appOrigin}/calendar/feed/${token}.ics`;

  api.route(
    {
      method: 'GET',
      url: '/api/calendar/feed-token',
      summary:
        'Whether a private calendar feed link is active (the URL itself is never shown again)',
      tags: ['scheduling'],
      auth: 'owner',
      responses: { 200: { description: 'Feed link status' } },
    },
    async ({ user }) => {
      const row = (
        await api.pool.query<{ createdAt: Date; lastUsedAt: Date | null }>(
          `SELECT created_at AS "createdAt",last_used_at AS "lastUsedAt" FROM calendar_feed_tokens
           WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL`,
          [user.tenantId, user.id],
        )
      ).rows[0];
      return {
        body: {
          active: Boolean(row),
          createdAt: row?.createdAt.toISOString() ?? null,
          lastUsedAt: row?.lastUsedAt?.toISOString() ?? null,
        },
      };
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/calendar/feed-token',
      summary: 'Create or rotate the private calendar feed link; returns the URL once',
      tags: ['scheduling'],
      auth: 'owner',
      idempotent: true,
      responses: { 201: { description: 'Feed URL (shown once)' } },
    },
    async ({ user, request, idempotent }) =>
      idempotent(async (client) => {
        const revoked = await client.query(
          `UPDATE calendar_feed_tokens SET revoked_at=now()
           WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL`,
          [user.tenantId, user.id],
        );
        const token = randomBytes(32).toString('base64url');
        const createdAt = new Date();
        await client.query(
          'INSERT INTO calendar_feed_tokens(id,tenant_id,user_id,token_hash,created_at) VALUES($1,$2,$3,$4,$5)',
          [randomUUID(), user.tenantId, user.id, sha256(token), createdAt],
        );
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: revoked.rowCount ? 'calendar.feed_rotated' : 'calendar.feed_created',
          entityType: 'user',
          entityId: user.id,
          requestId: request.id,
        });
        return {
          status: 201,
          body: { url: feedUrl(token), createdAt: createdAt.toISOString() },
        };
      }),
  );

  api.route(
    {
      method: 'DELETE',
      url: '/api/calendar/feed-token',
      summary: 'Revoke the private calendar feed link; subscribed calendars stop updating',
      tags: ['scheduling'],
      auth: 'owner',
      idempotent: true,
      responses: { 200: { description: 'Revoked' } },
    },
    async ({ user, request, idempotent }) =>
      idempotent(async (client) => {
        const revoked = await client.query(
          `UPDATE calendar_feed_tokens SET revoked_at=now()
           WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL`,
          [user.tenantId, user.id],
        );
        if (revoked.rowCount)
          await recordAudit(client, {
            tenantId: user.tenantId,
            actorType: 'user',
            actorId: user.id,
            action: 'calendar.feed_revoked',
            entityType: 'user',
            entityId: user.id,
            requestId: request.id,
          });
        return { body: { revoked: Boolean(revoked.rowCount) } };
      }),
  );

  api.route(
    {
      method: 'GET',
      url: '/calendar/feed/:token.ics',
      summary:
        'Private ICS feed by its secret link (no sign-in; for calendar apps). 404 when unknown or revoked.',
      tags: ['public'],
      auth: 'public',
      params: feedParams,
      rateLimit: { max: 30, timeWindow: '1 minute' },
      responses: { 200: { description: 'text/calendar' }, 404: { description: 'NOT_FOUND' } },
    },
    async ({ params, reply }) => {
      if (!TOKEN.test(params.token)) throw NOT_FOUND();
      const hash = sha256(params.token);
      const row = (
        await api.pool.query<{ id: string; tenantId: string; tokenHash: string }>(
          `SELECT id,tenant_id AS "tenantId",token_hash AS "tokenHash" FROM calendar_feed_tokens
           WHERE token_hash=$1 AND revoked_at IS NULL`,
          [hash],
        )
      ).rows[0];
      if (!row || !timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(hash)))
        throw NOT_FOUND();
      await api.pool.query(
        'UPDATE calendar_feed_tokens SET last_used_at=now() WHERE tenant_id=$1 AND id=$2',
        [row.tenantId, row.id],
      );
      const appointments = await api.pool.query<IcsAppointment>(FEED_SQL, [row.tenantId]);
      reply
        .header('content-type', 'text/calendar; charset=utf-8')
        .header('cache-control', 'private, no-store')
        .header('x-robots-tag', 'noindex');
      return {
        body: serializeIcs(appointments.rows, {
          calendarName: await calendarName(api.pool, row.tenantId),
          now: new Date(),
        }),
      };
    },
  );

  api.route(
    {
      method: 'GET',
      url: '/api/appointments/:id.ics',
      summary: 'Download one appointment as an .ics file (job title and times only)',
      tags: ['scheduling'],
      auth: 'user',
      params: idParams,
      responses: { 200: { description: 'text/calendar' }, 404: { description: 'NOT_FOUND' } },
    },
    async ({ user, params, reply }) => {
      const row = (
        await api.pool.query<IcsAppointment>(
          `SELECT a.id,j.title,a.starts_at AS "startsAt",a.ends_at AS "endsAt",a.status,a.updated_at AS "updatedAt"
           FROM appointments a JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
           WHERE a.tenant_id=$1 AND a.id=$2`,
          [user.tenantId, params.id],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, 'NOT_FOUND', 'Appointment not found.');
      reply
        .header('content-type', 'text/calendar; charset=utf-8')
        .header('content-disposition', `attachment; filename="appointment-${row.id}.ics"`)
        .header('cache-control', 'private, no-store');
      return {
        body: serializeIcs([row], {
          calendarName: await calendarName(api.pool, user.tenantId),
          now: new Date(),
        }),
      };
    },
  );
}
