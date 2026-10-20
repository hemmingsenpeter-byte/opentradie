import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  customerId,
  TENANT_A,
  TENANT_B,
  type TestContext,
} from '../helpers/app.js';

const SHA = 'a'.repeat(64);

describe('per-customer export and erasure (ADR 0025)', () => {
  let ctx: TestContext;
  let owner: string;
  let margaret: string;
  let jobId: string;
  let photoKey: string;
  let audioKey: string;
  let invoiceId: string;

  beforeAll(async () => {
    ctx = await createTestContext({ seedTenantB: true });
    owner = await ctx.login();
    margaret = await customerId(ctx.db, 'Mrs Johnson');
    const pool = ctx.db.pool;
    jobId = (
      await pool.query<{ id: string }>(
        'SELECT id FROM jobs WHERE tenant_id=$1 AND customer_id=$2 ORDER BY created_at LIMIT 1',
        [TENANT_A, margaret],
      )
    ).rows[0]!.id;
    const ownerId = (
      await pool.query<{ id: string }>("SELECT id FROM users WHERE tenant_id=$1 AND role='owner'", [
        TENANT_A,
      ])
    ).rows[0]!.id;
    expect(
      (
        await ctx.send('POST', `/api/jobs/${jobId}/notes`, owner, {
          text: 'Margaret says the dog is called Biscuit; gate code 4321.',
        })
      ).status,
    ).toBe(201);

    photoKey = `${TENANT_A}/photos/${randomUUID()}.jpg`;
    audioKey = `${TENANT_A}/voice/${randomUUID()}.webm`;
    await ctx.fileStore.put(photoKey, Buffer.from('synthetic photo'), {
      contentType: 'image/jpeg',
    });
    await ctx.fileStore.put(audioKey, Buffer.from('synthetic audio'), {
      contentType: 'audio/webm',
    });
    await pool.query(
      "INSERT INTO documents(id,tenant_id,customer_id,job_id,kind,storage_key,file_name,media_type,size_bytes,sha256) VALUES($1,$2,$3,$4,'photo',$5,'johnson-lounge.jpg','image/jpeg',15,$6)",
      [randomUUID(), TENANT_A, margaret, jobId, photoKey, SHA],
    );
    const audioDoc = randomUUID();
    await pool.query(
      "INSERT INTO documents(id,tenant_id,kind,storage_key,file_name,media_type,size_bytes,sha256) VALUES($1,$2,'other',$3,'voice.webm','audio/webm',15,$4)",
      [audioDoc, TENANT_A, audioKey, SHA],
    );
    await pool.query(
      "INSERT INTO voice_notes(id,tenant_id,uploaded_by,document_id,media_type,size_bytes,status,transcript,resolved_customer_id,resolution_status) VALUES($1,$2,$3,$4,'audio/webm',15,'transcribed','Two hours at Margaret Johnson''s on Kauri Street',$5,'matched')",
      [randomUUID(), TENANT_A, ownerId, audioDoc, margaret],
    );
    invoiceId = randomUUID();
    await pool.query(
      `INSERT INTO invoices(id,tenant_id,invoice_number,customer_id,job_id,issue_date,due_date,currency,gst_registered,prices_entered,tax_basis_points,subtotal_cents,tax_cents,total_cents,notes)
       VALUES($1,$2,'INV-0900',$3,$4,'2026-10-20','2026-11-09','NZD',true,'exclusive',1500,10000,1500,11500,'Ask Margaret about the side gate')`,
      [invoiceId, TENANT_A, margaret, jobId],
    );
  });
  afterAll(async () => ctx?.close());

  it('exports one customer only, without other customers, tenants or secrets', async () => {
    const response = await ctx.get(`/api/customers/${margaret}/export`, owner);
    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toMatch(/opentradie-customer-/);
    const bundle = response.body;
    expect(bundle).toMatchObject({
      format: 'opentradie-customer-export',
      formatVersion: 1,
      customerId: margaret,
    });
    expect(bundle.tables.customers.rows).toHaveLength(1);
    expect(bundle.tables.customers.rows[0]).toMatchObject({ name: 'Mrs Johnson' });
    for (const table of [
      'customer_contacts',
      'properties',
      'jobs',
      'job_notes',
      'job_events',
      'communications',
      'documents',
      'voice_notes',
      'invoices',
    ])
      expect(bundle.tables[table].rows.length, table).toBeGreaterThan(0);
    expect(bundle.tables.voice_notes.rows[0].transcript).toContain('Kauri Street');
    expect(bundle.tables.documents.rows.map((d: { sha256: string }) => d.sha256)).toContain(SHA);
    const text = JSON.stringify(bundle.tables);
    expect(text).not.toContain('Aroha Ngata');
    expect(text).not.toContain('helen.johnson@example.test');
    expect(text).not.toContain(TENANT_B);
    expect(text).not.toMatch(/password_hash|token_hash|encrypted_credentials|search_vector/);
    expect(bundle.tables).not.toHaveProperty('quote_acceptance_tokens');
    const audit = (await ctx.get('/api/audit-events', owner)).body.auditEvents;
    expect(audit[0]).toMatchObject({ action: 'customer.exported', entityType: 'customer' });
  });

  it('refuses viewers, and hides other tenants', async () => {
    const viewer = await ctx.login('viewer');
    expect((await ctx.get(`/api/customers/${margaret}/export`, viewer)).status).toBe(403);
    expect(
      (await ctx.send('POST', `/api/customers/${margaret}/erase`, viewer, { confirmName: 'x' }))
        .status,
    ).toBe(403);
    const foreign = (
      await ctx.db.pool.query<{ id: string }>(
        'SELECT id FROM customers WHERE tenant_id=$1 LIMIT 1',
        [TENANT_B],
      )
    ).rows[0]!.id;
    expect((await ctx.get(`/api/customers/${foreign}/export`, owner)).status).toBe(404);
    const erase = await ctx.send('POST', `/api/customers/${foreign}/erase`, owner, {
      confirmName: 'anything',
    });
    expect(erase.status).toBe(404);
  });

  it('requires the exact customer name as confirmation', async () => {
    const wrong = await ctx.send('POST', `/api/customers/${margaret}/erase`, owner, {
      confirmName: 'Helen Johnson',
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error).toBe('CONFIRMATION_MISMATCH');
    const still = await ctx.db.pool.query('SELECT name FROM customers WHERE id=$1', [margaret]);
    expect(still.rows[0].name).toBe('Mrs Johnson');
  });

  it('keeps job_events append-only outside the erasure path', async () => {
    const pool = ctx.db.pool;
    await expect(
      pool.query("UPDATE job_events SET summary='changed' WHERE tenant_id=$1", [TENANT_A]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query('DELETE FROM job_events WHERE tenant_id=$1', [TENANT_A]),
    ).rejects.toThrow(/append-only/);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('opentradie.erasure','on',true)");
      // The flag only permits the fixed redaction values, never arbitrary edits.
      await expect(
        client.query("UPDATE job_events SET summary='rewritten history' WHERE tenant_id=$1", [
          TENANT_A,
        ]),
      ).rejects.toThrow(/append-only/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('erases personal data, deletes files, keeps invoice totals, and is idempotent', async () => {
    const erase = await ctx.send('POST', `/api/customers/${margaret}/erase`, owner, {
      confirmName: 'Mrs Johnson',
    });
    expect(erase.status).toBe(200);
    expect(erase.body).toMatchObject({ customerId: margaret, alreadyErased: false });
    const pool = ctx.db.pool;
    const customer = (await pool.query('SELECT * FROM customers WHERE id=$1', [margaret])).rows[0];
    expect(customer).toMatchObject({
      email: null,
      phone: null,
      address: null,
      preferred_name: null,
    });
    expect(customer.name).toBe(`Erased customer ${margaret.slice(0, 8)}`);
    expect(customer.erased_at).not.toBeNull();
    expect(
      (await pool.query('SELECT 1 FROM customer_contacts WHERE customer_id=$1', [margaret]))
        .rowCount,
    ).toBe(0);
    const properties = await pool.query(
      'SELECT address_line1,suburb,city,postcode,access_notes FROM properties WHERE customer_id=$1',
      [margaret],
    );
    for (const row of properties.rows)
      expect(row).toEqual({
        address_line1: '[erased]',
        suburb: null,
        city: null,
        postcode: null,
        access_notes: null,
      });
    expect(await ctx.fileStore.exists(photoKey)).toBe(false);
    expect(await ctx.fileStore.exists(audioKey)).toBe(false);
    const voice = await pool.query(
      'SELECT transcript FROM voice_notes WHERE resolved_customer_id=$1',
      [margaret],
    );
    expect(voice.rows[0].transcript).toBeNull();
    const invoice = (await pool.query('SELECT * FROM invoices WHERE id=$1', [invoiceId])).rows[0];
    expect(invoice).toMatchObject({ total_cents: 11500, tax_cents: 1500, notes: null });

    const after = (await ctx.get(`/api/customers/${margaret}/export`, owner)).body;
    const text = JSON.stringify(after.tables);
    for (const personal of [
      'Johnson',
      'Margaret',
      'margaret.johnson@example.test',
      '555 0101',
      'Kauri',
      'Biscuit',
      'Lounge power points',
      'johnson-lounge.jpg',
    ])
      expect(text, personal).not.toContain(personal);
    for (const event of after.tables.job_events.rows)
      expect(event).toMatchObject({ metadata: { erased: true } });
    // The audit row records counts only.
    const audit = await pool.query(
      "SELECT metadata FROM audit_events WHERE action='customer.erased' AND entity_id=$1",
      [margaret],
    );
    expect(audit.rowCount).toBe(1);
    expect(JSON.stringify(audit.rows[0].metadata)).not.toContain('Johnson');

    const again = await ctx.send('POST', `/api/customers/${margaret}/erase`, owner, {
      confirmName: 'Mrs Johnson',
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyErased: true });
    expect(
      (
        await pool.query(
          "SELECT 1 FROM audit_events WHERE action='customer.erased' AND entity_id=$1",
          [margaret],
        )
      ).rowCount,
    ).toBe(1);
    // Other customers are untouched.
    const aroha = await pool.query(
      "SELECT email FROM customers WHERE name='Aroha Ngata' AND tenant_id=$1",
      [TENANT_A],
    );
    expect(aroha.rows[0].email).toBe('aroha.ngata@example.test');
  });
});
