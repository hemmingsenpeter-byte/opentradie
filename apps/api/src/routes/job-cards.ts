import { createHash, randomUUID } from 'node:crypto';
import { recordAudit, recordJobEvent, type Transaction } from '@opentradie/database';
import type { FileStore } from '@opentradie/platform';
import { z } from 'zod';
import { HttpError, type RouteRegistry, type UserContext } from '../http.js';
import {
  contactCreateBody,
  contactResponse,
  documentResponse,
  errorResponse,
  EVIDENCE_BODY_LIMIT,
  EVIDENCE_MAX_BYTES,
  evidenceBody,
  idParams,
  propertyCreateBody,
  propertyListQuery,
  propertyResponse,
  propertyUpdateBody,
} from '../schemas.js';
import {
  contentDisposition,
  contentMatchesMediaType,
  extensionFor,
  safeFileName,
} from '../services/evidence.js';
import { getCustomer, getJob, getProperty, listProperties } from '../services/records.js';

function audit(
  client: Transaction,
  user: UserContext,
  requestId: string,
  action: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown> = {},
) {
  return recordAudit(client, {
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

const PROPERTY_COLUMNS: Record<string, string> = {
  label: 'label',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  suburb: 'suburb',
  city: 'city',
  postcode: 'postcode',
  accessNotes: 'access_notes',
};

/** Properties (job sites), customer contacts, job evidence and document downloads. */
export function registerJobCardRoutes(api: RouteRegistry, deps: { fileStore: FileStore }) {
  const { fileStore } = deps;

  // ---------- properties ----------
  api.route(
    {
      method: 'GET',
      url: '/api/properties',
      summary: 'List or search active properties (job sites), optionally for one customer',
      tags: ['properties'],
      auth: 'user',
      query: propertyListQuery,
      responses: {
        200: {
          description: 'Properties',
          schema: z.object({ properties: z.array(propertyResponse) }),
        },
      },
    },
    async ({ user, query }) => ({
      body: { properties: await listProperties(api.pool, user.tenantId, query) },
    }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/customers/:id/properties',
      summary: 'Add a property (job site) to a customer',
      tags: ['properties'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: propertyCreateBody,
      responses: {
        201: { description: 'Created property', schema: propertyResponse },
        404: { description: 'Customer not found', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        await getCustomer(client, user.tenantId, params.id);
        const id = randomUUID();
        await client.query(
          'INSERT INTO properties(id,tenant_id,customer_id,label,address_line1,address_line2,suburb,city,postcode,access_notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            id,
            user.tenantId,
            params.id,
            body.label ?? null,
            body.addressLine1,
            body.addressLine2 ?? null,
            body.suburb ?? null,
            body.city ?? null,
            body.postcode ?? null,
            body.accessNotes ?? null,
          ],
        );
        await audit(client, user, request.id, 'property.created', 'property', id, {
          customerId: params.id,
        });
        return { status: 201, body: await getProperty(client, user.tenantId, id) };
      }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/properties/:id',
      summary: 'A property',
      tags: ['properties'],
      auth: 'user',
      params: idParams,
      responses: {
        200: { description: 'Property', schema: propertyResponse },
        404: { description: 'Not found (including other tenants)', schema: errorResponse },
      },
    },
    async ({ user, params }) => ({ body: await getProperty(api.pool, user.tenantId, params.id) }),
  );

  api.route(
    {
      method: 'PATCH',
      url: '/api/properties/:id',
      summary: 'Update a property',
      tags: ['properties'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: propertyUpdateBody,
      responses: {
        200: { description: 'Updated property', schema: propertyResponse },
        404: { description: 'Not found', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const entries = Object.entries(body).filter(([key]) => key in PROPERTY_COLUMNS);
        const sets = entries.map(([key], index) => `${PROPERTY_COLUMNS[key]}=$${index + 3}`);
        const result = await client.query(
          `UPDATE properties SET ${[...sets, 'updated_at=now()'].join(',')} WHERE tenant_id=$1 AND id=$2`,
          [user.tenantId, params.id, ...entries.map(([, value]) => value ?? null)],
        );
        if (!result.rowCount) throw new HttpError(404, 'PROPERTY_NOT_FOUND', 'Property not found.');
        await audit(client, user, request.id, 'property.updated', 'property', params.id, {
          fields: entries.map(([key]) => key),
        });
        return { body: await getProperty(client, user.tenantId, params.id) };
      }),
  );

  api.route(
    {
      method: 'DELETE',
      url: '/api/properties/:id',
      summary: 'Archive a property (jobs at it keep their link and history)',
      tags: ['properties'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      responses: {
        200: { description: 'Archived property', schema: propertyResponse },
        404: { description: 'Not found', schema: errorResponse },
      },
    },
    async ({ user, params, request, idempotent }) =>
      idempotent(async (client) => {
        const result = await client.query(
          'UPDATE properties SET archived_at=coalesce(archived_at,now()),updated_at=now() WHERE tenant_id=$1 AND id=$2',
          [user.tenantId, params.id],
        );
        if (!result.rowCount) throw new HttpError(404, 'PROPERTY_NOT_FOUND', 'Property not found.');
        await audit(client, user, request.id, 'property.archived', 'property', params.id);
        return { body: await getProperty(client, user.tenantId, params.id) };
      }),
  );

  // ---------- customer contacts ----------
  api.route(
    {
      method: 'POST',
      url: '/api/customers/:id/contacts',
      summary: 'Add a contact person to a customer (e.g. a family member or property manager)',
      tags: ['customers'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: contactCreateBody,
      responses: {
        201: { description: 'Created contact', schema: contactResponse },
        404: { description: 'Customer not found', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        await getCustomer(client, user.tenantId, params.id);
        const id = randomUUID();
        await client.query(
          'INSERT INTO customer_contacts(id,tenant_id,customer_id,name,role,email,phone) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            id,
            user.tenantId,
            params.id,
            body.name,
            body.role ?? null,
            body.email ?? null,
            body.phone ?? null,
          ],
        );
        await audit(client, user, request.id, 'customer.contact_added', 'customer', params.id, {
          contactId: id,
        });
        return {
          status: 201,
          body: {
            id,
            name: body.name,
            role: body.role ?? null,
            email: body.email ?? null,
            phone: body.phone ?? null,
          },
        };
      }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/customers/:id/contacts',
      summary: 'Contacts for a customer',
      tags: ['customers'],
      auth: 'user',
      params: idParams,
      responses: {
        200: { description: 'Contacts', schema: z.object({ contacts: z.array(contactResponse) }) },
        404: { description: 'Customer not found', schema: errorResponse },
      },
    },
    async ({ user, params }) => {
      await getCustomer(api.pool, user.tenantId, params.id);
      const result = await api.pool.query(
        'SELECT id,name,role,email,phone FROM customer_contacts WHERE tenant_id=$1 AND customer_id=$2 ORDER BY name',
        [user.tenantId, params.id],
      );
      return { body: { contacts: result.rows } };
    },
  );

  // ---------- job evidence ----------
  api.route(
    {
      method: 'POST',
      url: '/api/jobs/:id/evidence',
      summary:
        'Attach a photo or document to a job (JSON with base64 content; JPEG, PNG, WebP, HEIC or PDF up to 6 MiB). The bytes must match the declared type.',
      tags: ['jobs'],
      auth: 'owner',
      idempotent: true,
      bodyLimit: EVIDENCE_BODY_LIMIT,
      rateLimit: { max: 60, timeWindow: '1 minute' },
      params: idParams,
      body: evidenceBody,
      responses: {
        201: { description: 'Stored evidence', schema: documentResponse },
        404: { description: 'Job not found', schema: errorResponse },
        413: { description: 'File too large', schema: errorResponse },
        415: {
          description: 'UNSUPPORTED_MEDIA: content does not match the declared type',
          schema: errorResponse,
        },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const job = await getJob(client, user.tenantId, params.id);
        const bytes = Buffer.from(body.dataBase64, 'base64');
        if (bytes.length === 0) throw new HttpError(400, 'VALIDATION_ERROR', 'The file is empty.');
        if (bytes.length > EVIDENCE_MAX_BYTES)
          throw new HttpError(413, 'FILE_TOO_LARGE', 'Files can be up to 6 MiB.');
        if (!contentMatchesMediaType(bytes, body.mediaType))
          throw new HttpError(
            415,
            'UNSUPPORTED_MEDIA',
            'The file content does not match its type. Upload a JPEG, PNG, WebP, HEIC or PDF file.',
          );
        const kind = body.kind ?? (body.mediaType.startsWith('image/') ? 'photo' : 'attachment');
        const fileName = safeFileName(body.fileName, body.mediaType);
        const documentId = randomUUID();
        const key = `tenants/${user.tenantId}/jobs/${job.id}/evidence/${documentId}.${extensionFor(body.mediaType)}`;
        const stored = await fileStore.put(key, bytes, { contentType: body.mediaType });
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (stored.sha256 !== sha256) throw new Error('Stored evidence checksum mismatch.');
        const inserted = await client.query<{ createdAt: Date }>(
          'INSERT INTO documents(id,tenant_id,customer_id,job_id,kind,storage_key,file_name,media_type,size_bytes,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING created_at AS "createdAt"',
          [
            documentId,
            user.tenantId,
            job.customerId,
            job.id,
            kind,
            key,
            fileName,
            body.mediaType,
            bytes.length,
            sha256,
          ],
        );
        await recordJobEvent(client, {
          tenantId: user.tenantId,
          jobId: job.id,
          type: 'evidence_added',
          actorType: 'user',
          actorId: user.id,
          summary: kind === 'photo' ? 'Photo added' : 'Attachment added',
          metadata: { documentId, kind, mediaType: body.mediaType, sizeBytes: bytes.length },
        });
        await audit(client, user, request.id, 'job.evidence_added', 'job', job.id, {
          documentId,
          kind,
          mediaType: body.mediaType,
          sizeBytes: bytes.length,
          sha256,
        });
        return {
          status: 201,
          body: {
            id: documentId,
            kind,
            fileName,
            mediaType: body.mediaType,
            sizeBytes: bytes.length,
            sha256,
            quoteId: null,
            createdAt: inserted.rows[0]!.createdAt.toISOString(),
          },
        };
      }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/documents/:id/content',
      summary:
        'Download a stored document or evidence file (tenant-checked; the checksum is verified before sending)',
      tags: ['jobs'],
      auth: 'user',
      params: idParams,
      responses: {
        200: { description: 'File content with its stored media type' },
        404: { description: 'Not found (including other tenants)', schema: errorResponse },
      },
    },
    async ({ user, params, reply }) => {
      const result = await api.pool.query<{
        storageKey: string;
        fileName: string;
        mediaType: string;
        sha256: string;
      }>(
        'SELECT storage_key AS "storageKey",file_name AS "fileName",media_type AS "mediaType",sha256 FROM documents WHERE tenant_id=$1 AND id=$2',
        [user.tenantId, params.id],
      );
      const document = result.rows[0];
      if (!document) throw new HttpError(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
      const content = await fileStore.get(document.storageKey);
      if (createHash('sha256').update(content).digest('hex') !== document.sha256)
        throw new HttpError(
          500,
          'DOCUMENT_INTEGRITY',
          'The stored file does not match its recorded checksum.',
        );
      reply
        .header('content-type', document.mediaType)
        .header('content-disposition', contentDisposition(document.fileName))
        .header('cache-control', 'private, no-store');
      return { body: content };
    },
  );
}
