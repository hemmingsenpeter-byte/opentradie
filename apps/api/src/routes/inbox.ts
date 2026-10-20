import { createHash, randomUUID } from 'node:crypto';
import { customerNameFromSender, draftWarnings, normaliseEmailAddress } from '@opentradie/core';
import { recordAudit, transaction, type Transaction } from '@opentradie/database';
import {
  isIntegrationError,
  parseRawEmail,
  type InboundEmail,
} from '@opentradie/integrations/mail';
import { RELAY_SIGNATURE_HEADER, verifyRelaySignature } from '@opentradie/platform';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, iso, type RouteRegistry, type UserContext } from '../http.js';
import { errorResponse, idParams } from '../schemas.js';
import { createCustomerRecord, createEnquiryJob } from '../services/intake.js';
import {
  DuplicateDeliveryError,
  ingestEmail,
  triageCommunication,
  type InboxDependencies,
  type IngestResult,
} from '../services/inbox.js';

export const INBOUND_EMAIL_SIGNATURE_HEADER = RELAY_SIGNATURE_HEADER;
const INBOUND_BODY_LIMIT = 21 * 1024 * 1024;
const PASTE_BODY_LIMIT = 1024 * 1024;

const webhookParams = z
  .object({ provider: z.enum(['gmail', 'microsoft_graph', 'generic_mime']) })
  .strict();
const webhookBody = z
  .object({
    version: z.literal(1),
    eventId: z.string().regex(/^[A-Za-z0-9._:@<>+=-]{1,200}$/),
    rawMimeBase64: z.string().min(1).max(INBOUND_BODY_LIMIT),
    providerMessageId: z
      .string()
      .regex(/^[A-Za-z0-9_=+/-]{1,512}$/)
      .optional(),
    providerThreadId: z
      .string()
      .regex(/^[A-Za-z0-9_=+/-]{1,512}$/)
      .optional(),
  })
  .strict();

const pasteBody = z.union([
  z
    .object({
      from: z.string().trim().email().max(254),
      fromName: z.string().trim().min(1).max(200).optional(),
      subject: z.string().trim().max(300).default(''),
      text: z.string().trim().min(1).max(50_000),
    })
    .strict(),
  z
    .object({
      rawMime: z
        .string()
        .min(1)
        .max(PASTE_BODY_LIMIT - 1024),
    })
    .strict(),
]);

const threadListQuery = z
  .object({ filter: z.enum(['all', 'needs_review', 'unread', 'open']).default('all') })
  .strict();
const draftUpdateBody = z
  .object({
    text: z.string().trim().min(1).max(20_000),
    subject: z.string().trim().min(1).max(300).optional(),
  })
  .strict();
const approveSendBody = z
  .object({
    text: z.string().trim().min(1).max(20_000).optional(),
    subject: z.string().trim().min(1).max(300).optional(),
  })
  .strict();
const linkBody = z
  .object({
    customerId: z.string().uuid().nullable().optional(),
    jobId: z.string().uuid().nullable().optional(),
  })
  .strict();
const createJobBody = z.object({ title: z.string().trim().min(1).max(300).optional() }).strict();
const threadUpdateBody = z.object({ status: z.enum(['open', 'closed', 'archived']) }).strict();

const ingestResponse = z.object({
  status: z.enum(['accepted', 'duplicate']),
  communicationId: z.string().uuid(),
  threadId: z.string().uuid(),
  customerId: z.string().uuid().nullable(),
  jobId: z.string().uuid().nullable(),
  createdCustomer: z.boolean(),
  createdJob: z.boolean(),
  needsReview: z.boolean(),
  reviewReason: z.string().nullable(),
  automated: z.boolean(),
  attachmentsStored: z.number().int(),
  attachmentsRejected: z.number().int(),
});

function auditor(client: Transaction, user: UserContext, requestId: string) {
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

const MESSAGE_COLUMNS = `m.id,m.direction,m.channel,m.status,m.origin,m.subject,m.text,m.from_address AS "fromAddress",
  m.from_name AS "fromName",m.to_addresses AS "toAddresses",m.received_at AS "receivedAt",m.read_at AS "readAt",
  m.created_at AS "createdAt",m.approved_at AS "approvedAt",m.sent_at AS "sentAt",m.triage,m.triage_status AS "triageStatus",
  m.send_error_code AS "sendErrorCode",m.send_attempt AS "sendAttempt",m.reply_to_communication_id AS "replyTo",
  m.customer_id AS "customerId",m.job_id AS "jobId",m.thread_id AS "threadId"`;

export async function registerInboxRoutes(
  app: FastifyInstance,
  api: RouteRegistry,
  deps: InboxDependencies,
) {
  const { db, config, queue } = deps;

  async function loadThread(tenantId: string, id: string) {
    const thread = (
      await db.pool.query<Record<string, unknown> & { lastMessageAt: Date; createdAt: Date }>(
        `SELECT t.id,t.channel,t.subject,t.status,t.needs_review AS "needsReview",t.review_reason AS "reviewReason",
           t.customer_id AS "customerId",c.name AS "customerName",t.job_id AS "jobId",j.title AS "jobTitle",
           j.status AS "jobStatus",t.last_message_at AS "lastMessageAt",t.created_at AS "createdAt"
         FROM communication_threads t
         LEFT JOIN customers c ON c.tenant_id=t.tenant_id AND c.id=t.customer_id
         LEFT JOIN jobs j ON j.tenant_id=t.tenant_id AND j.id=t.job_id
         WHERE t.tenant_id=$1 AND t.id=$2`,
        [tenantId, id],
      )
    ).rows[0];
    if (!thread) throw new HttpError(404, 'THREAD_NOT_FOUND', 'Conversation not found.');
    return thread;
  }

  // ---------- signed inbound webhook ----------
  if (config.inboundEmailSecret) {
    const secret = config.inboundEmailSecret;
    await app.register(async (scope) => {
      scope.addContentTypeParser(
        'application/json',
        { parseAs: 'string', bodyLimit: INBOUND_BODY_LIMIT },
        (_request, body, done) => done(null, body),
      );
      api.scoped(scope).route(
        {
          method: 'POST',
          url: '/inbound/email/:provider',
          summary:
            'Signed inbound email (HMAC-SHA256 over "timestamp.body", 5 minute window). The body carries the raw RFC 5322 message; duplicates by event id or Message-ID are acknowledged once.',
          tags: ['inbox'],
          auth: 'public',
          params: webhookParams,
          bodyLimit: INBOUND_BODY_LIMIT,
          rateLimit: { max: 120, timeWindow: '1 minute' },
          responses: {
            200: { description: 'Duplicate delivery acknowledged; nothing processed again' },
            202: { description: 'Accepted and ingested', schema: ingestResponse },
            401: {
              description: 'INVALID_SIGNATURE: bad or expired signature',
              schema: errorResponse,
            },
            409: {
              description: 'EVENT_CONFLICT: same event id, different content',
              schema: errorResponse,
            },
            422: { description: 'MALFORMED_MESSAGE', schema: errorResponse },
          },
        },
        async ({ request, params }) => {
          const raw = typeof request.body === 'string' ? request.body : '';
          if (
            !verifyRelaySignature(
              raw,
              request.headers[INBOUND_EMAIL_SIGNATURE_HEADER] as string | undefined,
              secret,
            )
          )
            throw new HttpError(401, 'INVALID_SIGNATURE', 'Signature invalid or expired.');
          let json: unknown;
          try {
            json = JSON.parse(raw);
          } catch {
            throw new HttpError(400, 'VALIDATION_ERROR', 'The body is not JSON.');
          }
          const body = webhookBody.parse(json);
          const tenantId = config.tenantId;
          const payloadSha256 = createHash('sha256').update(raw).digest('hex');
          const existing = await db.pool.query<{ sha: string; communicationId: string | null }>(
            'SELECT payload_sha256 AS sha,communication_id AS "communicationId" FROM webhook_receipts WHERE tenant_id=$1 AND provider=$2 AND external_event_id=$3',
            [tenantId, params.provider, body.eventId],
          );
          if (existing.rows[0]) {
            if (existing.rows[0].sha !== payloadSha256)
              throw new HttpError(
                409,
                'EVENT_CONFLICT',
                'Event id was already delivered with different content.',
              );
            return {
              status: 200,
              body: { status: 'duplicate', communicationId: existing.rows[0].communicationId },
            };
          }
          let email: InboundEmail;
          try {
            email = await parseRawEmail(
              Buffer.from(body.rawMimeBase64, 'base64'),
              params.provider,
              {
                providerMessageId: body.providerMessageId ?? null,
                providerThreadId: body.providerThreadId ?? null,
              },
            );
          } catch (error) {
            if (!isIntegrationError(error)) throw error;
            await db.pool.query(
              `INSERT INTO webhook_receipts(id,tenant_id,provider,external_event_id,signature_verified,payload_sha256,status,error_code)
               VALUES($1,$2,$3,$4,true,$5,'rejected','MALFORMED_MESSAGE') ON CONFLICT DO NOTHING`,
              [randomUUID(), tenantId, params.provider, body.eventId, payloadSha256],
            );
            throw new HttpError(422, 'MALFORMED_MESSAGE', 'The email could not be read.');
          }
          try {
            const result = await transaction(db, async (client) => {
              const receiptId = randomUUID();
              const receipt = await client.query(
                `INSERT INTO webhook_receipts(id,tenant_id,provider,external_event_id,signature_verified,payload_sha256)
                 VALUES($1,$2,$3,$4,true,$5) ON CONFLICT (tenant_id,provider,external_event_id) DO NOTHING RETURNING id`,
                [receiptId, tenantId, params.provider, body.eventId, payloadSha256],
              );
              if (!receipt.rowCount) return null;
              const ingested = await ingestEmail(client, deps, {
                tenantId,
                email,
                provider: params.provider,
                origin: 'webhook',
                actor: { type: 'system', id: null },
                requestId: request.id,
              });
              await client.query(
                "UPDATE webhook_receipts SET status='processed', processed_at=now(), communication_id=$3 WHERE tenant_id=$1 AND id=$2",
                [tenantId, receiptId, ingested.communicationId],
              );
              return ingested;
            });
            if (!result)
              return { status: 200, body: { status: 'duplicate', communicationId: null } };
            return { status: result.status === 'duplicate' ? 200 : 202, body: result };
          } catch (error) {
            if (error instanceof DuplicateDeliveryError)
              return { status: 200, body: { status: 'duplicate', communicationId: null } };
            throw error;
          }
        },
      );
    });
  }

  // ---------- owner paste / forward (demo and manual intake) ----------
  api.route(
    {
      method: 'POST',
      url: '/api/inbox/paste',
      summary:
        'Owner pastes or forwards an email (fields or raw source). It goes through the same ingestion pipeline as the signed webhook; an AI reply is drafted for approval, never sent.',
      tags: ['inbox'],
      auth: 'owner',
      idempotent: true,
      bodyLimit: PASTE_BODY_LIMIT,
      body: pasteBody,
      responses: {
        201: { description: 'Ingested', schema: ingestResponse },
        200: { description: 'Already in the inbox (same Message-ID)', schema: ingestResponse },
        422: { description: 'MALFORMED_MESSAGE', schema: errorResponse },
      },
    },
    async ({ body, user, request, idempotent }) => {
      const result = await idempotent(
        async (client, email: InboundEmail) => {
          const ingested: IngestResult = await ingestEmail(client, deps, {
            tenantId: user.tenantId,
            email,
            provider: 'generic_mime',
            origin: 'manual_paste',
            actor: { type: 'user', id: user.id },
            requestId: request.id,
          });
          return { status: ingested.status === 'duplicate' ? 200 : 201, body: ingested };
        },
        async () => {
          if ('rawMime' in body) {
            try {
              return await parseRawEmail(body.rawMime, 'generic_mime');
            } catch (error) {
              if (isIntegrationError(error))
                throw new HttpError(
                  422,
                  'MALFORMED_MESSAGE',
                  'The email source could not be read.',
                );
              throw error;
            }
          }
          const address = normaliseEmailAddress(body.from);
          if (!address) throw new HttpError(400, 'VALIDATION_ERROR', 'Enter a valid sender email.');
          return {
            messageId: `<paste-${randomUUID()}@opentradie.invalid>`,
            inReplyTo: null,
            references: [],
            subject: body.subject,
            from: { address, name: body.fromName ?? null },
            to: [],
            cc: [],
            replyTo: [],
            date: null,
            text: body.text,
            textFromHtml: false,
            attachments: [],
            automation: { autoSubmitted: null, precedence: null, listId: null },
            providerMessageId: null,
            providerThreadId: null,
          } satisfies InboundEmail;
        },
      );
      // Prepare the draft now for the demo; the queued task does the same work if this fails.
      const ingested = result.body as IngestResult;
      if (ingested.status === 'accepted' && !ingested.automated)
        await triageCommunication(deps, user.tenantId, ingested.communicationId, request.id).catch(
          () => undefined,
        );
      return result;
    },
  );

  // ---------- reading ----------
  api.route(
    {
      method: 'GET',
      url: '/api/inbox/threads',
      summary: 'Conversations, newest first, with customer/job links, unread and review flags',
      tags: ['inbox'],
      auth: 'user',
      query: threadListQuery,
      responses: { 200: { description: 'Threads' } },
    },
    async ({ user, query }) => {
      const where = {
        all: "t.status <> 'archived'",
        open: "t.status = 'open'",
        needs_review: "t.needs_review AND t.status <> 'archived'",
        unread: "t.status <> 'archived' AND unread.count > 0",
      }[query.filter];
      const rows = await db.pool.query<Record<string, unknown> & { lastMessageAt: Date }>(
        `SELECT t.id,t.channel,t.subject,t.status,t.needs_review AS "needsReview",t.review_reason AS "reviewReason",
           t.customer_id AS "customerId",c.name AS "customerName",t.job_id AS "jobId",j.title AS "jobTitle",
           t.last_message_at AS "lastMessageAt",unread.count::int AS "unreadCount",drafts.count::int AS "pendingDrafts",
           latest.direction AS "latestDirection",latest.from_name AS "latestFromName",
           latest.from_address AS "latestFromAddress",latest.snippet AS "snippet",latest.classification
         FROM communication_threads t
         LEFT JOIN customers c ON c.tenant_id=t.tenant_id AND c.id=t.customer_id
         LEFT JOIN jobs j ON j.tenant_id=t.tenant_id AND j.id=t.job_id
         CROSS JOIN LATERAL (SELECT count(*) FROM communications m WHERE m.tenant_id=t.tenant_id AND m.thread_id=t.id
           AND m.direction='inbound' AND m.read_at IS NULL) unread
         CROSS JOIN LATERAL (SELECT count(*) FROM communications m WHERE m.tenant_id=t.tenant_id AND m.thread_id=t.id
           AND m.direction='outbound' AND m.status IN ('draft','failed')) drafts
         LEFT JOIN LATERAL (SELECT m.direction,m.from_name,m.from_address,left(m.text,160) AS snippet,
             m.triage->>'classification' AS classification
           FROM communications m WHERE m.tenant_id=t.tenant_id AND m.thread_id=t.id AND m.status <> 'discarded'
           ORDER BY m.created_at DESC LIMIT 1) latest ON true
         WHERE t.tenant_id=$1 AND ${where}
         ORDER BY t.last_message_at DESC LIMIT 100`,
        [user.tenantId],
      );
      return {
        body: {
          threads: rows.rows.map((row) => ({ ...row, lastMessageAt: iso(row.lastMessageAt) })),
        },
      };
    },
  );

  api.route(
    {
      method: 'GET',
      url: '/api/inbox/threads/:id',
      summary: 'One conversation: messages, AI triage, drafts, attachments and review candidates',
      tags: ['inbox'],
      auth: 'user',
      params: idParams,
      responses: {
        200: { description: 'Thread' },
        404: { description: 'Not found (including other tenants)', schema: errorResponse },
      },
    },
    async ({ user, params }) => {
      const thread = await loadThread(user.tenantId, params.id);
      const messages = await db.pool.query<
        Record<string, unknown> & {
          id: string;
          receivedAt: Date | null;
          readAt: Date | null;
          createdAt: Date;
          approvedAt: Date | null;
          sentAt: Date | null;
        }
      >(
        `SELECT ${MESSAGE_COLUMNS} FROM communications m
         WHERE m.tenant_id=$1 AND m.thread_id=$2 AND m.status <> 'discarded' ORDER BY m.created_at, m.id`,
        [user.tenantId, params.id],
      );
      const attachments = await db.pool.query<{
        id: string;
        communicationId: string;
        fileName: string;
        mediaType: string;
        sizeBytes: string;
      }>(
        `SELECT d.id,d.communication_id AS "communicationId",d.file_name AS "fileName",d.media_type AS "mediaType",
           d.size_bytes AS "sizeBytes"
         FROM documents d WHERE d.tenant_id=$1 AND d.communication_id = ANY($2::uuid[]) ORDER BY d.created_at`,
        [user.tenantId, messages.rows.map((row) => row.id)],
      );
      return {
        body: {
          thread: {
            ...thread,
            lastMessageAt: iso(thread.lastMessageAt),
            createdAt: iso(thread.createdAt),
          },
          messages: messages.rows.map((row) => ({
            ...row,
            receivedAt: iso(row.receivedAt),
            readAt: iso(row.readAt),
            createdAt: iso(row.createdAt),
            approvedAt: iso(row.approvedAt),
            sentAt: iso(row.sentAt),
            attachments: attachments.rows
              .filter((item) => item.communicationId === row.id)
              .map(({ communicationId: _ignored, sizeBytes, ...item }) => ({
                ...item,
                sizeBytes: Number(sizeBytes),
              })),
          })),
        },
      };
    },
  );

  // ---------- thread actions ----------
  api.route(
    {
      method: 'POST',
      url: '/api/inbox/threads/:id/read',
      summary: 'Mark every inbound message in a conversation as read',
      tags: ['inbox'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      responses: { 200: { description: 'Marked read' } },
    },
    async ({ user, params, idempotent }) =>
      idempotent(async (client) => {
        await loadThread(user.tenantId, params.id);
        const updated = await client.query(
          "UPDATE communications SET read_at=now() WHERE tenant_id=$1 AND thread_id=$2 AND direction='inbound' AND read_at IS NULL",
          [user.tenantId, params.id],
        );
        return { body: { id: params.id, marked: updated.rowCount ?? 0 } };
      }),
  );

  api.route(
    {
      method: 'PATCH',
      url: '/api/inbox/threads/:id',
      summary: 'Open, close or archive a conversation',
      tags: ['inbox'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: threadUpdateBody,
      responses: { 200: { description: 'Updated' } },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        await loadThread(user.tenantId, params.id);
        await client.query(
          'UPDATE communication_threads SET status=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2',
          [user.tenantId, params.id, body.status],
        );
        await auditor(client, user, request.id)(
          'inbox.thread_updated',
          'communication_thread',
          params.id,
          {
            status: body.status,
          },
        );
        return { body: { id: params.id, status: body.status } };
      }),
  );

  async function linkThread(
    client: Transaction,
    tenantId: string,
    threadId: string,
    customerId: string | null,
    jobId: string | null,
  ) {
    await client.query(
      `UPDATE communication_threads SET customer_id=$3, job_id=$4, needs_review=false, review_reason=NULL, updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, threadId, customerId, jobId],
    );
    await client.query(
      'UPDATE communications SET customer_id=$3, job_id=$4, updated_at=now() WHERE tenant_id=$1 AND thread_id=$2',
      [tenantId, threadId, customerId, jobId],
    );
    await client.query(
      `UPDATE knowledge_items k SET customer_id=$3, job_id=$4 FROM communications m
       WHERE k.tenant_id=$1 AND k.source_type='communication' AND k.source_id=m.id AND m.tenant_id=$1 AND m.thread_id=$2`,
      [tenantId, threadId, customerId, jobId],
    );
    await client.query(
      'UPDATE documents d SET customer_id=$3, job_id=$4 FROM communications m WHERE d.tenant_id=$1 AND d.communication_id=m.id AND m.tenant_id=$1 AND m.thread_id=$2',
      [tenantId, threadId, customerId, jobId],
    );
  }

  api.route(
    {
      method: 'POST',
      url: '/api/inbox/threads/:id/link',
      summary:
        'Owner links a conversation to a customer and optionally one of their jobs; clears the review flag',
      tags: ['inbox'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: linkBody,
      responses: {
        200: { description: 'Linked' },
        404: { description: 'Thread, customer or job not found', schema: errorResponse },
        422: { description: 'JOB_CUSTOMER_MISMATCH', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        await loadThread(user.tenantId, params.id);
        let customerId = body.customerId ?? null;
        const jobId = body.jobId ?? null;
        if (jobId) {
          const job = await client.query<{ customerId: string }>(
            'SELECT customer_id AS "customerId" FROM jobs WHERE tenant_id=$1 AND id=$2',
            [user.tenantId, jobId],
          );
          if (!job.rows[0]) throw new HttpError(404, 'JOB_NOT_FOUND', 'Job not found.');
          if (customerId && customerId !== job.rows[0].customerId)
            throw new HttpError(
              422,
              'JOB_CUSTOMER_MISMATCH',
              'That job belongs to another customer.',
            );
          customerId = job.rows[0].customerId;
        }
        if (customerId) {
          const found = await client.query(
            'SELECT 1 FROM customers WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',
            [user.tenantId, customerId],
          );
          if (!found.rowCount)
            throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
        }
        await linkThread(client, user.tenantId, params.id, customerId, jobId);
        await auditor(client, user, request.id)(
          'inbox.thread_linked',
          'communication_thread',
          params.id,
          {
            customerId,
            jobId,
          },
        );
        return { body: { id: params.id, customerId, jobId } };
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/inbox/threads/:id/create-job',
      summary:
        'Create a job from a conversation (and the customer from the sender if none is linked)',
      tags: ['inbox'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: createJobBody,
      responses: {
        201: { description: 'Job created and linked' },
        409: { description: 'THREAD_HAS_JOB', schema: errorResponse },
        422: {
          description: 'NO_SENDER: no sender address to create a customer from',
          schema: errorResponse,
        },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const thread = await loadThread(user.tenantId, params.id);
        if (thread.jobId)
          throw new HttpError(
            409,
            'THREAD_HAS_JOB',
            'This conversation is already linked to a job.',
          );
        const audit = auditor(client, user, request.id);
        let customerId = thread.customerId as string | null;
        let createdCustomer = false;
        if (!customerId) {
          const sender = (
            await client.query<{ fromAddress: string | null; fromName: string | null }>(
              `SELECT from_address AS "fromAddress",from_name AS "fromName" FROM communications
               WHERE tenant_id=$1 AND thread_id=$2 AND direction='inbound' AND from_address IS NOT NULL
               ORDER BY created_at LIMIT 1`,
              [user.tenantId, params.id],
            )
          ).rows[0];
          if (!sender?.fromAddress)
            throw new HttpError(
              422,
              'NO_SENDER',
              'There is no sender address to create a customer from.',
            );
          customerId = await createCustomerRecord(client, {
            tenantId: user.tenantId,
            name: customerNameFromSender(sender.fromName, sender.fromAddress),
            email: sender.fromAddress,
          });
          createdCustomer = true;
          await audit('customer.created', 'customer', customerId, { source: 'email' });
        }
        const jobId = await createEnquiryJob(client, {
          tenantId: user.tenantId,
          customerId,
          title: body.title ?? ((thread.subject as string | null) || 'Email enquiry'),
          description: `Created from conversation ${params.id}. Review scope before quoting.`,
          status: 'new',
          origin: 'email',
          actor: { type: 'user', id: user.id },
          eventSummary: 'Job created from an email conversation',
          eventMetadata: { threadId: params.id },
        });
        await linkThread(client, user.tenantId, params.id, customerId, jobId);
        await audit('job.created', 'job', jobId, {
          customerId,
          origin: 'email',
          threadId: params.id,
        });
        return { status: 201, body: { id: params.id, customerId, jobId, createdCustomer } };
      }),
  );

  // ---------- drafts: edit, discard, approve and send ----------
  async function lockOutbound(client: Transaction, tenantId: string, id: string) {
    const row = (
      await client.query<{
        id: string;
        status: string;
        channel: string;
        text: string;
        subject: string | null;
        toAddresses: string[];
        customerEmail: string | null;
        sendAttempt: number;
      }>(
        `SELECT m.id,m.status,m.channel,m.text,m.subject,m.to_addresses AS "toAddresses",c.email AS "customerEmail",
           m.send_attempt AS "sendAttempt"
         FROM communications m LEFT JOIN customers c ON c.tenant_id=m.tenant_id AND c.id=m.customer_id
         WHERE m.tenant_id=$1 AND m.id=$2 AND m.direction='outbound' FOR UPDATE OF m`,
        [tenantId, id],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, 'COMMUNICATION_NOT_FOUND', 'Message not found.');
    return row;
  }

  api.route(
    {
      method: 'PATCH',
      url: '/api/communications/:id',
      summary: 'Edit a draft reply (draft or failed messages only)',
      tags: ['inbox'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: draftUpdateBody,
      responses: {
        200: { description: 'Draft updated' },
        409: { description: 'NOT_A_DRAFT', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const row = await lockOutbound(client, user.tenantId, params.id);
        if (!['draft', 'failed'].includes(row.status))
          throw new HttpError(409, 'NOT_A_DRAFT', 'Only drafts can be edited.');
        await client.query(
          "UPDATE communications SET text=$3, subject=coalesce($4,subject), status='draft', updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [user.tenantId, params.id, body.text, body.subject ?? null],
        );
        await auditor(client, user, request.id)(
          'communication.draft_edited',
          'communication',
          params.id,
        );
        return { body: { id: params.id, status: 'draft', warnings: draftWarnings(body.text) } };
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/communications/:id/discard',
      summary: 'Discard a draft reply',
      tags: ['inbox'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      responses: {
        200: { description: 'Discarded' },
        409: { description: 'NOT_A_DRAFT', schema: errorResponse },
      },
    },
    async ({ user, params, request, idempotent }) =>
      idempotent(async (client) => {
        const row = await lockOutbound(client, user.tenantId, params.id);
        if (!['draft', 'failed'].includes(row.status))
          throw new HttpError(409, 'NOT_A_DRAFT', 'Only drafts can be discarded.');
        await client.query(
          "UPDATE communications SET status='discarded', updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [user.tenantId, params.id],
        );
        await auditor(client, user, request.id)(
          'communication.draft_discarded',
          'communication',
          params.id,
        );
        return { body: { id: params.id, status: 'discarded' } };
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/communications/:id/approve-send',
      summary:
        'Owner approves a draft (optionally with final text) and queues it for sending. Repeating it never sends twice; a failed message can be re-approved.',
      tags: ['inbox'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: approveSendBody,
      responses: {
        200: { description: 'Already approved, sending or sent: nothing new queued' },
        202: { description: 'Approved and queued for sending' },
        409: { description: 'NOT_SENDABLE: discarded, or not an email', schema: errorResponse },
        422: { description: 'NO_RECIPIENT', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const row = await lockOutbound(client, user.tenantId, params.id);
        if (['approved', 'sending', 'sent'].includes(row.status))
          return {
            status: 200,
            body: { id: row.id, status: row.status, sendAttempt: row.sendAttempt },
          };
        if (!['draft', 'failed'].includes(row.status) || row.channel !== 'email')
          throw new HttpError(409, 'NOT_SENDABLE', 'This message cannot be sent by email.');
        const recipients = row.toAddresses.length
          ? row.toAddresses
          : row.customerEmail && normaliseEmailAddress(row.customerEmail)
            ? [normaliseEmailAddress(row.customerEmail)!]
            : [];
        if (!recipients.length)
          throw new HttpError(422, 'NO_RECIPIENT', 'This message has no recipient email address.');
        const text = body.text ?? row.text;
        const attempt = row.sendAttempt + 1;
        await client.query(
          `UPDATE communications SET status='approved', approved_by=$3, approved_at=now(), text=$4,
             subject=coalesce($5,subject), to_addresses=$6, send_attempt=$7, send_error_code=NULL, updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [user.tenantId, row.id, user.id, text, body.subject ?? null, recipients, attempt],
        );
        await queue.enqueue(
          {
            tenantId: user.tenantId,
            kind: 'inbox.send',
            payload: { communicationId: row.id },
            idempotencyKey: `send:${row.id}:${attempt}`,
            maxAttempts: 3,
          },
          client,
        );
        await auditor(client, user, request.id)(
          'communication.send_approved',
          'communication',
          row.id,
          {
            attempt,
            edited: text !== row.text,
            recipients: recipients.length,
            warnings: draftWarnings(text),
          },
        );
        return { status: 202, body: { id: row.id, status: 'approved', sendAttempt: attempt } };
      }),
  );
}
