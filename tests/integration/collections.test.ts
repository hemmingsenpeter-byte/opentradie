import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockAgentRuntime } from '@opentradie/agent';
import { FakeMailAdapter, fakeMailConnections } from '@opentradie/integrations/mail';
import { PostgresJobQueue } from '@opentradie/platform';
import {
  createCollectionsTaskHandlers,
  scanCollections,
} from '../../apps/api/src/services/collections.js';
import { createInboxTaskHandlers } from '../../apps/api/src/services/inbox.js';
import { createTestContext, TENANT_A, TENANT_B, type TestContext } from '../helpers/app.js';

describe('unpaid invoice follow-ups (Workflow D)', () => {
  let ctx: TestContext;
  let owner: string;
  let viewer: string;
  let queue: PostgresJobQueue;
  let ownerId: string;
  const fake = new FakeMailAdapter();
  const mail = fakeMailConnections(fake);
  let seq = 9000;
  // 2026-03-01 due + 8 days (local NZ).
  let now = new Date('2026-03-09T00:00:00Z');
  const clock = () => now;

  const scan = () => scanCollections({ db: ctx.db, queue, mail, now: clock }, TENANT_A, 'test');
  async function runTasks() {
    const handlers = {
      ...createInboxTaskHandlers({
        db: ctx.db,
        runtime: new MockAgentRuntime(),
        config: ctx.config,
        mail,
      }),
      ...createCollectionsTaskHandlers({ db: ctx.db, queue, mail, now: clock }),
    };
    for (let i = 0; i < 10; i++) if ((await queue.runOnce('test-worker', handlers)) === 0) break;
  }
  const q = (sql: string, params: unknown[] = []) => ctx.db.pool.query(sql, params);

  async function postedInvoice(options: { dueDate?: string; email?: boolean } = {}) {
    const customerId = randomUUID();
    const jobId = randomUUID();
    await q('INSERT INTO customers(id,tenant_id,name,email) VALUES($1,$2,$3,$4)', [
      customerId,
      TENANT_A,
      'Mere Tane',
      options.email === false ? null : `mere.${seq}@customer.example.test`,
    ]);
    await q(
      "INSERT INTO jobs(id,tenant_id,customer_id,title,status) VALUES($1,$2,$3,'Rewire garage','completed')",
      [jobId, TENANT_A, customerId],
    );
    const id = randomUUID();
    seq += 1;
    await q(
      `INSERT INTO invoices(id,tenant_id,invoice_number,customer_id,job_id,status,issue_date,due_date,currency,gst_registered,
         prices_entered,tax_basis_points,subtotal_cents,tax_cents,total_cents,approved_by,approved_at,accounting_provider,
         external_invoice_id,posted_at)
       VALUES($1,$2,$3,$4,$5,'posted','2026-01-01',$6,'NZD',true,'exclusive',1500,100000,15000,115000,$7,now(),'test',$8,now())`,
      [
        id,
        TENANT_A,
        `INV-${seq}`,
        customerId,
        jobId,
        options.dueDate ?? '2026-03-01',
        ownerId,
        `ext-${seq}`,
      ],
    );
    return { id, customerId, jobId };
  }
  const reminders = async (invoiceId: string) =>
    (
      await q(
        "SELECT payload->>'stage' AS stage,status,status_reason,communication_id FROM reminders WHERE tenant_id=$1 AND subject_id=$2 ORDER BY created_at",
        [TENANT_A, invoiceId],
      )
    ).rows;
  const comm = async (id: string) =>
    (
      await q(
        'SELECT status,origin,subject,text,thread_id,to_addresses FROM communications WHERE id=$1',
        [id],
      )
    ).rows[0];

  beforeAll(async () => {
    ctx = await createTestContext({ seedTenantB: true, mail });
    queue = new PostgresJobQueue(ctx.db, { baseRetryDelayMs: 0 });
    owner = await ctx.login('owner');
    viewer = await ctx.login('viewer');
    ownerId = (await q("SELECT id FROM users WHERE tenant_id=$1 AND role='owner'", [TENANT_A]))
      .rows[0].id;
  });
  afterAll(async () => ctx?.close());

  it('is off by default with approval required, and owner-only', async () => {
    const settings = await ctx.get('/api/settings/collections', owner);
    expect(settings.body).toMatchObject({
      enabled: false,
      overdue1Days: 7,
      overdue2Days: 14,
      overdueFinalDays: 30,
      autoSend: {
        pre_due_courtesy: false,
        overdue_1: false,
        overdue_2: false,
        overdue_final: false,
      },
    });
    expect((await ctx.get('/api/settings/collections', viewer)).status).toBe(403);
    expect(
      (await ctx.send('PATCH', '/api/settings/collections', viewer, { enabled: true })).status,
    ).toBe(403);
    const invoice = await postedInvoice();
    expect(await scan()).toMatchObject({ prepared: 0 });
    expect(await reminders(invoice.id)).toEqual([]);
    const bad = await ctx.send('PATCH', '/api/settings/collections', owner, { overdue2Days: 5 });
    expect(bad.status).toBe(422);
  });

  it('prepares exactly one draft per stage across repeated scans, approves, sends once and stops when paid', async () => {
    const enabled = await ctx.send('PATCH', '/api/settings/collections', owner, { enabled: true });
    expect(enabled.status).toBe(200);
    const audit = await q(
      "SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=$1 AND action='collections.settings_updated'",
      [TENANT_A],
    );
    expect(audit.rows[0].n).toBeGreaterThan(0);
    const invoice = await postedInvoice();
    await runTasks(); // the scan queued by enabling
    await scan();
    await scan();
    const rows = await reminders(invoice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stage: 'overdue_1',
      status: 'prepared',
      status_reason: 'awaiting_approval',
    });
    const draft = await comm(rows[0].communication_id);
    expect(draft).toMatchObject({ status: 'draft', origin: 'system' });
    expect(draft.thread_id).toBeTruthy();
    expect(draft.text).toContain('$1,150.00');
    expect(draft.text).toContain('8 days overdue');
    const history = await ctx.get(`/api/invoices/${invoice.id}/follow-ups`, viewer);
    expect(history.body.history).toHaveLength(1);
    const events = await q(
      "SELECT count(*)::int AS n FROM job_events WHERE job_id=$1 AND type='invoice_follow_up_prepared'",
      [invoice.jobId],
    );
    expect(events.rows[0].n).toBe(1);
    // The draft is in the inbox thread list.
    const threads = await ctx.get('/api/inbox/threads?filter=all', owner);
    expect(threads.body.threads.some((t: { id: string }) => t.id === draft.thread_id)).toBe(true);

    const before = fake.sent.length;
    const approved = await ctx.send(
      'POST',
      `/api/communications/${rows[0].communication_id}/approve-send`,
      owner,
      {},
    );
    expect(approved.status).toBe(202);
    await runTasks();
    await runTasks();
    expect(fake.sent.length).toBe(before + 1);

    // Paid per the ledger: the next stage is never prepared.
    await q(
      "UPDATE invoices SET status='paid',amount_paid_cents=115000,amount_due_cents=0 WHERE id=$1",
      [invoice.id],
    );
    now = new Date('2026-03-16T00:00:00Z');
    await scan();
    expect(await reminders(invoice.id)).toHaveLength(1);
    now = new Date('2026-03-09T00:00:00Z');
  });

  it('withdraws an approved follow-up when the invoice is paid before sending', async () => {
    const invoice = await postedInvoice();
    await scan();
    const [row] = await reminders(invoice.id);
    await ctx.send('POST', `/api/communications/${row.communication_id}/approve-send`, owner, {});
    await q(
      "UPDATE invoices SET status='paid',amount_paid_cents=115000,amount_due_cents=0 WHERE id=$1",
      [invoice.id],
    );
    const before = fake.sent.length;
    await runTasks();
    expect(fake.sent.length).toBe(before);
    expect((await comm(row.communication_id)).status).toBe('discarded');
    expect((await reminders(invoice.id))[0]).toMatchObject({
      status: 'suppressed',
      status_reason: 'paid',
    });
  });

  it('discards an unsent draft at the next scan once paid, and honours holds and erasure', async () => {
    const paidLater = await postedInvoice();
    await scan();
    await q(
      "UPDATE invoices SET status='part_paid',amount_paid_cents=115000,amount_due_cents=0 WHERE id=$1",
      [paidLater.id],
    );
    await q(
      "INSERT INTO payment_snapshots(id,tenant_id,invoice_id,provider,external_invoice_id,provider_status,total_cents,amount_paid_cents,amount_due_cents) VALUES($1,$2,$3,'test','x','authorised',115000,115000,0)",
      [randomUUID(), TENANT_A, paidLater.id],
    );
    await scan();
    expect((await reminders(paidLater.id))[0]).toMatchObject({
      status: 'suppressed',
      status_reason: 'nothing_due',
    });

    const held = await postedInvoice();
    expect(
      (await ctx.send('POST', `/api/invoices/${held.id}/collections-hold`, viewer, { hold: true }))
        .status,
    ).toBe(403);
    const otherJob = (
      await q('SELECT id, customer_id FROM jobs WHERE tenant_id=$1 LIMIT 1', [TENANT_B])
    ).rows[0];
    const foreign = randomUUID();
    await q(
      `INSERT INTO invoices(id,tenant_id,invoice_number,customer_id,job_id,issue_date,due_date,currency,gst_registered,prices_entered,tax_basis_points)
       VALUES($1,$2,'INV-0001',$3,$4,'2026-10-20','2026-11-09','NZD',true,'exclusive',1500)`,
      [foreign, TENANT_B, otherJob.customer_id, otherJob.id],
    );
    expect(
      (await ctx.send('POST', `/api/invoices/${foreign}/collections-hold`, owner, { hold: true }))
        .status,
    ).toBe(404);
    expect((await ctx.get(`/api/invoices/${foreign}/follow-ups`, owner)).status).toBe(404);
    const hold = await ctx.send('POST', `/api/invoices/${held.id}/collections-hold`, owner, {
      hold: true,
      reason: 'Disputed',
    });
    expect(hold.status).toBe(200);
    await scan();
    expect(await reminders(held.id)).toEqual([]);
    expect((await ctx.get(`/api/invoices/${held.id}/follow-ups`, owner)).body).toMatchObject({
      hold: true,
      next: { stage: 'none', reason: 'on_hold' },
    });

    const erased = await postedInvoice();
    await q('UPDATE customers SET erased_at=now() WHERE id=$1', [erased.customerId]);
    await scan();
    expect(await reminders(erased.id)).toEqual([]);
  });

  it('escalates to the owner without a customer message', async () => {
    const invoice = await postedInvoice({ dueDate: '2026-01-10' });
    await scan();
    expect(await reminders(invoice.id)).toEqual([
      expect.objectContaining({
        stage: 'escalate_owner',
        status: 'escalated',
        communication_id: null,
      }),
    ]);
  });

  it('auto-sends a stage the owner opted in to, at most once', async () => {
    await ctx.send('PATCH', '/api/settings/collections', owner, { autoSend: { overdue_1: true } });
    const invoice = await postedInvoice();
    const before = fake.sent.length;
    await scan();
    await scan();
    const [row] = await reminders(invoice.id);
    expect(row).toMatchObject({ status: 'prepared', status_reason: 'auto_send' });
    await runTasks();
    await runTasks();
    expect(fake.sent.length).toBe(before + 1);
    expect((await comm(row.communication_id)).status).toBe('sent');
    // payment.status (agent read tool) reports the stage read-only.
    const { runReadTool } = await import('../../apps/api/src/tools/read.js');
    const tool = await runReadTool(ctx.db.pool, TENANT_A, 'payment.status', {
      invoiceId: invoice.id,
    });
    expect((tool as { invoices: { followUp: unknown }[] }).invoices[0]!.followUp).toEqual({
      stage: 'overdue_1',
      status: 'prepared',
      onHold: false,
    });
  });
});
