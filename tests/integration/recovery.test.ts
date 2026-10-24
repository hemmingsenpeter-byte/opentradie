import { randomUUID } from 'node:crypto';
import { MockAgentRuntime } from '@opentradie/agent';
import {
  FakeMailAdapter,
  fakeMailConnections,
  type MailConnections,
} from '@opentradie/integrations/mail';
import {
  createTaskHandlers,
  dispatchOutbox,
  PostgresJobQueue,
  type Task,
  type TaskHandler,
} from '@opentradie/platform';
import type { FakeAccountingAdapter } from '@opentradie/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCollectionsTaskHandlers } from '../../apps/api/src/services/collections.js';
import { createInboxTaskHandlers } from '../../apps/api/src/services/inbox.js';
import {
  createTestContext,
  customerId,
  FAKE_ACCOUNTING_ENV,
  TENANT_A,
  type TestContext,
} from '../helpers/app.js';

/**
 * Worker crash recovery on the Postgres queue. A "crash" is a worker that leased a task with a
 * short lease, did part of the work, and died: it never calls complete() or fail(). The lease
 * expires and a healthy worker picks the task up again. Each durable task must then converge on
 * exactly one external effect.
 */
describe('worker crash recovery via lease expiry', () => {
  let ctx: TestContext;
  let owner: string;
  let queue: PostgresJobQueue;
  const mailFake = new FakeMailAdapter();
  const mail = fakeMailConnections(mailFake);
  const q = (sql: string, params: unknown[] = []) => ctx.db.pool.query(sql, params);

  /** Lease every ready task of `kinds` as a worker that dies mid-task, then let the lease lapse. */
  async function crash(kinds: string[], handlers: Record<string, TaskHandler>): Promise<number> {
    const tasks: Task[] = await queue.lease('crashed-worker', { kinds, leaseMs: 1 });
    for (const task of tasks) {
      // The handler throws (the simulated crash); the dead worker reports nothing.
      await handlers[task.kind]!(task, { db: ctx.db }).catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return tasks.length;
  }
  async function drain(handlers: Record<string, TaskHandler>) {
    for (let i = 0; i < 20; i++) {
      await dispatchOutbox(ctx.db, queue);
      if ((await queue.runOnce('healthy-worker', handlers)) === 0) break;
    }
  }
  const accountingHandlers = (adapter = ctx.accounting!.adapter) =>
    createTaskHandlers({
      queue,
      privacyMode: 'LOCAL_ONLY',
      embeddingProvider: null,
      accounting: { ...ctx.accounting!, adapter },
    });
  const inboxHandlers = (connections: MailConnections) => ({
    ...createInboxTaskHandlers({
      db: ctx.db,
      runtime: new MockAgentRuntime(),
      config: ctx.config,
      mail: connections,
    }),
    ...createCollectionsTaskHandlers({ db: ctx.db, queue, mail: connections }),
  });

  beforeAll(async () => {
    ctx = await createTestContext({ env: FAKE_ACCOUNTING_ENV, mail });
    owner = await ctx.login('owner');
    queue = new PostgresJobQueue(ctx.db, { baseRetryDelayMs: 0 });
    // Connect the fake ledger (mock OAuth round trip).
    const started = await ctx.get('/api/integrations/xero/connect', owner);
    const url = new URL(started.body.authorizeUrl);
    await ctx.app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
  });
  afterAll(async () => ctx?.close());

  async function approvedInvoice() {
    const enquiry = await ctx.send('POST', '/api/enquiries', owner, {
      text: 'Mrs Johnson needs two power points replaced. Check her existing information and prepare a quote.',
      customerId: await customerId(ctx.db, 'Mrs Johnson'),
    });
    const drafted = enquiry.body.quote;
    const approved = await ctx.send('POST', `/api/quotes/${drafted.id}/approve`, owner, {
      version: drafted.version,
    });
    const sent = await ctx.send('POST', `/api/quotes/${drafted.id}/send`, owner, {
      version: approved.body.version,
    });
    const token = new URL(sent.body.acceptanceUrl).pathname.split('/').at(-1)!;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/public/quotes/${token}/accept`,
      headers: { origin: ctx.config.appOrigin },
      payload: { name: 'Margaret Johnson' },
    });
    for (const status of ['in_progress', 'completed'])
      await ctx.send('PATCH', `/api/jobs/${drafted.jobId}`, owner, { status });
    const invoice = await ctx.send('POST', `/api/jobs/${drafted.jobId}/invoices`, owner, {});
    expect(invoice.status).toBe(201);
    const approvedInvoice = await ctx.send(
      'POST',
      `/api/invoices/${invoice.body.id}/approve`,
      owner,
      { version: invoice.body.version },
    );
    expect(approvedInvoice.status).toBe(200);
    return approvedInvoice.body as { id: string; invoiceNumber: string };
  }

  it('accounting.post_invoice: crash after the ledger accepted, before the local commit, links on retry', async () => {
    const fake = ctx.accounting!.adapter as FakeAccountingAdapter;
    const invoice = await approvedInvoice();
    await dispatchOutbox(ctx.db, queue);
    let creates = 0;
    const counting = new Proxy(fake, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          const result = await (value as (...a: unknown[]) => unknown).apply(target, args);
          if (property === 'createDraftInvoice') creates++;
          return result;
        };
      },
    });
    // Remote success, then the process dies before anything local is committed.
    const dying = new Proxy(counting, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== 'createDraftInvoice') return value;
        return async (...args: unknown[]) => {
          await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          throw new Error('simulated crash after remote success');
        };
      },
    });
    expect(await crash(['accounting.post_invoice'], accountingHandlers(dying))).toBe(1);
    expect(creates).toBe(1);
    await drain(accountingHandlers(counting));
    const status = await q('SELECT status,external_invoice_id FROM invoices WHERE id=$1', [
      invoice.id,
    ]);
    expect(status.rows[0]).toMatchObject({ status: 'posted' });
    expect(status.rows[0].external_invoice_id).toBeTruthy();
    expect(creates).toBe(1);
    const ledger = await fake.listInvoiceChangesSince(
      { tenantId: TENANT_A, organisationId: 'x' },
      new Date(0),
    );
    expect(ledger.filter((entry) => entry.reference === invoice.invoiceNumber)).toHaveLength(1);
    const attempts = await q(
      'SELECT status FROM accounting_sync_attempts WHERE tenant_id=$1 AND invoice_id=$2',
      [TENANT_A, invoice.id],
    );
    expect(attempts.rows.map((r) => r.status)).toContain('linked_existing');
  });

  it('inbox.send: crash after the provider accepted is never resent (SEND_OUTCOME_UNKNOWN)', async () => {
    const pasted = await ctx.send('POST', '/api/inbox/paste', owner, {
      from: 'recovery.customer@customer.example.test',
      subject: 'Heat pump',
      text: 'Hi, can you quote a heat pump install?',
    });
    expect(pasted.status).toBe(201);
    const draft = (
      await q(
        "SELECT id FROM communications WHERE tenant_id=$1 AND thread_id=$2 AND direction='outbound'",
        [TENANT_A, pasted.body.threadId],
      )
    ).rows[0].id;
    const approved = await ctx.send('POST', `/api/communications/${draft}/approve-send`, owner, {});
    expect(approved.status).toBe(202);
    const before = mailFake.sent.length;
    // The provider accepts the message; the worker dies as it records the outcome.
    await q(`CREATE FUNCTION recovery_send_crash() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated crash after provider accept'; END $$`);
    await q(
      "CREATE TRIGGER recovery_send_crash BEFORE UPDATE ON communications FOR EACH ROW WHEN (NEW.status = 'sent') EXECUTE FUNCTION recovery_send_crash()",
    );
    const dying = mail;
    try {
      expect(await crash(['inbox.send'], inboxHandlers(dying))).toBe(1);
    } finally {
      await q('DROP TRIGGER recovery_send_crash ON communications');
      await q('DROP FUNCTION recovery_send_crash()');
    }
    expect(mailFake.sent.length).toBe(before + 1);
    await drain(inboxHandlers(mail));
    expect(mailFake.sent.length).toBe(before + 1);
    const row = await q('SELECT status,send_error_code FROM communications WHERE id=$1', [draft]);
    expect(row.rows[0]).toMatchObject({
      status: 'failed',
      send_error_code: 'SEND_OUTCOME_UNKNOWN',
    });
  });

  it('collections: a crash while writing the reminder draft retries to exactly one reminder and draft', async () => {
    expect(
      (await ctx.send('PATCH', '/api/settings/collections', owner, { enabled: true })).status,
    ).toBe(200);
    const customer = randomUUID();
    const job = randomUUID();
    const invoice = randomUUID();
    const ownerId = (
      await q("SELECT id FROM users WHERE tenant_id=$1 AND role='owner'", [TENANT_A])
    ).rows[0].id;
    await q('INSERT INTO customers(id,tenant_id,name,email) VALUES($1,$2,$3,$4)', [
      customer,
      TENANT_A,
      'Mere Tane',
      'mere.recovery@customer.example.test',
    ]);
    await q(
      "INSERT INTO jobs(id,tenant_id,customer_id,title,status) VALUES($1,$2,$3,'Rewire garage','completed')",
      [job, TENANT_A, customer],
    );
    await q(
      `INSERT INTO invoices(id,tenant_id,invoice_number,customer_id,job_id,status,issue_date,due_date,currency,gst_registered,
         prices_entered,tax_basis_points,subtotal_cents,tax_cents,total_cents,approved_by,approved_at,accounting_provider,
         external_invoice_id,posted_at)
       VALUES($1,$2,'INV-99901',$3,$4,'posted',current_date - 30,current_date - 8,'NZD',true,'exclusive',1500,100000,15000,115000,$5,now(),'test','ext-recovery',now())`,
      [invoice, TENANT_A, customer, job, ownerId],
    );
    expect((await ctx.send('POST', '/api/collections/scan', owner, {})).status).toBeLessThan(300);
    // The worker dies at the moment it writes the follow-up draft.
    await q(`CREATE FUNCTION recovery_crash() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated crash while drafting'; END $$`);
    await q(
      "CREATE TRIGGER recovery_crash BEFORE INSERT ON communications FOR EACH ROW WHEN (NEW.origin <> 'inbound') EXECUTE FUNCTION recovery_crash()",
    );
    try {
      expect(
        await crash(['collections.scan', 'reminder.prepare'], inboxHandlers(mail)),
      ).toBeGreaterThan(0);
      // The crash left no draft for this invoice.
      const partial = await q(
        'SELECT count(*)::int AS n FROM reminders WHERE tenant_id=$1 AND subject_id=$2 AND communication_id IS NOT NULL',
        [TENANT_A, invoice],
      );
      expect(partial.rows[0].n).toBe(0);
    } finally {
      await q('DROP TRIGGER recovery_crash ON communications');
      await q('DROP FUNCTION recovery_crash()');
    }
    await drain(inboxHandlers(mail));
    const reminders = await q(
      'SELECT status,communication_id FROM reminders WHERE tenant_id=$1 AND subject_id=$2',
      [TENANT_A, invoice],
    );
    expect(reminders.rows).toHaveLength(1);
    expect(reminders.rows[0].communication_id).toBeTruthy();
    const drafts = await q(
      "SELECT count(*)::int AS n FROM communications c JOIN reminders r ON r.communication_id=c.id WHERE r.tenant_id=$1 AND r.subject_id=$2 AND c.status='draft'",
      [TENANT_A, invoice],
    );
    expect(drafts.rows[0].n).toBe(1);
  });

  it('outbox: a crash after enqueue but before marking dispatched yields one task and one effect', async () => {
    const fake = ctx.accounting!.adapter as FakeAccountingAdapter;
    const invoice = await approvedInvoice();
    const row = (
      await q(
        "SELECT id,tenant_id,topic,payload FROM event_outbox WHERE tenant_id=$1 AND dispatched_at IS NULL AND payload->>'invoiceId'=$2",
        [TENANT_A, invoice.id],
      )
    ).rows[0];
    expect(row).toBeDefined();
    // The dispatcher enqueued (committed) and died before marking the outbox row dispatched.
    await queue.enqueue({
      tenantId: row.tenant_id,
      kind: row.topic,
      payload: { ...row.payload, outboxId: row.id },
      idempotencyKey: `outbox:${row.id}`,
      maxAttempts: 8,
    });
    await dispatchOutbox(ctx.db, queue);
    const tasks = await q(
      'SELECT count(*)::int AS n FROM scheduled_tasks WHERE tenant_id=$1 AND idempotency_key=$2',
      [TENANT_A, `outbox:${row.id}`],
    );
    expect(tasks.rows[0].n).toBe(1);
    await drain(accountingHandlers());
    const ledger = await fake.listInvoiceChangesSince(
      { tenantId: TENANT_A, organisationId: 'x' },
      new Date(0),
    );
    expect(ledger.filter((entry) => entry.reference === invoice.invoiceNumber)).toHaveLength(1);
    expect(
      (await q('SELECT dispatched_at FROM event_outbox WHERE id=$1', [row.id])).rows[0]
        .dispatched_at,
    ).not.toBeNull();
  });
});
