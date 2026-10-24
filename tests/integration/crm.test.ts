import { randomUUID } from 'node:crypto';
import { dispatchOutbox, PostgresJobQueue } from '@opentradie/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAutomationTaskHandlers } from '../../apps/api/src/services/automations.js';
import { customerReferenceColumns } from '../../apps/api/src/services/crm.js';
import { invokeTool } from '../../apps/api/src/tools/gateway.js';
import { createTestContext, TENANT_A, TENANT_B, type TestContext } from '../helpers/app.js';

/** CRM: tags, duplicates and merge, customer reports (ADR 0034). */
describe('CRM: tags, duplicates, merge and reports', () => {
  let ctx: TestContext;
  let owner: string;
  let viewer: string;
  beforeAll(async () => {
    ctx = await createTestContext({ seedTenantB: true });
    owner = await ctx.login();
    viewer = await ctx.login('viewer');
  });
  afterAll(async () => ctx?.close());

  const customer = async (body: Record<string, unknown>) => {
    const created = await ctx.send('POST', '/api/customers', owner, body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.id as string;
  };
  const tag = async (name: string, colour = 'green') => {
    const created = await ctx.send('POST', '/api/tags', owner, { name, colour });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.id as string;
  };
  const job = async (customerId: string, title = 'Fix the heat pump') => {
    const created = await ctx.send('POST', '/api/jobs', owner, { customerId, title });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.id as string;
  };
  let invoiceSeq = 9000;
  /** An invoice inserted directly with known totals (statuses need their own columns). */
  const invoice = async (
    customerId: string,
    jobId: string,
    status: string,
    subtotal: number,
    issueDate: string,
    paid?: { cents: number; on: string },
  ) => {
    const id = randomUUID();
    const tax = Math.round(subtotal * 0.15);
    await ctx.db.pool.query(
      `INSERT INTO invoices(id,tenant_id,invoice_number,customer_id,job_id,status,issue_date,due_date,currency,
         gst_registered,prices_entered,tax_basis_points,subtotal_cents,tax_cents,total_cents,
         approved_by,approved_at,voided_by,voided_at,accounting_provider,external_invoice_id,posted_at,amount_paid_cents)
       SELECT $1::uuid,$2,$3,$4,$5,$6::text,$7::date,$7::date + 20,'NZD',true,'exclusive',1500,$8::bigint,$9::bigint,$8::bigint + $9::bigint,
         CASE WHEN $6 NOT IN ('draft','void') THEN u.id END, CASE WHEN $6 NOT IN ('draft','void') THEN now() END,
         CASE WHEN $6 = 'void' THEN u.id END, CASE WHEN $6 = 'void' THEN now() END,
         CASE WHEN $6 IN ('posted','paid','part_paid') THEN 'test' END,
         CASE WHEN $6 IN ('posted','paid','part_paid') THEN 'ext-' || $1::uuid::text END,
         CASE WHEN $6 IN ('posted','paid','part_paid') THEN now() END,
         $10::bigint
       FROM users u WHERE u.tenant_id=$2 AND u.role='owner' LIMIT 1`,
      [
        id,
        TENANT_A,
        `INV-${invoiceSeq++}`,
        customerId,
        jobId,
        status,
        issueDate,
        subtotal,
        tax,
        paid?.cents ?? (status === 'paid' ? subtotal + tax : null),
      ],
    );
    if (paid)
      await ctx.db.pool.query(
        `INSERT INTO payment_snapshots(id,tenant_id,invoice_id,provider,external_invoice_id,provider_status,total_cents,amount_paid_cents,amount_due_cents,fetched_at)
         VALUES($1,$2,$3,'test',$4,$5,$6,$7,$8,($9::date + time '12:00') AT TIME ZONE 'Pacific/Auckland')`,
        [
          randomUUID(),
          TENANT_A,
          id,
          `ext-${id}`,
          paid.cents >= subtotal + tax ? 'paid' : 'authorised',
          subtotal + tax,
          paid.cents,
          subtotal + tax - paid.cents,
          paid.on,
        ],
      );
    return id;
  };

  it('tags: CRUD, assign, filter, viewer read-only, tenancy and audit', async () => {
    const vip = await tag('  VIP ');
    expect((await ctx.get('/api/tags', viewer)).body.tags.map((t: any) => t.name)).toContain('vip');
    expect((await ctx.send('POST', '/api/tags', owner, { name: 'vip' })).status).toBe(409);
    expect((await ctx.send('POST', '/api/tags', owner, { name: 'x', colour: 'neon' })).status).toBe(
      400,
    );
    expect((await ctx.send('POST', '/api/tags', viewer, { name: 'nope' })).status).toBe(403);
    const commercial = await tag('Commercial', 'blue');
    const aroha = await customer({ name: 'Aroha Tags', email: 'aroha.tags@example.test' });
    const put = await ctx.send('PUT', `/api/customers/${aroha}/tags`, owner, {
      tagIds: [vip, commercial],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.tags.map((t: any) => t.name)).toEqual(['commercial', 'vip']);
    expect(
      (await ctx.send('PUT', `/api/customers/${aroha}/tags`, viewer, { tagIds: [] })).status,
    ).toBe(403);
    expect(
      (await ctx.send('PUT', `/api/customers/${aroha}/tags`, owner, { tagIds: [randomUUID()] }))
        .status,
    ).toBe(404);
    const filtered = await ctx.get('/api/customers?tag=VIP', viewer);
    expect(filtered.body.customers.map((c: any) => c.id)).toEqual([aroha]);
    const renamed = await ctx.send('PATCH', `/api/tags/${commercial}`, owner, { name: 'Business' });
    expect(renamed.body).toMatchObject({ name: 'business', colour: 'blue', customerCount: 1 });
    const deleted = await ctx.send('DELETE', `/api/tags/${commercial}`, owner);
    expect(deleted.body).toEqual({ deleted: true, removedFrom: 1 });
    expect((await ctx.get(`/api/customers/${aroha}`, owner)).body.customer.tags).toHaveLength(1);
    const actions = (
      await ctx.get(`/api/audit-events?entityId=${aroha}`, owner)
    ).body.auditEvents.map((event: any) => event.action);
    expect(actions).toContain('customer.tags_updated');
    // Tenant B cannot see or use tenant A's tag.
    const loginB = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ctx.config.appOrigin },
      payload: { email: 'owner@other.test', password: 'other-owner-password' },
    });
    // Tenant B's owner signs in to its own runtime only; a direct cross-tenant assignment is refused by FKs.
    expect(loginB.statusCode).toBe(401);
    const otherCustomer = (
      await ctx.db.pool.query('SELECT id FROM customers WHERE tenant_id=$1 LIMIT 1', [TENANT_B])
    ).rows[0].id;
    await expect(
      ctx.db.pool.query(
        'INSERT INTO customer_tags(tenant_id,customer_id,tag_id) VALUES($1,$2,$3)',
        [TENANT_B, otherCustomer, vip],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('tags are exported and erasure removes the assignments but keeps the tag', async () => {
    const quiet = await tag('no-marketing', 'red');
    const id = await customer({ name: 'Erin Erase' });
    await ctx.send('PUT', `/api/customers/${id}/tags`, owner, { tagIds: [quiet] });
    const exported = await ctx.get(`/api/customers/${id}/export`, owner);
    expect(exported.status).toBe(200);
    expect(exported.body.tables.customer_tags.rows).toHaveLength(1);
    expect(exported.body.tables.tags.rows[0]).toMatchObject({ name: 'no-marketing' });
    const business = await ctx.get('/api/export', owner);
    expect(business.body.tables.tags.rows.map((row: any) => row.name)).toContain('no-marketing');
    expect(business.body.tables.customer_tags.rows.length).toBeGreaterThan(0);
    const erased = await ctx.send('POST', `/api/customers/${id}/erase`, owner, {
      confirmName: 'Erin Erase',
    });
    expect(erased.status, JSON.stringify(erased.body)).toBe(200);
    expect(
      (await ctx.db.pool.query('SELECT 1 FROM customer_tags WHERE customer_id=$1', [id])).rowCount,
    ).toBe(0);
    expect((await ctx.get('/api/tags', owner)).body.tags.map((t: any) => t.name)).toContain(
      'no-marketing',
    );
  });

  it('automation condition on customer tags fires only for tagged customers', async () => {
    const queue = new PostgresJobQueue(ctx.db);
    const handlers = createAutomationTaskHandlers({ db: ctx.db, queue, now: () => new Date() });
    const drain = async () => {
      for (let i = 0; i < 10; i += 1) {
        const dispatched = await dispatchOutbox(ctx.db, queue);
        const processed = await queue.runOnce('crm-test', handlers);
        if (!dispatched && !processed) return;
      }
    };
    await drain();
    const created = await ctx.send('POST', '/api/automations', owner, {
      enabled: true,
      definition: {
        name: 'VIP follow-up',
        trigger: {
          event: 'job.completed',
          filter: { field: 'customer.tags', op: 'contains', value: 'VIP' },
        },
        actions: [{ tool: 'job.add_note', text: 'VIP job done' }],
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.automation.summary).toContain('the customer is tagged "vip"');
    const vip = (await ctx.get('/api/tags', owner)).body.tags.find((t: any) => t.name === 'vip').id;
    const tagged = await customer({ name: 'Tama Tagged' });
    const plain = await customer({ name: 'Pita Plain' });
    await ctx.send('PUT', `/api/customers/${tagged}/tags`, owner, { tagIds: [vip] });
    const complete = async (customerId: string) => {
      const id = await job(customerId);
      for (const status of ['in_progress', 'completed'])
        expect((await ctx.send('PATCH', `/api/jobs/${id}`, owner, { status })).status).toBe(200);
      await drain();
      return id;
    };
    const taggedJob = await complete(tagged);
    const plainJob = await complete(plain);
    const runs = await ctx.db.pool.query<{ job_id: string }>(
      'SELECT job_id FROM automation_runs WHERE tenant_id=$1 AND automation_id=$2',
      [TENANT_A, created.body.automation.id],
    );
    expect(runs.rows.map((row) => row.job_id)).toEqual([taggedJob]);
    expect(runs.rows.map((row) => row.job_id)).not.toContain(plainJob);
  });

  it('agent customer.tag proposal tags on approval; customer.get context includes tags', async () => {
    const id = await customer({ name: 'Agent Tagged' });
    const proposed = await invokeTool(ctx.db, {
      tenantId: TENANT_A,
      requestId: randomUUID(),
      sessionId: null,
      name: 'customer.tag',
      args: { customerId: id, add: ['Repeat'] },
      origin: { source: 'agent', sourceRef: 'session', createdByType: 'agent' },
    });
    expect(proposed.ok, JSON.stringify(proposed)).toBe(true);
    const proposalId = (proposed as unknown as { data: { proposalId: string } }).data.proposalId;
    // Owner approval by default: nothing changes until approved.
    expect((await ctx.get(`/api/customers/${id}`, owner)).body.customer.tags).toEqual([]);
    const approved = await ctx.send('POST', `/api/proposals/${proposalId}/approve`, owner, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(
      (await ctx.get(`/api/customers/${id}`, owner)).body.customer.tags.map((t: any) => t.name),
    ).toEqual(['repeat']);
    const context = await invokeTool(ctx.db, {
      tenantId: TENANT_A,
      requestId: randomUUID(),
      sessionId: null,
      name: 'customer.get',
      args: { customerId: id },
      origin: { source: 'agent', sourceRef: 'session', createdByType: 'agent' },
    });
    expect(JSON.stringify(context)).toContain('"tags":["repeat"]');
  });

  describe('duplicates and merge', () => {
    let survivor: string;
    let duplicate: string;
    let duplicateJob: string;
    beforeAll(async () => {
      survivor = await customer({
        name: 'Kiri Walker',
        email: 'kiri.walker@example.test',
        phone: '+64 21 555 0101',
      });
      duplicate = await customer({ name: 'K. Walker', phone: '021 555 0101' });
      for (const [id, line] of [
        [survivor, '12 Kauri Street'],
        [duplicate, '12 Kauri St'],
        [duplicate, '7 Rimu Road'],
      ] as const)
        expect(
          (
            await ctx.send('POST', `/api/customers/${id}/properties`, owner, {
              addressLine1: line,
              city: 'Hamilton',
            })
          ).status,
        ).toBe(201);
      expect(
        (await ctx.send('POST', `/api/customers/${duplicate}/contacts`, owner, { name: 'Partner' }))
          .status,
      ).toBe(201);
      duplicateJob = await job(duplicate, 'Old job under the duplicate');
      expect(
        (await ctx.send('POST', '/api/tasks', owner, { title: 'Call K', customerId: duplicate }))
          .status,
      ).toBe(201);
      const tags = (await ctx.get('/api/tags', owner)).body.tags;
      await ctx.send('PUT', `/api/customers/${duplicate}/tags`, owner, {
        tagIds: [tags.find((t: any) => t.name === 'vip').id],
      });
      await invoice(duplicate, duplicateJob, 'posted', 10_000, '2026-05-01');
      await ctx.db.pool.query(
        `INSERT INTO external_references(tenant_id,provider,entity_type,entity_id,external_id) VALUES($1,'xero','contact',$2,'xero-contact-1')`,
        [TENANT_A, duplicate],
      );
    });

    it('lists the pair with reasons; "not a duplicate" hides it', async () => {
      const pairs = (await ctx.get('/api/customers/duplicates', viewer)).body.pairs;
      const pair = pairs.find((p: any) =>
        p.customers.every((c: any) => [survivor, duplicate].includes(c.id)),
      );
      expect(pair.reasons).toContain('phone');
      // A dismissed pair disappears (using a throwaway look-alike so the merge pair stays).
      const twin = await customer({ name: 'Kiri Twin', phone: '0215550101' });
      expect(
        (
          await ctx.send('POST', `/api/customers/${twin}/not-duplicate`, viewer, {
            otherId: survivor,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await ctx.send('POST', `/api/customers/${twin}/not-duplicate`, owner, {
            otherId: survivor,
          })
        ).status,
      ).toBe(200);
      const after = (await ctx.get('/api/customers/duplicates', owner)).body.pairs;
      const has = (a: string, b: string) =>
        after.some((p: any) => p.customers.every((c: any) => [a, b].includes(c.id)));
      expect(has(twin, survivor)).toBe(false);
      expect(has(twin, duplicate)).toBe(true);
      await ctx.send('POST', `/api/customers/${twin}/not-duplicate`, owner, { otherId: duplicate });
    });

    it('preview counts what moves and warns about the accounting contact', async () => {
      const preview = await ctx.get(
        `/api/customers/${duplicate}/merge-preview?into=${survivor}`,
        viewer,
      );
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      expect(preview.body.moves).toMatchObject({
        jobs: 1,
        invoices: 1,
        properties: 2,
        customer_contacts: 1,
        tasks: 1,
      });
      expect(preview.body.duplicatePropertiesArchived).toBe(1);
      expect(preview.body.warnings.map((w: any) => w.code)).toEqual([
        'ACCOUNTING_CONTACT_NOT_MERGED',
        'POSTED_INVOICES',
      ]);
    });

    it('refuses bad merges: viewer, self, wrong confirmation, archived target, other tenant', async () => {
      const merge = (id: string, body: Record<string, unknown>, who = owner) =>
        ctx.send('POST', `/api/customers/${id}/merge`, who, body);
      expect(
        (await merge(duplicate, { intoId: survivor, confirm: 'Kiri Walker' }, viewer)).status,
      ).toBe(403);
      expect((await merge(duplicate, { intoId: duplicate, confirm: 'K. Walker' })).body.error).toBe(
        'MERGE_INTO_SELF',
      );
      expect((await merge(duplicate, { intoId: survivor, confirm: 'Kiri' })).body.error).toBe(
        'CONFIRMATION_MISMATCH',
      );
      const archived = await customer({ name: 'Gone Customer' });
      await ctx.send('DELETE', `/api/customers/${archived}`, owner);
      expect(
        (await merge(duplicate, { intoId: archived, confirm: 'Gone Customer' })).body.error,
      ).toBe('MERGE_TARGET_INVALID');
      const other = (
        await ctx.db.pool.query('SELECT id,name FROM customers WHERE tenant_id=$1 LIMIT 1', [
          TENANT_B,
        ])
      ).rows[0];
      expect((await merge(duplicate, { intoId: other.id, confirm: other.name })).status).toBe(404);
    });

    it('merges everything in one transaction, idempotently; old links resolve', async () => {
      const key = randomUUID();
      const body = { intoId: survivor, confirm: '  kiri walker ' };
      const merged = await ctx.send('POST', `/api/customers/${duplicate}/merge`, owner, body, {
        key,
      });
      expect(merged.status, JSON.stringify(merged.body)).toBe(200);
      expect(merged.body).toMatchObject({ merged: true, alreadyMerged: false });
      // Replay with the same key returns the same response; a new key is a no-op.
      expect(
        (await ctx.send('POST', `/api/customers/${duplicate}/merge`, owner, body, { key })).body,
      ).toEqual(merged.body);
      expect(
        (await ctx.send('POST', `/api/customers/${duplicate}/merge`, owner, body)).body
          .alreadyMerged,
      ).toBe(true);

      // Catalogue sweep: nothing but the merged customer row itself still references it.
      const refs = await customerReferenceColumns(ctx.db.pool);
      expect(refs.length).toBeGreaterThan(12);
      const schemaRefs = await ctx.db.pool.query<{ table_name: string; column_name: string }>(
        `SELECT kcu.table_name, kcu.column_name FROM information_schema.referential_constraints rc
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name AND kcu.constraint_schema = rc.constraint_schema
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = rc.unique_constraint_name AND ccu.constraint_schema = rc.unique_constraint_schema
         WHERE ccu.table_name = 'customers' AND kcu.column_name <> 'tenant_id'
         GROUP BY 1, 2`,
      );
      const stale: string[] = [];
      for (const { table_name, column_name } of schemaRefs.rows) {
        const count = await ctx.db.pool.query(
          `SELECT count(*)::int AS n FROM "${table_name}" WHERE "${column_name}" = $1`,
          [duplicate],
        );
        if (count.rows[0].n) stale.push(`${table_name}.${column_name}`);
      }
      expect(stale).toEqual([]);

      const old = (await ctx.get(`/api/customers/${duplicate}`, owner)).body.customer;
      expect(old).toMatchObject({ archived: true, mergedIntoId: survivor });
      const profile = (await ctx.get(`/api/customers/${survivor}`, owner)).body;
      expect(profile.jobs.map((j: any) => j.id)).toContain(duplicateJob);
      expect(profile.customer.tags.map((t: any) => t.name)).toContain('vip');
      expect(profile.properties.filter((p: any) => !p.archived)).toHaveLength(2);
      const jobBody = (await ctx.get(`/api/jobs/${duplicateJob}`, owner)).body;
      expect(jobBody.job?.customerId ?? jobBody.customerId).toBe(survivor);
      // Accounting mapping is kept for the old contact.
      expect(
        (
          await ctx.db.pool.query(
            "SELECT 1 FROM external_references WHERE entity_type='contact' AND entity_id=$1",
            [duplicate],
          )
        ).rowCount,
      ).toBe(1);
      const audit = (await ctx.get(`/api/audit-events?entityId=${survivor}`, owner)).body
        .auditEvents;
      expect(audit.map((event: any) => event.action)).toContain('customer.merged');
      // A merged customer cannot be a target and cannot be merged elsewhere.
      const third = await customer({ name: 'Third Party' });
      expect(
        (
          await ctx.send('POST', `/api/customers/${third}/merge`, owner, {
            intoId: duplicate,
            confirm: 'K. Walker',
          })
        ).body.error,
      ).toBe('MERGE_TARGET_INVALID');
      expect(
        (
          await ctx.send('POST', `/api/customers/${duplicate}/merge`, owner, {
            intoId: third,
            confirm: 'Third Party',
          })
        ).body.error,
      ).toBe('ALREADY_MERGED');
    });
  });

  it('customer report matches a seeded fixture (cents, GST, statuses, NZ financial year)', async () => {
    const a = await customer({ name: 'Report Alpha' });
    const b = await customer({ name: 'Report Beta' });
    const jobA1 = await job(a);
    const jobA2 = await job(a);
    const jobB = await job(b);
    await ctx.db.pool.query(
      `UPDATE jobs SET created_at = CASE id WHEN $1 THEN timestamptz '2031-03-31 00:00+13' WHEN $2 THEN timestamptz '2031-04-02 00:00+12' ELSE timestamptz '2031-06-01 00:00+12' END WHERE id = ANY($3::uuid[])`,
      [jobA1, jobA2, [jobA1, jobA2, jobB]],
    );
    await invoice(a, jobA2, 'paid', 100_000, '2031-04-10', { cents: 115_000, on: '2031-04-20' });
    await invoice(a, jobA2, 'posted', 20_000, '2031-05-01', { cents: 10_000, on: '2031-05-05' });
    await invoice(a, jobA2, 'draft', 50_000, '2031-05-01');
    await invoice(a, jobA2, 'void', 70_000, '2031-05-01');
    await invoice(b, jobB, 'approved', 40_000, '2031-06-02');
    await invoice(b, jobB, 'approved', 40_000, '2032-04-01');
    const report = await ctx.get('/api/reports/customers?from=2031-04-01&to=2032-03-31', viewer);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const rows = report.body.rows.filter((row: any) => [a, b].includes(row.customerId));
    expect(rows).toEqual([
      expect.objectContaining({
        customerId: a,
        jobs: 1,
        invoicedExclCents: 120_000,
        invoicedGstCents: 18_000,
        invoicedInclCents: 138_000,
        paidCents: 125_000,
        outstandingCents: 13_000,
        firstJobDate: '2031-03-31',
        lastJobDate: '2031-04-02',
        repeat: true,
      }),
      expect.objectContaining({
        customerId: b,
        jobs: 1,
        invoicedInclCents: 46_000,
        paidCents: 0,
        outstandingCents: 46_000,
        repeat: false,
      }),
    ]);
    expect(report.body.summary).toMatchObject({
      invoicedInclCents: 184_000,
      averageDaysToPay: 10,
      newCustomers: 1,
      repeatCustomers: 1,
    });
    expect(report.body.summary.topCustomers[0].customerId).toBe(a);
    const csv = await ctx.get(
      '/api/reports/customers?from=2031-04-01&to=2032-03-31&format=csv',
      viewer,
    );
    expect(String(csv.headers['content-type'])).toMatch(/text\/csv/);
    expect(csv.body).toContain(
      'Report Alpha,1,0,0,,1200.00,180.00,1380.00,1250.00,130.00,2031-03-31,2031-04-02,yes',
    );
    expect(
      (await ctx.get('/api/reports/customers?from=2032-01-01&to=2031-01-01', owner)).status,
    ).toBe(422);
    expect(
      (await ctx.get('/api/reports/customers?period=this_financial_year', owner)).body.range.from,
    ).toMatch(/-04-01$/);
  });
});
