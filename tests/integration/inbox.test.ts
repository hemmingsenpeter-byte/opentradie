import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockAgentRuntime } from '@opentradie/agent';
import {
  FakeMailAdapter,
  fakeMailConnections,
  noMailConnections,
} from '@opentradie/integrations/mail';
import { PostgresJobQueue } from '@opentradie/platform';
import { createInboxTaskHandlers } from '../../apps/api/src/services/inbox.js';
import { createTestContext, TENANT_A, TENANT_B, type TestContext } from '../helpers/app.js';
import { INBOUND_SECRET, postInboundEmail, rawEmail } from '../helpers/email.js';

const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('synthetic-png-bytes-for-tests'),
]);
const PDF = Buffer.from('%PDF-1.4\n% synthetic\n');

describe('unified inbox: email ingestion, AI draft and approval', () => {
  let ctx: TestContext;
  let owner: string;
  let viewer: string;
  const fake = new FakeMailAdapter();
  const runtime = new MockAgentRuntime();
  let queue: PostgresJobQueue;

  const webhook = (rawMime: string, options: Parameters<typeof postInboundEmail>[2] = {}) =>
    postInboundEmail(ctx, rawMime, options);

  async function runTasks(mail = fakeMailConnections(fake)) {
    const handlers = createInboxTaskHandlers({ db: ctx.db, runtime, config: ctx.config, mail });
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const processed = await queue.runOnce('test-worker', handlers);
      total += processed;
      if (processed === 0) break;
    }
    return total;
  }

  const count = async (sql: string, params: unknown[] = []) =>
    Number((await ctx.db.pool.query<{ n: string }>(sql, params)).rows[0]!.n);

  beforeAll(async () => {
    ctx = await createTestContext({
      env: { INBOUND_EMAIL_SECRET: INBOUND_SECRET },
      runtime,
      mail: fakeMailConnections(fake),
      seedTenantB: true,
      logLevel: 'debug',
    });
    queue = new PostgresJobQueue(ctx.db, { baseRetryDelayMs: 0 });
    owner = await ctx.login('owner');
    viewer = await ctx.login('viewer');
  });
  afterAll(async () => ctx?.close());

  it('turns a new customer enquiry into a customer, job and AI draft awaiting approval, sending nothing', async () => {
    const received = await webhook(
      rawEmail({
        from: 'Kiri.Walker@customer.example.test',
        name: 'Kiri Walker',
        subject: 'Quote for three new power points',
        text: 'Kia ora, could you quote to install three new power points in our garage at 5 Totara Ave? Thanks, Kiri',
      }),
    );
    expect(received.status).toBe(202);
    expect(received.body).toMatchObject({
      status: 'accepted',
      createdCustomer: true,
      createdJob: true,
      needsReview: false,
    });
    const customer = await ctx.get(`/api/customers/${received.body.customerId}`, owner);
    expect(customer.body.customer ?? customer.body).toMatchObject({
      name: 'Kiri Walker',
      email: 'kiri.walker@customer.example.test',
    });
    const job = await ctx.db.pool.query(
      'SELECT title,status,origin,customer_id FROM jobs WHERE tenant_id=$1 AND id=$2',
      [TENANT_A, received.body.jobId],
    );
    expect(job.rows[0]).toMatchObject({
      title: 'Quote for three new power points',
      status: 'new',
      origin: 'email',
      customer_id: received.body.customerId,
    });
    const events = await ctx.db.pool.query(
      "SELECT type,metadata FROM job_events WHERE tenant_id=$1 AND job_id=$2 AND type='created'",
      [TENANT_A, received.body.jobId],
    );
    expect(events.rows[0].metadata).toMatchObject({ origin: 'email' });
    expect(
      await count(
        "SELECT count(*) AS n FROM knowledge_items WHERE tenant_id=$1 AND source_type='communication' AND source_id=$2 AND job_id=$3",
        [TENANT_A, received.body.communicationId, received.body.jobId],
      ),
    ).toBe(1);

    expect(await runTasks()).toBeGreaterThan(0);
    const thread = await ctx.get(`/api/inbox/threads/${received.body.threadId}`, owner);
    expect(thread.status).toBe(200);
    expect(thread.body.thread).toMatchObject({
      customerName: 'Kiri Walker',
      jobId: received.body.jobId,
      needsReview: false,
    });
    const [inbound, draft] = thread.body.messages;
    expect(inbound).toMatchObject({ direction: 'inbound', triageStatus: 'completed' });
    expect(inbound.triage).toMatchObject({
      classification: 'new_enquiry',
      synthetic: true,
      match: { customer: { basis: 'created' }, job: { basis: 'created' } },
    });
    expect(inbound.triage.summary).toContain('Kiri Walker');
    expect(draft).toMatchObject({
      direction: 'outbound',
      status: 'draft',
      origin: 'agent_draft',
      toAddresses: ['kiri.walker@customer.example.test'],
      subject: 'Re: Quote for three new power points',
    });
    expect(draft.text).toContain('Kia ora Kiri');
    expect(fake.sent).toHaveLength(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM scheduled_tasks WHERE tenant_id=$1 AND kind='inbox.send'",
        [TENANT_A],
      ),
    ).toBe(0);
    const audit = await ctx.db.pool.query<{ action: string; actor_type: string }>(
      'SELECT action,actor_type FROM audit_events WHERE tenant_id=$1 AND entity_id=$2',
      [TENANT_A, draft.id],
    );
    expect(audit.rows).toContainEqual({
      action: 'communication.draft_created',
      actor_type: 'agent',
    });

    const list = await ctx.get('/api/inbox/threads', owner);
    const listed = list.body.threads.find(
      (item: { id: string }) => item.id === received.body.threadId,
    );
    expect(listed).toMatchObject({ unreadCount: 1, pendingDrafts: 1, customerName: 'Kiri Walker' });
  });

  it('approves and sends exactly once; repeats and task retries never send twice', async () => {
    const received = await webhook(
      rawEmail({
        from: 'ana.lee@customer.example.test',
        name: 'Ana Lee',
        subject: 'Lights not working in hallway',
        text: 'Hi, two hallway lights stopped working. Can you fix them?',
      }),
    );
    await runTasks();
    const thread = await ctx.get(`/api/inbox/threads/${received.body.threadId}`, owner);
    const draft = thread.body.messages.find(
      (m: { direction: string }) => m.direction === 'outbound',
    );

    const edited = 'Kia ora Ana, we can come on Thursday morning to look at the hallway lights.';
    const first = await ctx.send('POST', `/api/communications/${draft.id}/approve-send`, owner, {
      text: edited,
    });
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ status: 'approved', sendAttempt: 1 });
    const again = await ctx.send('POST', `/api/communications/${draft.id}/approve-send`, owner, {});
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('approved');

    await runTasks();
    await runTasks();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({
      to: [{ address: 'ana.lee@customer.example.test' }],
      subject: 'Re: Lights not working in hallway',
      text: edited,
    });
    expect(fake.sent[0]!.inReplyTo).toMatch(/^<.+@customer\.example\.test>$/);
    expect(fake.sent[0]!.mime).toMatch(/\r\nIn-Reply-To: </);
    const sent = await ctx.db.pool.query(
      'SELECT status,provider,provider_message_id,approved_by,sent_at FROM communications WHERE tenant_id=$1 AND id=$2',
      [TENANT_A, draft.id],
    );
    expect(sent.rows[0]).toMatchObject({
      status: 'sent',
      provider: 'fake',
      provider_message_id: 'fake-sent-1',
    });
    expect(sent.rows[0].approved_by).toBeTruthy();

    // Approving a sent message again queues nothing and sends nothing.
    const late = await ctx.send('POST', `/api/communications/${draft.id}/approve-send`, owner, {});
    expect(late.status).toBe(200);
    expect(late.body.status).toBe('sent');
    // A replayed task (same id, re-run) finds the message sent and does nothing.
    await ctx.db.pool.query(
      "UPDATE scheduled_tasks SET status='pending', attempts=0 WHERE tenant_id=$1 AND kind='inbox.send'",
      [TENANT_A],
    );
    await runTasks();
    expect(fake.sent).toHaveLength(1);

    // A customer reply threads onto the same conversation by In-Reply-To.
    const ourMessageId = (
      await ctx.db.pool.query('SELECT message_id_header FROM communications WHERE id=$1', [
        draft.id,
      ])
    ).rows[0].message_id_header;
    const reply = await webhook(
      rawEmail({
        from: 'ana.lee@customer.example.test',
        name: 'Ana Lee',
        subject: 'Re: Lights not working in hallway',
        text: 'Thursday works, thanks!',
        inReplyTo: ourMessageId,
        references: [ourMessageId],
      }),
    );
    expect(reply.body).toMatchObject({
      threadId: received.body.threadId,
      createdCustomer: false,
      createdJob: false,
      jobId: received.body.jobId,
    });
  });

  it('fails visibly with NO_MAIL_CONNECTION when no mailbox is connected, and can be re-approved', async () => {
    const received = await webhook(
      rawEmail({
        from: 'tom.reid@customer.example.test',
        subject: 'Switchboard upgrade quote',
        text: 'Could you quote a switchboard upgrade?',
      }),
    );
    await runTasks();
    const draftId = (
      await ctx.db.pool.query(
        "SELECT id FROM communications WHERE tenant_id=$1 AND reply_to_communication_id=$2 AND origin='agent_draft'",
        [TENANT_A, received.body.communicationId],
      )
    ).rows[0].id;
    expect(
      (await ctx.send('POST', `/api/communications/${draftId}/approve-send`, owner, {})).status,
    ).toBe(202);
    const sentBefore = fake.sent.length;
    await runTasks(noMailConnections);
    const failed = await ctx.db.pool.query(
      'SELECT status,send_error_code FROM communications WHERE tenant_id=$1 AND id=$2',
      [TENANT_A, draftId],
    );
    expect(failed.rows[0]).toEqual({ status: 'failed', send_error_code: 'NO_MAIL_CONNECTION' });
    const task = await ctx.db.pool.query(
      "SELECT status,last_error FROM scheduled_tasks WHERE tenant_id=$1 AND kind='inbox.send' AND payload->>'communicationId'=$2",
      [TENANT_A, draftId],
    );
    expect(task.rows[0]).toMatchObject({ status: 'failed' });
    expect(task.rows[0].last_error).toContain('NO_MAIL_CONNECTION');
    expect(fake.sent.length).toBe(sentBefore);

    // A provider failure is recorded with a safe code and never retried automatically.
    fake.failNextSends = 1;
    expect(
      (await ctx.send('POST', `/api/communications/${draftId}/approve-send`, owner, {})).body,
    ).toMatchObject({ status: 'approved', sendAttempt: 2 });
    await runTasks();
    const transient = await ctx.db.pool.query(
      'SELECT status,send_error_code FROM communications WHERE id=$1',
      [draftId],
    );
    expect(transient.rows[0]).toEqual({
      status: 'failed',
      send_error_code: 'PROVIDER_UNAVAILABLE',
    });
    expect(fake.sent.length).toBe(sentBefore);

    expect(
      (await ctx.send('POST', `/api/communications/${draftId}/approve-send`, owner, {})).body,
    ).toMatchObject({ sendAttempt: 3 });
    await runTasks();
    expect(fake.sent.length).toBe(sentBefore + 1);

    // A crash between the provider call and recording it is never resent.
    await ctx.db.pool.query(
      "UPDATE communications SET status='sending', provider_message_id=NULL WHERE id=$1",
      [draftId],
    );
    await ctx.db.pool.query(
      "UPDATE scheduled_tasks SET status='pending', attempts=0 WHERE kind='inbox.send' AND payload->>'communicationId'=$1",
      [draftId],
    );
    await runTasks();
    const unknown = await ctx.db.pool.query(
      'SELECT status,send_error_code FROM communications WHERE id=$1',
      [draftId],
    );
    expect(unknown.rows[0]).toEqual({ status: 'failed', send_error_code: 'SEND_OUTCOME_UNKNOWN' });
    expect(fake.sent.length).toBe(sentBefore + 1);
  });

  it('links an existing customer by exact email and their single open job', async () => {
    const received = await webhook(
      rawEmail({
        from: 'Aroha.Ngata@example.test',
        name: 'Aroha',
        subject: 'Access on inspection day',
        text: 'The side gate code is with the neighbour, just knock.',
      }),
    );
    expect(received.body).toMatchObject({
      createdCustomer: false,
      createdJob: false,
      needsReview: false,
    });
    const linked = await ctx.db.pool.query(
      'SELECT c.name, j.title FROM communications m JOIN customers c ON c.id=m.customer_id JOIN jobs j ON j.id=m.job_id WHERE m.id=$1',
      [received.body.communicationId],
    );
    expect(linked.rows[0]).toEqual({ name: 'Aroha Ngata', title: 'Switchboard inspection' });
  });

  it('marks an ambiguous job for review instead of guessing, and the owner resolves it', async () => {
    const aroha = (
      await ctx.db.pool.query(
        "SELECT id FROM customers WHERE tenant_id=$1 AND name='Aroha Ngata'",
        [TENANT_A],
      )
    ).rows[0].id;
    const second = await ctx.send('POST', '/api/jobs', owner, {
      customerId: aroha,
      title: 'Deck lighting',
    });
    expect(second.status).toBe(201);
    const received = await webhook(
      rawEmail({
        from: 'aroha.ngata@example.test',
        subject: 'Quick question',
        text: 'Which day are you coming?',
      }),
    );
    expect(received.body).toMatchObject({
      needsReview: true,
      reviewReason: 'job_ambiguous',
      jobId: null,
      customerId: aroha,
      createdJob: false,
    });
    const review = await ctx.get('/api/inbox/threads?filter=needs_review', owner);
    expect(review.body.threads.map((t: { id: string }) => t.id)).toContain(received.body.threadId);
    const thread = await ctx.get(`/api/inbox/threads/${received.body.threadId}`, owner);
    expect(thread.body.messages[0].triage.match.job.candidates).toHaveLength(2);

    const link = await ctx.send(
      'POST',
      `/api/inbox/threads/${received.body.threadId}/link`,
      owner,
      { jobId: second.body.id },
    );
    expect(link.status).toBe(200);
    const after = await ctx.get(`/api/inbox/threads/${received.body.threadId}`, owner);
    expect(after.body.thread).toMatchObject({
      needsReview: false,
      jobId: second.body.id,
      customerId: aroha,
    });
  });

  it('never links by an ambiguous display name; an unknown sender without an enquiry is left for review', async () => {
    const ambiguous = await webhook(
      rawEmail({
        from: 'someone.new@customer.example.test',
        name: 'Mrs Johnson',
        subject: 'Hello again',
        text: 'Just checking in.',
      }),
    );
    expect(ambiguous.body).toMatchObject({
      customerId: null,
      createdCustomer: false,
      needsReview: true,
      reviewReason: 'customer_ambiguous',
    });
    const chatty = await webhook(
      rawEmail({ from: 'friend@customer.example.test', subject: 'Hi', text: 'Long time no see!' }),
    );
    expect(chatty.body).toMatchObject({
      customerId: null,
      createdCustomer: false,
      reviewReason: 'customer_unknown',
    });
    const created = await ctx.send(
      'POST',
      `/api/inbox/threads/${chatty.body.threadId}/create-job`,
      owner,
      { title: 'Follow up with friend' },
    );
    expect(created.status).toBe(201);
    expect(created.body.createdCustomer).toBe(true);
    const job = await ctx.db.pool.query('SELECT origin,title FROM jobs WHERE id=$1', [
      created.body.jobId,
    ]);
    expect(job.rows[0]).toEqual({ origin: 'email', title: 'Follow up with friend' });
  });

  it('does not create records or drafts for automated mail', async () => {
    const before = await count('SELECT count(*) AS n FROM customers WHERE tenant_id=$1', [
      TENANT_A,
    ]);
    const received = await webhook(
      rawEmail({
        from: 'no-reply@supplier.example.test',
        subject: 'Your quote request was received',
        text: 'Automatic reply: we will install your order soon.',
        headers: ['Auto-Submitted: auto-replied'],
      }),
    );
    expect(received.body).toMatchObject({ automated: true, createdCustomer: false });
    expect(await count('SELECT count(*) AS n FROM customers WHERE tenant_id=$1', [TENANT_A])).toBe(
      before,
    );
    expect(
      await count(
        "SELECT count(*) AS n FROM scheduled_tasks WHERE kind='inbox.triage' AND payload->>'communicationId'=$1",
        [received.body.communicationId],
      ),
    ).toBe(0);
  });

  it('acknowledges a duplicate webhook once and de-duplicates the same Message-ID across events', async () => {
    const eventId = `evt-${randomUUID()}`;
    const mime = rawEmail({
      from: 'dup@customer.example.test',
      subject: 'Need a quote to rewire',
      text: 'Please quote a rewire.',
      messageId: '<dup-1@customer.example.test>',
    });
    const first = await webhook(mime, { eventId });
    expect(first.status).toBe(202);
    const second = await webhook(mime, { eventId });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      status: 'duplicate',
      communicationId: first.body.communicationId,
    });
    const otherEvent = await webhook(mime, { eventId: `evt-${randomUUID()}`, provider: 'gmail' });
    expect(otherEvent.status).toBe(200);
    expect(otherEvent.body).toMatchObject({
      status: 'duplicate',
      communicationId: first.body.communicationId,
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM communications WHERE tenant_id=$1 AND message_id_header='<dup-1@customer.example.test>'",
        [TENANT_A],
      ),
    ).toBe(1);
    expect(
      await count("SELECT count(*) AS n FROM customers WHERE email='dup@customer.example.test'"),
    ).toBe(1);
    const conflict = await webhook(
      rawEmail({ from: 'dup@customer.example.test', subject: 'x', text: 'y' }),
      {
        eventId,
      },
    );
    expect(conflict.status).toBe(409);
  });

  it('rejects bad signatures, wrong secrets and replays outside the window before writing anything', async () => {
    const before = await count('SELECT count(*) AS n FROM webhook_receipts');
    const mime = rawEmail({
      from: 'x@customer.example.test',
      subject: 'quote',
      text: 'quote please',
    });
    expect((await webhook(mime, { signature: 't=1,v1=' + '0'.repeat(64) })).status).toBe(401);
    expect((await webhook(mime, { signature: 'garbage' })).status).toBe(401);
    expect(
      (await webhook(mime, { secret: 'a-different-secret-that-is-long-enough-xx' })).status,
    ).toBe(401);
    const stale = Math.floor(Date.now() / 1000) - 301;
    expect((await webhook(mime, { timestamp: stale })).status).toBe(401);
    const future = Math.floor(Date.now() / 1000) + 301;
    expect((await webhook(mime, { timestamp: future })).status).toBe(401);
    expect(await count('SELECT count(*) AS n FROM webhook_receipts')).toBe(before);
    expect((await webhook(mime, { provider: 'not_a_provider' })).status).toBe(400);
    expect((await webhook('', {})).status).toBe(400);
  });

  it('stores allowed attachments as documents and rejects disallowed or mislabelled ones', async () => {
    const received = await webhook(
      rawEmail({
        from: 'kiri.walker@customer.example.test',
        subject: 'Photos of the garage',
        text: 'Photos attached of where the power points should go.',
        attachments: [
          { fileName: 'garage.png', mediaType: 'image/png', content: PNG },
          { fileName: 'plan.pdf', mediaType: 'application/pdf', content: PDF },
          {
            fileName: 'run-me.html',
            mediaType: 'text/html',
            content: Buffer.from('<script>x</script>'),
          },
          { fileName: 'fake.png', mediaType: 'image/png', content: Buffer.from('MZ not a png') },
        ],
      }),
    );
    expect(received.body).toMatchObject({ attachmentsStored: 2, attachmentsRejected: 2 });
    const docs = await ctx.db.pool.query(
      'SELECT id,kind,file_name,media_type,customer_id,storage_key FROM documents WHERE tenant_id=$1 AND communication_id=$2 ORDER BY file_name',
      [TENANT_A, received.body.communicationId],
    );
    expect(docs.rows.map((row) => [row.file_name, row.kind, row.media_type])).toEqual([
      ['garage.png', 'photo', 'image/png'],
      ['plan.pdf', 'attachment', 'application/pdf'],
    ]);
    expect(docs.rows[0].customer_id).toBe(received.body.customerId);
    expect(docs.rows[0].storage_key).toMatch(new RegExp(`^tenants/${TENANT_A}/communications/`));
    const content = await ctx.app.inject({
      method: 'GET',
      url: `/api/documents/${docs.rows[0].id}/content`,
      headers: { cookie: owner },
    });
    expect(content.statusCode).toBe(200);
    expect(Buffer.from(content.rawPayload).equals(PNG)).toBe(true);
    const thread = await ctx.get(`/api/inbox/threads/${received.body.threadId}`, owner);
    const inbound = thread.body.messages.find(
      (m: { id: string }) => m.id === received.body.communicationId,
    );
    expect(inbound.attachments).toHaveLength(2);
    expect(inbound.triage.attachments.rejected).toEqual([
      { fileName: 'run-me.html', reason: 'type_not_allowed' },
      { fileName: 'fake.png', reason: 'type_not_allowed' },
    ]);
  });

  it('lets the owner paste an email for a demo; the reply is drafted immediately and nothing is sent', async () => {
    const pasted = await ctx.send('POST', '/api/inbox/paste', owner, {
      from: 'demo.customer@customer.example.test',
      fromName: 'Demo Customer',
      subject: 'Heat pump install',
      text: 'Hi, we need a heat pump installed in the lounge. Can you quote?',
    });
    expect(pasted.status).toBe(201);
    expect(pasted.body).toMatchObject({ createdCustomer: true, createdJob: true });
    const thread = await ctx.get(`/api/inbox/threads/${pasted.body.threadId}`, owner);
    expect(thread.body.messages.map((m: { status: string }) => m.status)).toEqual([
      'received',
      'draft',
    ]);
    const read = await ctx.send('POST', `/api/inbox/threads/${pasted.body.threadId}/read`, owner);
    expect(read.body.marked).toBe(1);
    const raw = await ctx.send('POST', '/api/inbox/paste', owner, {
      rawMime: rawEmail({
        from: 'raw@customer.example.test',
        subject: 'Fix my lights',
        text: 'Lights flicker.',
      }),
    });
    expect(raw.status).toBe(201);
  });

  it('keeps viewers read-only and other tenants out', async () => {
    const threads = await ctx.get('/api/inbox/threads', viewer);
    expect(threads.status).toBe(200);
    const threadId = threads.body.threads[0].id;
    const draft = await ctx.db.pool.query(
      "SELECT id FROM communications WHERE tenant_id=$1 AND status='draft' LIMIT 1",
      [TENANT_A],
    );
    for (const [method, path, body] of [
      ['POST', `/api/communications/${draft.rows[0].id}/approve-send`, {}],
      ['PATCH', `/api/communications/${draft.rows[0].id}`, { text: 'changed' }],
      ['POST', `/api/inbox/threads/${threadId}/link`, { customerId: null }],
      ['POST', `/api/inbox/threads/${threadId}/create-job`, {}],
      ['POST', '/api/inbox/paste', { from: 'a@b.example.test', text: 'x' }],
    ] as const) {
      const denied = await ctx.send(method, path, viewer, body);
      expect(denied.status, path).toBe(403);
    }

    // A thread belonging to another tenant is invisible.
    const foreignThread = randomUUID();
    await ctx.db.pool.query(
      "INSERT INTO communication_threads(id,tenant_id,channel,subject) VALUES($1,$2,'email','Other business')",
      [foreignThread, TENANT_B],
    );
    const foreignDraft = randomUUID();
    await ctx.db.pool.query(
      "INSERT INTO communications(id,tenant_id,direction,channel,status,text,thread_id,origin,to_addresses) VALUES($1,$2,'outbound','email','draft','other tenant draft',$3,'agent_draft','{x@other.example.test}')",
      [foreignDraft, TENANT_B, foreignThread],
    );
    expect((await ctx.get(`/api/inbox/threads/${foreignThread}`, owner)).status).toBe(404);
    expect(
      (await ctx.send('POST', `/api/communications/${foreignDraft}/approve-send`, owner, {}))
        .status,
    ).toBe(404);
    const listed = await ctx.get('/api/inbox/threads', owner);
    expect(listed.body.threads.map((t: { id: string }) => t.id)).not.toContain(foreignThread);
  });

  it('never writes message bodies to logs', async () => {
    const marker = `secret-body-marker-${randomUUID()}`;
    await webhook(
      rawEmail({
        from: 'log@customer.example.test',
        subject: 'quote',
        text: `Please quote ${marker}`,
      }),
    );
    await ctx.send('POST', '/api/inbox/paste', owner, {
      from: 'log2@customer.example.test',
      text: `fix ${marker}`,
    });
    await runTasks();
    expect(ctx.logs.join('\n')).not.toContain(marker);
    const audit = await ctx.db.pool.query('SELECT metadata FROM audit_events');
    expect(JSON.stringify(audit.rows)).not.toContain(marker);
    const failures = await ctx.db.pool.query('SELECT error FROM scheduled_task_failures');
    expect(JSON.stringify(failures.rows)).not.toContain(marker);
  });
});
