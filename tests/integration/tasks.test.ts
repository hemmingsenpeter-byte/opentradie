import { randomUUID } from 'node:crypto';
import { MockAgentRuntime } from '@opentradie/agent';
import { parseToolCall, TOOL_DEFINITIONS } from '@opentradie/core';
import { transaction } from '@opentradie/database';
import { MockSpeechToText } from '@opentradie/integrations/speech';
import { PostgresJobQueue } from '@opentradie/platform';
import { afterEach, describe, expect, it } from 'vitest';
import { createVoiceTaskHandlers } from '../../apps/api/src/services/voice-notes.js';
import { createTasksTaskHandlers, scanTasks } from '../../apps/api/src/services/tasks.js';
import { createProposal } from '../../apps/api/src/tools/proposals.js';
import { createTestContext, TENANT_A, TENANT_B, type TestContext } from '../helpers/app.js';

const HOUR = 3_600_000;
let ctx: TestContext | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

/** An enquiry turned into a quote the customer accepted; returns the quote and job ids. */
async function acceptedQuote(context: TestContext, owner: string, accept = true) {
  const customer = (await context.get('/api/customers', owner)).body.customers[0].id as string;
  const enquiry = await context.send('POST', '/api/enquiries', owner, {
    text: 'Mrs Johnson needs two power points replaced. Check her existing information and prepare a quote.',
    customerId: customer,
  });
  expect(enquiry.status).toBe(201);
  const quote = enquiry.body.quote;
  const approved = await context.send('POST', `/api/quotes/${quote.id}/approve`, owner, {
    version: quote.version,
  });
  const sent = await context.send('POST', `/api/quotes/${quote.id}/send`, owner, {
    version: approved.body.version,
  });
  expect(sent.status).toBe(200);
  if (accept) {
    const token = new URL(sent.body.acceptanceUrl).pathname.split('/').at(-1)!;
    const accepted = await context.app.inject({
      method: 'POST',
      url: `/api/public/quotes/${token}/accept`,
      headers: { origin: context.config.appOrigin },
      payload: { name: 'Margaret Johnson' },
    });
    expect(accepted.statusCode).toBe(200);
  }
  return { quoteId: quote.id as string, jobId: quote.jobId as string, customerId: customer };
}

/** Rule tasks, optionally only those whose dedupe key mentions one of `ids` (seed data has its own). */
const ruleTasks = async (context: TestContext, ids: string[] = []) =>
  (
    await context.db.pool.query(
      `SELECT kind,status,dedupe_key,completed_by_type,resolution_reason FROM tasks
       WHERE tenant_id=$1 AND source='rule' ORDER BY created_at`,
      [TENANT_A],
    )
  ).rows.filter((row) => !ids.length || ids.some((id) => row.dedupe_key.includes(id)));

describe('tasks.scan rules', () => {
  it('creates book_job once, auto-resolves on booking and reopens when the booking is cancelled', async () => {
    ctx = await createTestContext();
    const owner = await ctx.login();
    const { quoteId, jobId } = await acceptedQuote(ctx, owner);
    const scan = await ctx.send('POST', '/api/tasks/scan', owner, {});
    expect(scan.status).toBe(200);
    expect(scan.body.created).toBeGreaterThanOrEqual(1);
    // Re-running never duplicates.
    await scanTasks(ctx.db, TENANT_A, 'test', new Date());
    let tasks = await ruleTasks(ctx, [quoteId]);
    expect(tasks).toEqual([
      expect.objectContaining({
        kind: 'book_job',
        status: 'open',
        dedupe_key: `book_job:quote:${quoteId}`,
      }),
    ]);
    const today = await ctx.get('/api/today', owner);
    expect(today.status).toBe(200);
    expect([...today.body.overdue, ...today.body.today].map((t: any) => t.kind)).toContain(
      'book_job',
    );
    expect(today.body.counts.due).toBeGreaterThanOrEqual(1);

    const start = new Date(Date.now() + 3 * 24 * HOUR);
    const booked = await ctx.send('POST', '/api/appointments', owner, {
      jobId,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + HOUR).toISOString(),
      allowConflict: true,
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect((await scanTasks(ctx.db, TENANT_A, 'test', new Date())).resolved).toBe(1);
    tasks = await ruleTasks(ctx, [quoteId]);
    expect(tasks[0]).toMatchObject({
      status: 'done',
      completed_by_type: 'system',
      resolution_reason: 'condition_cleared',
    });
    const appointment = booked.body.appointment;
    expect(
      (
        await ctx.send('POST', `/api/appointments/${appointment.id}/cancel`, owner, {
          version: appointment.version,
        })
      ).status,
    ).toBe(200);
    await scanTasks(ctx.db, TENANT_A, 'test', new Date());
    tasks = await ruleTasks(ctx, [quoteId]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: 'open', completed_by_type: null });
  });

  it('never resurrects a dismissed task; follow-up, reply and invoice thresholds apply', async () => {
    ctx = await createTestContext();
    const owner = await ctx.login();
    const sentOnly = await acceptedQuote(ctx, owner, false);
    expect(
      (
        await ctx.send('POST', '/api/inbox/paste', owner, {
          from: 'new.customer@customer.example.test',
          subject: 'Heat pump',
          text: 'Hi, can you quote a heat pump install?',
        })
      ).status,
    ).toBe(201);
    const now = new Date();
    await scanTasks(ctx.db, TENANT_A, 'test', now);
    const count = async (kind: string) =>
      (await ruleTasks(ctx!)).filter((t) => t.kind === kind).length;
    expect(await ruleTasks(ctx, [sentOnly.quoteId])).toEqual([]);
    const replies = await count('reply_message');
    const later = new Date(now.getTime() + 3 * 24 * HOUR + 60_000);
    await scanTasks(ctx.db, TENANT_A, 'test', later);
    expect((await ruleTasks(ctx, [sentOnly.quoteId])).map((t) => t.kind)).toEqual([
      'follow_up_quote',
    ]);
    expect(await count('reply_message')).toBe(replies + 1);

    const followUp = (await ctx.get('/api/tasks?kind=follow_up_quote', owner)).body.tasks[0];
    expect(followUp.quoteId).toBe(sentOnly.quoteId);
    expect((await ctx.send('POST', `/api/tasks/${followUp.id}/dismiss`, owner, {})).status).toBe(
      200,
    );
    await scanTasks(ctx.db, TENANT_A, 'test', new Date(later.getTime() + HOUR));
    const after = await ruleTasks(ctx, [sentOnly.quoteId]);
    expect(after.filter((t) => t.kind === 'follow_up_quote')).toEqual([
      expect.objectContaining({ status: 'dismissed', completed_by_type: 'user' }),
    ]);

    // Completed job without an invoice: invoice_job after one day.
    for (const status of ['in_progress', 'completed'])
      expect(
        (await ctx.send('PATCH', `/api/jobs/${sentOnly.jobId}`, owner, { status })).status,
      ).toBe(200);
    await scanTasks(ctx.db, TENANT_A, 'test', new Date(Date.now() + 2 * 24 * HOUR));
    expect((await ruleTasks(ctx, [sentOnly.jobId])).map((t) => t.kind)).toEqual(['invoice_job']);
  });

  it('runs as a durable periodic task that chains the next scan', async () => {
    ctx = await createTestContext();
    const owner = await ctx.login();
    const { quoteId } = await acceptedQuote(ctx, owner);
    const queue = new PostgresJobQueue(ctx.db, { baseRetryDelayMs: 0 });
    await queue.enqueue({
      tenantId: TENANT_A,
      kind: 'tasks.scan',
      payload: {},
      idempotencyKey: 'tasks:test',
    });
    expect(await queue.runOnce('test', createTasksTaskHandlers({ db: ctx.db, queue }))).toBe(1);
    expect((await ruleTasks(ctx, [quoteId])).map((t) => t.kind)).toEqual(['book_job']);
    const next = await ctx.db.pool.query(
      "SELECT run_at FROM scheduled_tasks WHERE kind='tasks.scan' AND status='pending'",
    );
    expect(next.rows).toHaveLength(1);
    expect(next.rows[0].run_at.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
  });
});

describe('tasks API', () => {
  it('creates, edits, snoozes, completes, dismisses and reopens; viewers read only; tenant scoped', async () => {
    ctx = await createTestContext({ seedTenantB: true });
    const owner = await ctx.login();
    const viewer = await ctx.login('viewer');
    const tomorrow = new Date(Date.now() + 24 * HOUR).toISOString();
    const created = await ctx.send('POST', '/api/tasks', owner, {
      kind: 'call',
      title: 'Call the supplier',
      dueAt: tomorrow,
      priority: 'high',
    });
    expect(created.status).toBe(201);
    const id = created.body.task.id as string;
    expect(created.body.task).toMatchObject({
      source: 'manual',
      status: 'open',
      bucket: 'upcoming',
    });
    const audit = await ctx.db.pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action='task.created' AND entity_id=$1",
      [id],
    );
    expect(audit.rows[0].n).toBe(1);

    expect(
      (await ctx.send('PATCH', `/api/tasks/${id}`, owner, { title: 'Ring Reece' })).body.task.title,
    ).toBe('Ring Reece');
    const snoozed = await ctx.send('POST', `/api/tasks/${id}/snooze`, owner, {
      until: new Date(Date.now() + 7 * 24 * HOUR).toISOString(),
    });
    expect(snoozed.body.task).toMatchObject({ status: 'snoozed', bucket: 'snoozed' });
    expect(
      (await ctx.send('POST', `/api/tasks/${id}/snooze`, owner, { until: '2000-01-01T00:00:00Z' }))
        .status,
    ).toBe(422);
    const done = await ctx.send('POST', `/api/tasks/${id}/complete`, owner, {});
    expect(done.body.task).toMatchObject({ status: 'done', completedByType: 'user' });
    // Completing again changes nothing.
    expect((await ctx.send('POST', `/api/tasks/${id}/complete`, owner, {})).body.changed).toBe(
      false,
    );
    expect((await ctx.send('POST', `/api/tasks/${id}/reopen`, owner, {})).body.task.status).toBe(
      'open',
    );
    expect((await ctx.send('POST', `/api/tasks/${id}/dismiss`, owner, {})).body.task.status).toBe(
      'dismissed',
    );
    expect((await ctx.get('/api/tasks', owner)).body.tasks.map((t: any) => t.id)).not.toContain(id);
    expect((await ctx.get('/api/tasks?status=dismissed', owner)).body.tasks[0].id).toBe(id);

    // Viewer: reads, never writes.
    expect((await ctx.get('/api/today', viewer)).status).toBe(200);
    expect((await ctx.send('POST', '/api/tasks', viewer, { title: 'x' })).status).toBe(403);
    expect((await ctx.send('POST', `/api/tasks/${id}/reopen`, viewer, {})).status).toBe(403);

    // Another tenant's task and links are invisible.
    const foreign = randomUUID();
    await ctx.db.pool.query(
      "INSERT INTO tasks(id,tenant_id,kind,title) VALUES($1,$2,'custom','Tenant B task')",
      [foreign, TENANT_B],
    );
    expect((await ctx.send('POST', `/api/tasks/${foreign}/complete`, owner, {})).status).toBe(404);
    expect(
      (await ctx.get('/api/tasks?status=all', owner)).body.tasks.map((t: any) => t.id),
    ).not.toContain(foreign);
    const bJob = await ctx.db.pool.query('SELECT id FROM jobs WHERE tenant_id=$1 LIMIT 1', [
      TENANT_B,
    ]);
    if (bJob.rows[0])
      expect(
        (await ctx.send('POST', '/api/tasks', owner, { title: 'x', jobId: bJob.rows[0].id }))
          .status,
      ).toBe(422);
  });

  it('validates task rule settings', async () => {
    ctx = await createTestContext();
    const owner = await ctx.login();
    expect((await ctx.get('/api/settings/tasks', owner)).body).toMatchObject({
      followUpQuoteDays: 3,
      replyAfterHours: 24,
    });
    expect(
      (await ctx.send('PATCH', '/api/settings/tasks', owner, { followUpQuoteDays: 0 })).status,
    ).toBe(422);
    expect(
      (await ctx.send('PATCH', '/api/settings/tasks', owner, { followUpQuoteDays: 5 })).body
        .followUpQuoteDays,
    ).toBe(5);
  });
});

describe('task agent tools', () => {
  it('task.complete is a proposal that the owner approves; auto only when enabled', async () => {
    ctx = await createTestContext();
    const owner = await ctx.login();
    const created = await ctx.send('POST', '/api/tasks', owner, { title: 'Order the cylinder' });
    const taskId = created.body.task.id as string;
    const propose = (key: string) => {
      const parsed = parseToolCall('task.complete', { taskId, idempotencyKey: key });
      if (!parsed.ok) throw new Error('parse failed');
      return transaction(ctx!.db, (client) =>
        createProposal(client, {
          tenantId: TENANT_A,
          requestId: 'test',
          tool: TOOL_DEFINITIONS['task.complete'],
          payload: parsed.input,
          meta: parsed.meta,
          origin: { source: 'agent', createdByType: 'agent', sourceRef: 'session-1' },
        }),
      );
    };
    const { proposal } = await propose('first-key');
    expect(proposal.status).toBe('pending');
    expect((await ctx.get(`/api/tasks?status=open`, owner)).body.tasks).toHaveLength(1);
    const approved = await ctx.send('POST', `/api/proposals/${proposal.id}/approve`, owner, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await ctx.get('/api/tasks?status=done', owner)).body.tasks[0].id).toBe(taskId);

    // Owner turns on auto for task.complete; task.snooze cannot be auto.
    expect(
      (
        await ctx.send('POST', '/api/agent-tool-policies', owner, {
          tool: 'task.snooze',
          approval: 'auto',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await ctx.send('POST', '/api/agent-tool-policies', owner, {
          tool: 'task.complete',
          approval: 'auto',
        })
      ).status,
    ).toBe(200);
    expect((await ctx.send('POST', `/api/tasks/${taskId}/reopen`, owner, {})).status).toBe(200);
    const auto = await propose('second-key');
    expect(auto.proposal.status).toBe('executed');
    const row = await ctx.db.pool.query('SELECT status,completed_by_type FROM tasks WHERE id=$1', [
      taskId,
    ]);
    expect(row.rows[0]).toEqual({ status: 'done', completed_by_type: 'system' });
  });

  it('voice "remind me to call Bob tomorrow" → task.create proposal → approve → due 9 am NZ tomorrow', async () => {
    const runtime = new MockAgentRuntime();
    ctx = await createTestContext({ runtime });
    const owner = await ctx.login();
    const customer = await ctx.send('POST', '/api/customers', owner, { name: 'John Smith' });
    const job = await ctx.send('POST', '/api/jobs', owner, {
      customerId: customer.body.id,
      title: 'Kitchen mixer replacement',
      siteAddress: '12 Kauri Road',
    });
    const jobId = job.body.id as string;
    const queue = new PostgresJobQueue(ctx.db, { baseRetryDelayMs: 0 });
    const handlers = createVoiceTaskHandlers({
      db: ctx.db,
      runtime,
      config: ctx.config,
      fileStore: ctx.fileStore,
      speech: new MockSpeechToText({
        text: "Quick update from Smith's house. Remind me to call Bob tomorrow.",
      }),
      queue,
    });
    const data = Buffer.from('synthetic-audio-tasks');
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(4 + data.length, 4);
    header.write('WAVE', 8, 'latin1');
    const uploaded = await ctx.send('POST', '/api/voice-notes', owner, {
      fileName: 'note.wav',
      mediaType: 'audio/wav',
      dataBase64: Buffer.concat([header, data]).toString('base64'),
      jobId,
    });
    expect(uploaded.status).toBe(201);
    for (let i = 0; i < 20; i++) if ((await queue.runOnce('test', handlers)) === 0) break;
    const note = (await ctx.get(`/api/voice-notes/${uploaded.body.id}`, owner)).body;
    const proposal = note.proposals.find((p: any) => p.tool === 'task.create');
    expect(proposal, JSON.stringify(note.proposals?.map((p: any) => p.tool))).toBeDefined();
    expect(proposal.payload).toMatchObject({ kind: 'call', title: 'Call Bob', jobId });
    const approved = await ctx.send('POST', `/api/proposals/${proposal.id}/approve`, owner, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const task = (await ctx.get('/api/tasks', owner)).body.tasks.find(
      (t: any) => t.kind === 'call',
    );
    expect(task).toMatchObject({ source: 'voice', title: 'Call Bob', jobId });
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Pacific/Auckland',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const recorded = local.format(new Date(note.createdAt)).slice(0, 10);
    const [y, m, d] = recorded.split('-').map(Number);
    const expected = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
    expect(local.format(new Date(task.dueAt))).toBe(`${expected}, 09:00`);
    // Approving again never creates a second task.
    await ctx.send('POST', `/api/proposals/${proposal.id}/approve`, owner, {});
    expect(
      (await ctx.get('/api/tasks', owner)).body.tasks.filter((t: any) => t.kind === 'call'),
    ).toHaveLength(1);
  });
});
