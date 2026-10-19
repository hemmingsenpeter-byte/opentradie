import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentResponse,
  jobDetailResponse,
  propertyResponse,
} from '../../apps/api/src/schemas.js';
import {
  createTestContext,
  customerId,
  TENANT_A,
  TENANT_B,
  type TestContext,
} from '../helpers/app.js';

/** A valid 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n% synthetic test file\n%%EOF\n');

describe('properties, job cards, timeline and evidence', () => {
  let ctx: TestContext;
  let owner: string;
  let margaret: string;
  let helen: string;
  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await ctx.login();
    margaret = await customerId(ctx.db, 'Mrs Johnson');
    helen = await customerId(ctx.db, 'Helen Johnson');
  });
  afterAll(async () => ctx?.close());

  it('seeds a property for the demo customers and links their jobs to it', async () => {
    const profile = (await ctx.get(`/api/customers/${margaret}`, owner)).body;
    expect(profile.properties).toHaveLength(1);
    expect(profile.properties[0]).toMatchObject({
      label: 'Home',
      address: '14 Kauri Street, Grey Lynn, Auckland 1021',
    });
    expect(profile.jobs.every((job: { propertyId: string }) => job.propertyId)).toBe(true);
    const state = (await ctx.get('/api/state', owner)).body;
    expect(state.properties.length).toBeGreaterThanOrEqual(3);
  });

  it('creates, searches, updates and archives a property with audit events', async () => {
    const created = await ctx.send('POST', `/api/customers/${margaret}/properties`, owner, {
      label: 'Rental',
      addressLine1: '88 Totara Avenue',
      suburb: 'Henderson',
      city: 'Auckland',
      postcode: '0612',
      accessNotes: 'Key in lockbox, code from tenant.',
    });
    expect(created.status).toBe(201);
    const property = propertyResponse.parse(created.body);
    expect(property).toMatchObject({
      customerId: margaret,
      address: '88 Totara Avenue, Henderson, Auckland 0612',
      archived: false,
    });
    const search = (await ctx.get('/api/properties?q=henderson', owner)).body;
    expect(search.properties.map((p: { id: string }) => p.id)).toEqual([property.id]);
    const updated = await ctx.send('PATCH', `/api/properties/${property.id}`, owner, {
      addressLine2: 'Unit B',
    });
    expect(updated.body.address).toBe('88 Totara Avenue, Unit B, Henderson, Auckland 0612');
    const archived = await ctx.send('DELETE', `/api/properties/${property.id}`, owner);
    expect(archived.body.archived).toBe(true);
    const listed = (await ctx.get(`/api/properties?customerId=${margaret}`, owner)).body;
    expect(listed.properties.map((p: { id: string }) => p.id)).not.toContain(property.id);
    const audit = (await ctx.get(`/api/audit-events?entityId=${property.id}`, owner)).body;
    expect(audit.auditEvents.map((e: { action: string }) => e.action).sort()).toEqual([
      'property.archived',
      'property.created',
      'property.updated',
    ]);
    // An archived site cannot be used for new work.
    const job = await ctx.send('POST', '/api/jobs', owner, {
      customerId: margaret,
      title: 'Archived site job',
      propertyId: property.id,
    });
    expect(job.status).toBe(422);
    expect(job.body.error).toBe('PROPERTY_ARCHIVED');
    const invalid = await ctx.send('POST', `/api/customers/${margaret}/properties`, owner, {
      addressLine1: '',
    });
    expect(invalid.status).toBe(400);
  });

  it('adds and lists customer contacts', async () => {
    const created = await ctx.send('POST', `/api/customers/${helen}/contacts`, owner, {
      name: 'Pat Johnson',
      role: 'property manager',
      phone: '+64 21 555 0199',
    });
    expect(created.status).toBe(201);
    const contacts = (await ctx.get(`/api/customers/${helen}/contacts`, owner)).body.contacts;
    expect(contacts.map((c: { name: string }) => c.name)).toContain('Pat Johnson');
    const profile = (await ctx.get(`/api/customers/${helen}`, owner)).body;
    expect(profile.contacts.map((c: { id: string }) => c.id)).toContain(created.body.id);
  });

  it('opens a job at a property, records work and moves it through valid statuses', async () => {
    const site = (await ctx.get(`/api/customers/${margaret}`, owner)).body.properties[0];
    const created = await ctx.send('POST', '/api/jobs', owner, {
      customerId: margaret,
      propertyId: site.id,
      title: 'Replace lounge power points',
      notes: 'Two cracked double sockets.',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      propertyId: site.id,
      siteAddress: site.address,
      status: 'new',
    });
    const jobId = created.body.id as string;

    // Another customer's property cannot be used.
    const helenSite = (await ctx.get(`/api/customers/${helen}`, owner)).body.properties[0];
    const mismatch = await ctx.send('PATCH', `/api/jobs/${jobId}`, owner, {
      propertyId: helenSite.id,
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error).toBe('PROPERTY_CUSTOMER_MISMATCH');

    // Invalid transition: a new job cannot jump to completed.
    const skip = await ctx.send('PATCH', `/api/jobs/${jobId}`, owner, { status: 'completed' });
    expect(skip.status).toBe(409);
    expect(skip.body).toMatchObject({
      error: 'INVALID_STATUS_TRANSITION',
      from: 'new',
      to: 'completed',
    });
    expect(skip.body.allowed.map((t: { status: string }) => t.status)).toEqual([
      'quoted',
      'scheduled',
      'in_progress',
      'cancelled',
    ]);
    expect((await ctx.get(`/api/jobs/${jobId}`, owner)).body.job.status).toBe('new');

    for (const status of ['scheduled', 'in_progress', 'completed']) {
      const step = await ctx.send('PATCH', `/api/jobs/${jobId}`, owner, { status });
      expect(step.status, status).toBe(200);
    }
    const completed = (await ctx.get(`/api/jobs/${jobId}`, owner)).body;
    expect(completed.job.completedAt).not.toBeNull();
    expect(completed.nextStatuses).toEqual([{ status: 'in_progress', reopen: true }]);

    const noReopen = await ctx.send('PATCH', `/api/jobs/${jobId}`, owner, {
      status: 'in_progress',
    });
    expect(noReopen.status).toBe(409);
    expect(noReopen.body.error).toBe('REOPEN_REQUIRED');
    const reopened = await ctx.send('PATCH', `/api/jobs/${jobId}`, owner, {
      status: 'in_progress',
      reopen: true,
      notes: 'Customer reported one socket still loose.',
    });
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ status: 'in_progress', completedAt: null });

    const note = await ctx.send('POST', `/api/jobs/${jobId}/notes`, owner, {
      text: 'Tightened terminal; tested.',
    });
    expect(note.status).toBe(201);

    const detail = jobDetailResponse.parse((await ctx.get(`/api/jobs/${jobId}`, owner)).body);
    expect(detail.customer.id).toBe(margaret);
    expect(detail.property?.id).toBe(site.id);
    expect(detail.notes).toHaveLength(3);
    const timeline = [...detail.timeline].reverse();
    expect(timeline.map((event) => event.type)).toEqual([
      'created',
      'note_added',
      'status_changed',
      'status_changed',
      'status_changed',
      'status_changed',
      'note_added',
      'note_added',
    ]);
    expect(
      timeline
        .filter((event) => event.type === 'status_changed')
        .map((event) => `${event.fromStatus}->${event.toStatus}`),
    ).toEqual([
      'new->scheduled',
      'scheduled->in_progress',
      'in_progress->completed',
      'completed->in_progress',
    ]);
    expect(timeline[5]).toMatchObject({ summary: 'Job reopened', metadata: { reopen: true } });
    expect(timeline[0]).toMatchObject({ actorType: 'user', actorName: 'Demo Owner' });
    expect(timeline.at(-1)?.noteText).toBe('Tightened terminal; tested.');

    // The failed transitions and the rejected property change left no trace in the timeline.
    const audit = (await ctx.get(`/api/audit-events?entityId=${jobId}`, owner)).body.auditEvents;
    expect(audit.filter((e: { action: string }) => e.action === 'job.updated')).toHaveLength(4);
  });

  it('keeps the timeline append-only at the database level', async () => {
    const event = await ctx.db.pool.query('SELECT id FROM job_events WHERE tenant_id=$1 LIMIT 1', [
      TENANT_A,
    ]);
    await expect(
      ctx.db.pool.query("UPDATE job_events SET summary='rewritten' WHERE id=$1", [
        event.rows[0].id,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      ctx.db.pool.query('DELETE FROM job_events WHERE id=$1', [event.rows[0].id]),
    ).rejects.toThrow(/append-only/);
  });

  it('stores photo evidence with a checksum, records it on the timeline and serves it back', async () => {
    const job = (await ctx.get('/api/jobs?q=Kitchen', owner)).body.jobs[0];
    const upload = await ctx.send('POST', `/api/jobs/${job.id}/evidence`, owner, {
      fileName: '../../etc/switchboard photo.png',
      mediaType: 'image/png',
      dataBase64: PNG.toString('base64'),
    });
    expect(upload.status).toBe(201);
    const document = documentResponse.parse(upload.body);
    expect(document).toMatchObject({
      kind: 'photo',
      fileName: 'switchboard photo.png',
      sizeBytes: PNG.length,
      sha256: createHash('sha256').update(PNG).digest('hex'),
    });
    const pdf = await ctx.send('POST', `/api/jobs/${job.id}/evidence`, owner, {
      fileName: 'certificate.pdf',
      mediaType: 'application/pdf',
      dataBase64: PDF.toString('base64'),
    });
    expect(pdf.status).toBe(201);
    expect(pdf.body.kind).toBe('attachment');

    const detail = (await ctx.get(`/api/jobs/${job.id}`, owner)).body;
    expect(detail.documents.map((d: { id: string }) => d.id)).toContain(document.id);
    expect(detail.timeline[0]).toMatchObject({
      type: 'evidence_added',
      summary: 'Attachment added',
    });
    expect(detail.timeline[1]).toMatchObject({
      type: 'evidence_added',
      metadata: { documentId: document.id, kind: 'photo' },
    });

    const download = await ctx.app.inject({
      method: 'GET',
      url: `/api/documents/${document.id}/content`,
      headers: { cookie: owner },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('image/png');
    expect(download.headers['content-disposition']).toMatch(
      /^attachment; filename="switchboard photo.png"/,
    );
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(download.rawPayload, PNG)).toBe(0);
    const viewer = await ctx.login('viewer');
    expect((await ctx.get(`/api/documents/${document.id}/content`, viewer)).status).toBe(200);
    expect((await ctx.get(`/api/documents/${randomUUID()}/content`, owner)).status).toBe(404);

    const audit = (await ctx.get(`/api/audit-events?entityId=${job.id}`, owner)).body.auditEvents;
    expect(audit.map((e: { action: string }) => e.action)).toContain('job.evidence_added');
  });

  it('rejects evidence whose content, type or size is not allowed', async () => {
    const job = (await ctx.get('/api/jobs?q=Kitchen', owner)).body.jobs[0];
    const before = await ctx.db.pool.query('SELECT count(*)::int AS n FROM documents');
    const disguised = await ctx.send('POST', `/api/jobs/${job.id}/evidence`, owner, {
      fileName: 'photo.png',
      mediaType: 'image/png',
      dataBase64: Buffer.from('<script>alert(1)</script>').toString('base64'),
    });
    expect(disguised.status).toBe(415);
    expect(disguised.body.error).toBe('UNSUPPORTED_MEDIA');
    const html = await ctx.send('POST', `/api/jobs/${job.id}/evidence`, owner, {
      fileName: 'page.html',
      mediaType: 'text/html',
      dataBase64: Buffer.from('<html></html>').toString('base64'),
    });
    expect(html.status).toBe(400);
    const notBase64 = await ctx.send('POST', `/api/jobs/${job.id}/evidence`, owner, {
      fileName: 'photo.png',
      mediaType: 'image/png',
      dataBase64: 'not base64!',
    });
    expect(notBase64.status).toBe(400);
    // Over the 6 MiB decoded limit but inside the route's body limit: schema rejects it.
    const big = Buffer.alloc(6 * 1024 * 1024 + 3, 0);
    PNG.copy(big);
    const tooBig = await ctx.send('POST', `/api/jobs/${job.id}/evidence`, owner, {
      fileName: 'big.png',
      mediaType: 'image/png',
      dataBase64: big.toString('base64'),
    });
    expect(tooBig.status).toBe(400);
    // Beyond the route's body limit: refused before parsing.
    const huge = await ctx.send('POST', `/api/jobs/${job.id}/evidence`, owner, {
      fileName: 'huge.png',
      mediaType: 'image/png',
      dataBase64: 'A'.repeat(9 * 1024 * 1024),
    });
    expect(huge.status).toBe(413);
    // Other routes keep the 64 KiB default.
    const longNote = await ctx.send('POST', `/api/jobs/${job.id}/notes`, owner, {
      text: 'x'.repeat(100_000),
    });
    expect(longNote.status).toBe(413);
    const after = await ctx.db.pool.query('SELECT count(*)::int AS n FROM documents');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('records the assistant enquiry, quote draft and approval on the job timeline', async () => {
    const drafted = await ctx.send('POST', '/api/enquiries', owner, {
      text: 'Mrs Johnson needs two power points replaced.',
      customerId: margaret,
    });
    expect(drafted.status).toBe(201);
    const site = (await ctx.get(`/api/customers/${margaret}`, owner)).body.properties[0];
    const detail = (await ctx.get(`/api/jobs/${drafted.body.jobId}`, owner)).body;
    // Margaret has exactly one active property, so the assistant's job is linked to it.
    expect(detail.job.propertyId).toBe(site.id);
    expect(detail.job.siteAddress).toBe(site.address);
    const approved = await ctx.send('POST', `/api/quotes/${drafted.body.quoteId}/approve`, owner, {
      version: 1,
    });
    expect(approved.status).toBe(200);
    const timeline = (await ctx.get(`/api/jobs/${drafted.body.jobId}`, owner)).body.timeline;
    expect(timeline.map((event: { type: string }) => event.type).reverse()).toEqual([
      'created',
      'note_added',
      'quote_drafted',
      'quote_approved',
    ]);
    expect(timeline[2]).toMatchObject({ actorType: 'agent' });
  });
});

describe('business data export', () => {
  let ctx: TestContext;
  let owner: string;
  beforeAll(async () => {
    ctx = await createTestContext({ seedTenantB: true });
    owner = await ctx.login();
    await ctx.db.pool.query(
      "INSERT INTO provider_connections(id,tenant_id,provider,status,encrypted_credentials,encryption_key_id) VALUES($1,$2,'test','connected',$3,'key-id-synthetic')",
      [randomUUID(), TENANT_A, Buffer.from('synthetic-credential-ciphertext')],
    );
  });
  afterAll(async () => ctx?.close());

  it('gives the owner a versioned bundle of this business only, without secrets', async () => {
    const response = await ctx.get('/api/export', owner);
    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toMatch(
      /attachment; filename="opentradie-export-/,
    );
    const bundle = response.body;
    expect(bundle).toMatchObject({
      format: 'opentradie-business-export',
      formatVersion: 1,
      schemaVersion: '0004_crm_job_cards.sql',
      tenantId: TENANT_A,
    });
    expect(Date.parse(bundle.generatedAt)).not.toBeNaN();
    for (const table of [
      'businesses',
      'users',
      'customers',
      'customer_contacts',
      'properties',
      'jobs',
      'job_notes',
      'job_events',
      'communications',
      'approved_rates',
      'knowledge_items',
      'audit_events',
    ])
      expect(bundle.tables[table].rows.length, table).toBeGreaterThan(0);
    expect(bundle.tables.customers.rows.map((c: { name: string }) => c.name)).toContain(
      'Mrs Johnson',
    );
    expect(bundle.tables.properties.rows[0]).toHaveProperty('address_line1');
    expect(bundle.counts.customers).toBe(4);

    const text = JSON.stringify(bundle.tables);
    expect(text).not.toContain(TENANT_B);
    expect(text).not.toContain('owner@other.test');
    expect(text).not.toMatch(/password_hash|scrypt\$|token_hash|encrypted_credentials/);
    expect(text).not.toContain('key-id-synthetic');
    expect(text).not.toContain(Buffer.from('synthetic-credential-ciphertext').toString('hex'));
    expect(bundle.tables).not.toHaveProperty('sessions');
    expect(bundle.tables).not.toHaveProperty('idempotency_records');
    expect(bundle.tables.users.columns).not.toContain('password_hash');
    expect(bundle.tables.provider_connections.rows).toHaveLength(1);
    expect(bundle.tables.provider_connections.columns).not.toContain('encrypted_credentials');

    const audit = (await ctx.get('/api/audit-events', owner)).body.auditEvents;
    expect(audit[0]).toMatchObject({ action: 'business.exported', entityType: 'business' });
  });

  it('refuses viewers and anonymous callers', async () => {
    const viewer = await ctx.db.pool.query("SELECT 1 FROM users WHERE role='viewer'");
    expect(viewer.rowCount).toBe(1);
    const session = await ctx.login('viewer');
    const denied = await ctx.get('/api/export', session);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('OWNER_REQUIRED');
    expect((await ctx.get('/api/export', '')).status).toBe(401);
  });
});
