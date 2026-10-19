import { randomUUID } from 'node:crypto';
import type { AgentRuntime } from '@opentradie/agent';
import { checkJobTransition, nextJobStatuses, type JobStatus } from '@opentradie/core';
import { recordAudit, recordJobEvent, type Database, type Transaction } from '@opentradie/database';
import { describeConfig, type RuntimeConfig } from '@opentradie/platform';
import { z } from 'zod';
import { HttpError, iso, type RouteRegistry, type UserContext } from '../http.js';
import {
  auditEventResponse,
  customerCreateBody,
  customerResponse,
  customerUpdateBody,
  errorResponse,
  idParams,
  jobCreateBody,
  jobListQuery,
  jobNoteBody,
  jobNoteResponse,
  jobDetailResponse,
  jobResponse,
  jobUpdateBody,
  listQuery,
  rateResponse,
  searchQuery,
} from '../schemas.js';
import { agentHealthWithTimeout } from '../services/agent-info.js';
import {
  getCustomer,
  getJob,
  likePattern,
  getProperty,
  listCustomers,
  listJobDocuments,
  listJobEvents,
  listJobs,
  listProperties,
  listQuotes,
  loadBusiness,
  loadRates,
  propertyForCustomer,
} from '../services/records.js';

function auditor(client: Transaction, user: UserContext, requestId: string) {
  return (
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown> = {},
  ) =>
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

export function registerRecordRoutes(
  api: RouteRegistry,
  deps: { db: Database; runtime: AgentRuntime; config: RuntimeConfig },
) {
  const { db, runtime, config } = deps;

  // ---------- customers ----------
  api.route(
    {
      method: 'GET',
      url: '/api/customers',
      summary: 'List or search customers (Postgres full-text search plus name match)',
      tags: ['customers'],
      auth: 'user',
      query: listQuery,
      responses: {
        200: {
          description: 'Customers',
          schema: z.object({ customers: z.array(customerResponse) }),
        },
      },
    },
    async ({ user, query }) => ({
      body: { customers: await listCustomers(db.pool, user.tenantId, query.q, query.limit) },
    }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/customers',
      summary: 'Create a customer',
      tags: ['customers'],
      auth: 'owner',
      idempotent: true,
      body: customerCreateBody,
      responses: { 201: { description: 'Created customer', schema: customerResponse } },
    },
    async ({ user, body, request, idempotent }) =>
      idempotent(async (client) => {
        const id = randomUUID();
        await client.query(
          'INSERT INTO customers(id,tenant_id,name,preferred_name,email,phone,address) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            id,
            user.tenantId,
            body.name,
            body.preferredName ?? null,
            body.email ?? null,
            body.phone ?? null,
            body.address ?? null,
          ],
        );
        await auditor(client, user, request.id)('customer.created', 'customer', id);
        return { status: 201, body: await getCustomer(client, user.tenantId, id) };
      }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/customers/:id',
      summary: 'Customer profile with contacts, properties, jobs, communications and quotes',
      tags: ['customers'],
      auth: 'user',
      params: idParams,
      responses: {
        200: { description: 'Customer profile' },
        404: { description: 'Not found (including other tenants)', schema: errorResponse },
      },
    },
    async ({ user, params }) => {
      const customer = await getCustomer(db.pool, user.tenantId, params.id);
      const [contacts, properties, jobs, communications, quotes] = await Promise.all([
        db.pool.query(
          'SELECT id,name,role,email,phone FROM customer_contacts WHERE tenant_id=$1 AND customer_id=$2 ORDER BY name',
          [user.tenantId, params.id],
        ),
        listProperties(db.pool, user.tenantId, { customerId: params.id, limit: 200 }),
        listJobs(db.pool, user.tenantId, { customerId: params.id, limit: 100 }),
        db.pool.query<{ createdAt: Date }>(
          'SELECT id,job_id AS "jobId",direction,channel,status,subject,text,created_at AS "createdAt" FROM communications WHERE tenant_id=$1 AND customer_id=$2 ORDER BY created_at DESC LIMIT 50',
          [user.tenantId, params.id],
        ),
        listQuotes(db.pool, user.tenantId),
      ]);
      return {
        body: {
          customer,
          contacts: contacts.rows,
          properties,
          jobs,
          communications: communications.rows.map((row) => ({
            ...row,
            createdAt: iso(row.createdAt),
          })),
          quotes: quotes.filter((quote) => quote.customerId === params.id),
        },
      };
    },
  );

  api.route(
    {
      method: 'PATCH',
      url: '/api/customers/:id',
      summary: 'Update a customer',
      tags: ['customers'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: customerUpdateBody,
      responses: {
        200: { description: 'Updated customer', schema: customerResponse },
        404: { description: 'Not found', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const columns: Record<string, string> = {
          name: 'name',
          preferredName: 'preferred_name',
          email: 'email',
          phone: 'phone',
          address: 'address',
        };
        const entries = Object.entries(body).filter(([key]) => key in columns);
        const sets = entries.map(([key], index) => `${columns[key]}=$${index + 3}`).join(',');
        const result = await client.query(
          `UPDATE customers SET ${sets},updated_at=now() WHERE tenant_id=$1 AND id=$2`,
          [user.tenantId, params.id, ...entries.map(([, value]) => value ?? null)],
        );
        if (!result.rowCount) throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
        await auditor(client, user, request.id)('customer.updated', 'customer', params.id, {
          fields: entries.map(([key]) => key),
        });
        return { body: await getCustomer(client, user.tenantId, params.id) };
      }),
  );

  api.route(
    {
      method: 'DELETE',
      url: '/api/customers/:id',
      summary: 'Archive a customer (records and history are kept)',
      tags: ['customers'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      responses: {
        200: { description: 'Archived customer', schema: customerResponse },
        404: { description: 'Not found', schema: errorResponse },
      },
    },
    async ({ user, params, request, idempotent }) =>
      idempotent(async (client) => {
        const result = await client.query(
          'UPDATE customers SET archived_at=coalesce(archived_at,now()),updated_at=now() WHERE tenant_id=$1 AND id=$2',
          [user.tenantId, params.id],
        );
        if (!result.rowCount) throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
        await auditor(client, user, request.id)('customer.archived', 'customer', params.id);
        return { body: await getCustomer(client, user.tenantId, params.id) };
      }),
  );

  // ---------- jobs ----------
  api.route(
    {
      method: 'GET',
      url: '/api/jobs',
      summary: 'List or search jobs',
      tags: ['jobs'],
      auth: 'user',
      query: jobListQuery,
      responses: { 200: { description: 'Jobs', schema: z.object({ jobs: z.array(jobResponse) }) } },
    },
    async ({ user, query }) => ({ body: { jobs: await listJobs(db.pool, user.tenantId, query) } }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/jobs',
      summary: 'Create a job for an existing customer, optionally at one of their properties',
      tags: ['jobs'],
      auth: 'owner',
      idempotent: true,
      body: jobCreateBody,
      responses: {
        201: { description: 'Created job', schema: jobResponse },
        404: { description: 'Customer or property not found', schema: errorResponse },
        422: {
          description: 'PROPERTY_CUSTOMER_MISMATCH or PROPERTY_ARCHIVED',
          schema: errorResponse,
        },
      },
    },
    async ({ user, body, request, idempotent }) =>
      idempotent(async (client) => {
        await getCustomer(client, user.tenantId, body.customerId);
        const property = body.propertyId
          ? await propertyForCustomer(client, user.tenantId, body.customerId, body.propertyId)
          : null;
        const id = randomUUID();
        await client.query(
          'INSERT INTO jobs(id,tenant_id,customer_id,title,description,site_address,property_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            id,
            user.tenantId,
            body.customerId,
            body.title,
            body.description ?? null,
            body.siteAddress ?? property?.address ?? null,
            property?.id ?? null,
          ],
        );
        await recordJobEvent(client, {
          tenantId: user.tenantId,
          jobId: id,
          type: 'created',
          actorType: 'user',
          actorId: user.id,
          toStatus: 'new',
          summary: 'Job created',
          metadata: { origin: 'manual', propertyId: property?.id ?? null },
        });
        if (body.notes) await addNote(client, user, id, body.notes);
        await auditor(client, user, request.id)('job.created', 'job', id, {
          customerId: body.customerId,
          propertyId: property?.id ?? null,
        });
        return { status: 201, body: await getJob(client, user.tenantId, id) };
      }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/jobs/:id',
      summary:
        'Job card: job, customer, property, allowed next statuses, notes, evidence and documents, quotes and the timeline',
      tags: ['jobs'],
      auth: 'user',
      params: idParams,
      responses: {
        200: { description: 'Job detail', schema: jobDetailResponse },
        404: { description: 'Not found', schema: errorResponse },
      },
    },
    async ({ user, params }) => {
      const job = await getJob(db.pool, user.tenantId, params.id);
      const [customer, property, notes, communications, documents, quotes, timeline] =
        await Promise.all([
          getCustomer(db.pool, user.tenantId, job.customerId),
          job.propertyId ? getProperty(db.pool, user.tenantId, job.propertyId) : null,
          db.pool.query<{ createdAt: Date }>(
            'SELECT id,text,provenance,created_at AS "createdAt" FROM job_notes WHERE tenant_id=$1 AND job_id=$2 ORDER BY created_at DESC',
            [user.tenantId, params.id],
          ),
          db.pool.query<{ createdAt: Date }>(
            'SELECT id,direction,channel,status,subject,text,created_at AS "createdAt" FROM communications WHERE tenant_id=$1 AND job_id=$2 ORDER BY created_at DESC',
            [user.tenantId, params.id],
          ),
          listJobDocuments(db.pool, user.tenantId, params.id),
          listQuotes(db.pool, user.tenantId),
          listJobEvents(db.pool, user.tenantId, params.id),
        ]);
      const stamp = <T extends { createdAt: Date }>(rows: T[]) =>
        rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) }));
      return {
        body: {
          job,
          customer,
          property,
          nextStatuses: nextJobStatuses(job.status),
          notes: stamp(notes.rows),
          communications: stamp(communications.rows),
          documents,
          quotes: quotes.filter((quote) => quote.jobId === params.id),
          timeline,
        },
      };
    },
  );

  api.route(
    {
      method: 'PATCH',
      url: '/api/jobs/:id',
      summary:
        'Update a job (validated status transition, details, property) and optionally add a note',
      tags: ['jobs'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: jobUpdateBody,
      responses: {
        200: { description: 'Updated job', schema: jobResponse },
        404: { description: 'Job or property not found', schema: errorResponse },
        409: {
          description:
            'INVALID_STATUS_TRANSITION or REOPEN_REQUIRED (includes from, to and allowed next statuses)',
          schema: errorResponse,
        },
        422: {
          description: 'PROPERTY_CUSTOMER_MISMATCH or PROPERTY_ARCHIVED',
          schema: errorResponse,
        },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const locked = await client.query<{
          status: JobStatus;
          customerId: string;
          propertyId: string | null;
        }>(
          'SELECT status,customer_id AS "customerId",property_id AS "propertyId" FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
          [user.tenantId, params.id],
        );
        const current = locked.rows[0];
        if (!current) throw new HttpError(404, 'JOB_NOT_FOUND', 'Job not found.');
        const event = (
          input: Omit<
            Parameters<typeof recordJobEvent>[1],
            'tenantId' | 'jobId' | 'actorType' | 'actorId'
          >,
        ) =>
          recordJobEvent(client, {
            tenantId: user.tenantId,
            jobId: params.id,
            actorType: 'user',
            actorId: user.id,
            ...input,
          });
        const sets: string[] = [];
        const values: unknown[] = [];
        const set = (column: string, value: unknown) => {
          values.push(value);
          sets.push(`${column}=$${values.length + 2}`);
        };

        const changedDetails = (['title', 'description', 'siteAddress'] as const).filter(
          (key) => body[key] !== undefined,
        );
        if (body.title !== undefined) set('title', body.title);
        if (body.description !== undefined) set('description', body.description ?? null);
        if (body.siteAddress !== undefined) set('site_address', body.siteAddress ?? null);

        let propertyChange: { from: string | null; to: string | null } | null = null;
        if (body.propertyId !== undefined && body.propertyId !== current.propertyId) {
          const property = body.propertyId
            ? await propertyForCustomer(client, user.tenantId, current.customerId, body.propertyId)
            : null;
          set('property_id', property?.id ?? null);
          if (property && body.siteAddress === undefined) set('site_address', property.address);
          propertyChange = { from: current.propertyId, to: property?.id ?? null };
        }

        let statusChange: { from: JobStatus; to: JobStatus; reopen: boolean } | null = null;
        if (body.status && body.status !== current.status) {
          const check = checkJobTransition(current.status, body.status, {
            reopen: body.reopen === true,
          });
          if (!check.allowed)
            throw new HttpError(
              409,
              check.code === 'REOPEN_REQUIRED' ? 'REOPEN_REQUIRED' : 'INVALID_STATUS_TRANSITION',
              check.message,
              {
                from: current.status,
                to: body.status,
                allowed: nextJobStatuses(current.status),
              },
            );
          set('status', body.status);
          if (check.setsCompletedAt) sets.push('completed_at=now()');
          if (check.clearsCompletedAt) sets.push('completed_at=NULL');
          statusChange = { from: current.status, to: body.status, reopen: check.reopen };
        }

        if (sets.length)
          await client.query(
            `UPDATE jobs SET ${[...sets, 'updated_at=now()'].join(',')} WHERE tenant_id=$1 AND id=$2`,
            [user.tenantId, params.id, ...values],
          );
        if (statusChange)
          await event({
            type: 'status_changed',
            fromStatus: statusChange.from,
            toStatus: statusChange.to,
            summary: statusChange.reopen ? 'Job reopened' : 'Status changed',
            metadata: { reopen: statusChange.reopen },
          });
        if (propertyChange)
          await event({
            type: 'property_changed',
            summary: propertyChange.to ? 'Job site set' : 'Job site cleared',
            metadata: { fromPropertyId: propertyChange.from, toPropertyId: propertyChange.to },
          });
        if (changedDetails.length)
          await event({
            type: 'details_updated',
            summary: 'Job details updated',
            metadata: { fields: changedDetails },
          });
        if (body.notes) await addNote(client, user, params.id, body.notes);
        await auditor(client, user, request.id)('job.updated', 'job', params.id, {
          fields: Object.keys(body),
          ...(statusChange
            ? {
                fromStatus: statusChange.from,
                toStatus: statusChange.to,
                reopen: statusChange.reopen,
              }
            : {}),
        });
        return { body: await getJob(client, user.tenantId, params.id) };
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/jobs/:id/notes',
      summary: 'Add a note to a job',
      tags: ['jobs'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: jobNoteBody,
      responses: {
        201: { description: 'Created note', schema: jobNoteResponse },
        404: { description: 'Not found', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        await getJob(client, user.tenantId, params.id);
        const note = await addNote(client, user, params.id, body.text);
        await auditor(client, user, request.id)('job.note_added', 'job', params.id, {
          noteId: note.id,
        });
        return { status: 201, body: note };
      }),
  );

  // ---------- search, communications, rates, audit ----------
  api.route(
    {
      method: 'GET',
      url: '/api/search',
      summary:
        'Search customers, jobs and knowledge with Postgres text search (no embedding provider required)',
      tags: ['search'],
      auth: 'user',
      query: searchQuery,
      responses: { 200: { description: 'Search results' } },
    },
    async ({ user, query }) => {
      const [customers, jobs, knowledge] = await Promise.all([
        listCustomers(db.pool, user.tenantId, query.q, 25),
        listJobs(db.pool, user.tenantId, { q: query.q, limit: 25 }),
        db.pool.query<{ createdAt: Date; sourceCreatedAt: Date }>(
          `SELECT id,customer_id AS "customerId",job_id AS "jobId",source_type AS "sourceType",source_id AS "sourceId",content,provenance,
             extraction_status AS "extractionStatus",confidence,source_created_at AS "sourceCreatedAt",created_at AS "createdAt"
           FROM knowledge_items WHERE tenant_id=$1 AND (search_vector @@ plainto_tsquery('simple',$2) OR content ILIKE $3)
           ORDER BY ts_rank(search_vector, plainto_tsquery('simple',$2)) DESC LIMIT 25`,
          [user.tenantId, query.q, likePattern(query.q)],
        ),
      ]);
      return {
        body: {
          customers,
          jobs,
          knowledge: knowledge.rows.map((row) => ({
            ...row,
            createdAt: iso(row.createdAt),
            sourceCreatedAt: iso(row.sourceCreatedAt),
          })),
        },
      };
    },
  );

  api.route(
    {
      method: 'GET',
      url: '/api/communications',
      summary: 'Inbox: recent communications',
      tags: ['communications'],
      auth: 'user',
      responses: { 200: { description: 'Communications' } },
    },
    async ({ user }) => {
      const rows = await db.pool.query<{ createdAt: Date }>(
        `SELECT m.id,m.customer_id AS "customerId",c.name AS "customerName",m.job_id AS "jobId",m.direction,m.channel,m.status,m.sender,m.subject,m.text,m.created_at AS "createdAt"
         FROM communications m LEFT JOIN customers c ON c.tenant_id=m.tenant_id AND c.id=m.customer_id
         WHERE m.tenant_id=$1 ORDER BY m.created_at DESC LIMIT 100`,
        [user.tenantId],
      );
      return {
        body: {
          communications: rows.rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) })),
        },
      };
    },
  );

  api.route(
    {
      method: 'GET',
      url: '/api/rates',
      summary: 'Owner-approved rate card',
      tags: ['quotes'],
      auth: 'user',
      responses: {
        200: { description: 'Rates', schema: z.object({ rates: z.array(rateResponse) }) },
      },
    },
    async ({ user }) => ({ body: { rates: await loadRates(db.pool, user.tenantId) } }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/audit-events',
      summary: 'Recent audit events',
      tags: ['audit'],
      auth: 'user',
      query: z
        .object({
          entityId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .strict(),
      responses: {
        200: {
          description: 'Audit events',
          schema: z.object({ auditEvents: z.array(auditEventResponse) }),
        },
      },
    },
    async ({ user, query }) => {
      const rows = await db.pool.query<{ createdAt: Date }>(
        `SELECT id,action,actor_type AS "actorType",actor_id AS "actorId",entity_type AS "entityType",entity_id AS "entityId",request_id AS "requestId",created_at AS "createdAt"
         FROM audit_events WHERE tenant_id=$1 AND ($2::uuid IS NULL OR entity_id=$2) ORDER BY created_at DESC LIMIT $3`,
        [user.tenantId, query.entityId ?? null, query.limit],
      );
      return {
        body: { auditEvents: rows.rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) })) },
      };
    },
  );

  // ---------- dashboard snapshot (used by the web app) ----------
  api.route(
    {
      method: 'GET',
      url: '/api/state',
      summary: 'Dashboard snapshot for the signed-in user',
      tags: ['dashboard'],
      auth: 'user',
      responses: { 200: { description: 'Snapshot' } },
    },
    async ({ user }) => {
      const [
        business,
        customers,
        properties,
        jobs,
        communications,
        quotes,
        rates,
        auditEvents,
        health,
      ] = await Promise.all([
        loadBusiness(db.pool, user.tenantId),
        listCustomers(db.pool, user.tenantId, undefined, 500),
        listProperties(db.pool, user.tenantId, { limit: 1000 }),
        listJobs(db.pool, user.tenantId, { limit: 200 }),
        db.pool.query<{ createdAt: Date }>(
          'SELECT id,customer_id AS "customerId",job_id AS "jobId",direction,channel,status,subject,text,created_at AS "createdAt" FROM communications WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',
          [user.tenantId],
        ),
        listQuotes(db.pool, user.tenantId),
        loadRates(db.pool, user.tenantId),
        db.pool.query<{ createdAt: Date }>(
          'SELECT id,action,entity_type AS "entityType",entity_id AS "entityId",created_at AS "createdAt" FROM audit_events WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 30',
          [user.tenantId],
        ),
        agentHealthWithTimeout(runtime),
      ]);
      const safe = describeConfig(config);
      return {
        body: {
          business,
          user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
          customers,
          properties,
          jobs,
          communications: communications.rows.map((row) => ({
            ...row,
            createdAt: iso(row.createdAt),
          })),
          quotes,
          approvals: quotes
            .filter((quote) => quote.approval?.status === 'pending')
            .map((quote) => ({ id: quote.approval!.id, quoteId: quote.id })),
          rates,
          auditEvents: auditEvents.rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) })),
          settings: {
            profile: safe.profile,
            installationId: safe.installationId,
            privacyMode: safe.privacyMode,
            agentMode: safe.agentMode,
            agentHealth: health?.status ?? 'unavailable',
            agentSynthetic: health?.synthetic ?? false,
            agentProvider: health?.provider ?? 'unavailable',
            inferenceLocation: health?.inferenceLocation ?? 'unverified',
            fileStore: safe.fileStore,
            embeddingProvider: safe.embeddingProvider,
            demoData: business.demoData,
          },
        },
      };
    },
  );
}

async function addNote(client: Transaction, user: UserContext, jobId: string, text: string) {
  const id = randomUUID();
  const result = await client.query<{ createdAt: Date }>(
    'INSERT INTO job_notes(id,tenant_id,job_id,author_id,text,provenance) VALUES($1,$2,$3,$4,$5,\'user_supplied\') RETURNING created_at AS "createdAt"',
    [id, user.tenantId, jobId, user.id, text],
  );
  await recordJobEvent(client, {
    tenantId: user.tenantId,
    jobId,
    type: 'note_added',
    actorType: 'user',
    actorId: user.id,
    summary: 'Note added',
    metadata: { noteId: id },
  });
  await client.query(
    "INSERT INTO knowledge_items(id,tenant_id,customer_id,job_id,source_type,source_id,source_created_at,content,provenance) SELECT $1,$2,customer_id,$3,'job_note',$4,now(),$5,'user_supplied' FROM jobs WHERE tenant_id=$2 AND id=$3",
    [randomUUID(), user.tenantId, jobId, id, text],
  );
  return {
    id,
    text,
    provenance: 'user_supplied' as const,
    createdAt: iso(result.rows[0]!.createdAt)!,
  };
}
