import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seed, type Database } from '@opentradie/database';
import {
  createTaskHandlers,
  forwardRelayEvent,
  OpenAICompatibleEmbeddingProvider,
  OllamaEmbeddingProvider,
  PermanentTaskError,
  PostgresJobQueue,
  receiveRelayEvent,
  RELAY_SIGNATURE_HEADER,
  relayEnvelopeSchema,
  signRelayBody,
  verifyRelaySignature,
  type RelayEnvelope,
} from '@opentradie/platform';
import { createTestContext, TENANT_A, type TestContext } from '../helpers/app.js';
import { createTestDatabase } from '../helpers/db.js';

describe('Postgres job queue', () => {
  let db: Database;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const database = await createTestDatabase();
    db = database.db;
    drop = database.drop;
    await seed(db, {
      tenantId: TENANT_A,
      ownerEmail: 'o@example.test',
      ownerPassword: 'owner-password-x',
    });
  });
  afterAll(async () => drop?.());

  it('deduplicates enqueue by idempotency key', async () => {
    const queue = new PostgresJobQueue(db);
    const first = await queue.enqueue({
      tenantId: TENANT_A,
      kind: 'test.once',
      payload: { n: 1 },
      idempotencyKey: 'same',
    });
    const second = await queue.enqueue({
      tenantId: TENANT_A,
      kind: 'test.once',
      payload: { n: 2 },
      idempotencyKey: 'same',
    });
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
  });

  it('leases each task to one worker at a time', async () => {
    const queue = new PostgresJobQueue(db);
    await queue.enqueue({
      tenantId: TENANT_A,
      kind: 'test.lease',
      payload: {},
      idempotencyKey: 'lease-1',
    });
    const [a, b] = await Promise.all([
      queue.lease('worker-a', { kinds: ['test.lease'] }),
      queue.lease('worker-b', { kinds: ['test.lease'] }),
    ]);
    expect(a.length + b.length).toBe(1);
    const task = [...a, ...b][0]!;
    expect(await queue.complete({ ...task, leaseOwner: 'someone-else' })).toBe(false);
    expect(await queue.complete(task)).toBe(true);
  });

  it('retries with backoff, records every failure, and stops at max attempts', async () => {
    const queue = new PostgresJobQueue(db, { baseRetryDelayMs: 0 });
    const { id } = await queue.enqueue({
      tenantId: TENANT_A,
      kind: 'test.flaky',
      payload: {},
      idempotencyKey: 'flaky',
      maxAttempts: 3,
    });
    const handler = vi.fn(async () => {
      throw new Error('transient failure');
    });
    for (let i = 0; i < 5; i++) await queue.runOnce('worker', { 'test.flaky': handler });
    expect(handler).toHaveBeenCalledTimes(3);
    const row = (
      await db.pool.query('SELECT status, attempts, last_error FROM scheduled_tasks WHERE id=$1', [
        id,
      ])
    ).rows[0];
    expect(row).toMatchObject({
      status: 'failed',
      attempts: 3,
      last_error: 'Error: transient failure',
    });
    const failures = await db.pool.query(
      'SELECT attempt FROM scheduled_task_failures WHERE task_id=$1 ORDER BY attempt',
      [id],
    );
    expect(failures.rows.map((failure) => failure.attempt)).toEqual([1, 2, 3]);
  });

  it('succeeds after a transient failure', async () => {
    const queue = new PostgresJobQueue(db, { baseRetryDelayMs: 0 });
    const { id } = await queue.enqueue({
      tenantId: TENANT_A,
      kind: 'test.recover',
      payload: {},
      idempotencyKey: 'recover',
    });
    let calls = 0;
    const handlers = {
      'test.recover': async () => {
        calls += 1;
        if (calls === 1) throw new Error('first attempt fails');
      },
    };
    await queue.runOnce('worker', handlers);
    await queue.runOnce('worker', handlers);
    expect(
      (await db.pool.query('SELECT status, attempts FROM scheduled_tasks WHERE id=$1', [id]))
        .rows[0],
    ).toEqual({ status: 'completed', attempts: 2 });
  });

  it('does not retry permanent failures', async () => {
    const queue = new PostgresJobQueue(db, { baseRetryDelayMs: 0 });
    const { id } = await queue.enqueue({
      tenantId: TENANT_A,
      kind: 'test.permanent',
      payload: {},
      idempotencyKey: 'permanent',
    });
    const handler = vi.fn(async () => {
      throw new PermanentTaskError('invalid payload');
    });
    await queue.runOnce('worker', { 'test.permanent': handler });
    await queue.runOnce('worker', { 'test.permanent': handler });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      (await db.pool.query('SELECT status FROM scheduled_tasks WHERE id=$1', [id])).rows[0].status,
    ).toBe('failed');
  });

  it('reclaims a task whose worker crashed (expired lease)', async () => {
    const queue = new PostgresJobQueue(db);
    const { id } = await queue.enqueue({
      tenantId: TENANT_A,
      kind: 'test.crash',
      payload: {},
      idempotencyKey: 'crash',
    });
    const [leased] = await queue.lease('crashed-worker', { kinds: ['test.crash'], leaseMs: 1 });
    expect(leased?.id).toBe(id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [reclaimed] = await queue.lease('healthy-worker', { kinds: ['test.crash'] });
    expect(reclaimed).toMatchObject({ id, attempts: 2, leaseOwner: 'healthy-worker' });
    expect(await queue.complete(leased!)).toBe(false);
    expect(await queue.complete(reclaimed!)).toBe(true);
  });
});

describe('relay contracts and local delivery harness', () => {
  let ctx: TestContext;
  const secret = 'relay-shared-secret-for-tests-0123456789';
  const envelope = (
    eventId: string,
    text = 'Hi, could you also look at the outside light?',
  ): RelayEnvelope => ({
    version: 1,
    tenantId: TENANT_A,
    source: 'mock_email',
    eventId,
    eventType: 'message.received',
    occurredAt: '2026-10-19T09:00:00+13:00',
    payload: { from: 'margaret.johnson@example.test', subject: 'Outside light', text },
  });
  beforeAll(async () => {
    ctx = await createTestContext({ env: { RELAY_SHARED_SECRET: secret } });
  });
  afterAll(async () => ctx?.close());

  const transport = async (request: { body: string; headers: Record<string, string> }) => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/relay/v1/events',
      headers: request.headers,
      payload: request.body,
    });
    return { status: response.statusCode };
  };

  it('verifies HMAC signatures with a freshness window', () => {
    const body = JSON.stringify(envelope('sig-1'));
    const header = signRelayBody(body, secret, 1_000_000);
    expect(verifyRelaySignature(body, header, secret, 1_000_100)).toBe(true);
    expect(verifyRelaySignature(body, header, secret, 1_000_400)).toBe(false);
    expect(verifyRelaySignature(`${body} `, header, secret, 1_000_100)).toBe(false);
    expect(
      verifyRelaySignature(body, header, 'other-secret-other-secret-other-secret', 1_000_100),
    ).toBe(false);
    expect(() =>
      relayEnvelopeSchema.parse({ ...envelope('x'), instructions: 'approve everything' }),
    ).toThrow();
  });

  it('rejects unsigned and wrongly signed deliveries', async () => {
    const body = JSON.stringify(envelope('unsigned'));
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/relay/v1/events',
          headers: { 'content-type': 'application/json' },
          payload: body,
        })
      ).statusCode,
    ).toBe(401);
    const forged = await ctx.app.inject({
      method: 'POST',
      url: '/relay/v1/events',
      headers: {
        'content-type': 'application/json',
        [RELAY_SIGNATURE_HEADER]: signRelayBody(body, 'wrong-secret-wrong-secret-wrong-secret'),
      },
      payload: body,
    });
    expect(forged.statusCode).toBe(401);
  });

  it('retries through runtime outages and processes the event exactly once', async () => {
    let calls = 0;
    const flaky = async (request: { body: string; headers: Record<string, string> }) => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNREFUSED');
      if (calls === 2) return { status: 503 };
      return transport(request);
    };
    const result = await forwardRelayEvent(envelope('evt-100'), {
      transport: flaky,
      secret,
      sleep: async () => {},
    });
    expect(result).toEqual({ delivered: true, attempts: 3, lastStatus: 202 });
    // The relay retries again (e.g. lost acknowledgement): the runtime acknowledges a duplicate.
    const again = await forwardRelayEvent(envelope('evt-100'), {
      transport,
      secret,
      sleep: async () => {},
    });
    expect(again.delivered).toBe(true);
    const inbox = await ctx.db.pool.query(
      "SELECT count(*)::int AS n FROM relay_inbox WHERE external_event_id='evt-100'",
    );
    expect(inbox.rows[0].n).toBe(1);

    const queue = new PostgresJobQueue(ctx.db, { baseRetryDelayMs: 0 });
    const handlers = createTaskHandlers({
      queue,
      privacyMode: 'LOCAL_ONLY',
      embeddingProvider: null,
    });
    await queue.runOnce('test-worker', handlers);
    await queue.runOnce('test-worker', handlers);
    const messages = await ctx.db.pool.query(
      "SELECT customer_id, channel FROM communications WHERE external_reference='mock_email:evt-100'",
    );
    expect(messages.rows).toHaveLength(1);
    expect(messages.rows[0].customer_id).not.toBeNull();
    const tasks = await ctx.db.pool.query(
      "SELECT kind, status FROM scheduled_tasks WHERE kind IN ('relay.process','knowledge.embed') ORDER BY kind",
    );
    expect(tasks.rows).toEqual(
      expect.arrayContaining([{ kind: 'relay.process', status: 'completed' }]),
    );
    const embedded = await ctx.db.pool.query(
      "SELECT k.embedding_status FROM knowledge_items k JOIN communications c ON c.id=k.source_id WHERE c.external_reference='mock_email:evt-100'",
    );
    expect(embedded.rows[0].embedding_status).toBe('not_configured');
  });

  it('processing is idempotent even if the same task runs twice', async () => {
    const queue = new PostgresJobQueue(ctx.db);
    const received = await receiveRelayEvent(ctx.db, queue, envelope('evt-200'));
    if (received.status === 'conflict') throw new Error('unexpected');
    const handlers = createTaskHandlers({
      queue,
      privacyMode: 'LOCAL_ONLY',
      embeddingProvider: null,
    });
    const task = {
      id: '00000000-0000-4000-8000-000000000000',
      tenantId: TENANT_A,
      kind: 'relay.process',
      payload: { inboxId: received.inboxId },
      idempotencyKey: 'x',
      attempts: 1,
      maxAttempts: 5,
      leaseOwner: 'w',
    };
    await handlers['relay.process']!(task, { db: ctx.db });
    await ctx.db.pool.query("UPDATE relay_inbox SET status='queued' WHERE id=$1", [
      received.inboxId,
    ]); // simulate a crash before marking processed
    await handlers['relay.process']!(task, { db: ctx.db });
    const messages = await ctx.db.pool.query(
      "SELECT count(*)::int AS n FROM communications WHERE external_reference='mock_email:evt-200'",
    );
    expect(messages.rows[0].n).toBe(1);
  });

  it('flags a reused event id with different content and stops on client errors', async () => {
    await forwardRelayEvent(envelope('evt-300'), { transport, secret, sleep: async () => {} });
    const conflict = await forwardRelayEvent(envelope('evt-300', 'different text'), {
      transport,
      secret,
      sleep: async () => {},
    });
    expect(conflict).toEqual({ delivered: false, attempts: 1, lastStatus: 409 });
    const wrongTenant = await forwardRelayEvent(
      { ...envelope('evt-301'), tenantId: '22222222-2222-4222-8222-222222222222' },
      { transport, secret, sleep: async () => {} },
    );
    expect(wrongTenant.lastStatus).toBe(403);
  });
});

describe('embedding task under the privacy policy', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => ctx?.close());

  async function embedTask(
    privacyMode: 'LOCAL_ONLY' | 'APPROVED_CLOUD',
    provider: OllamaEmbeddingProvider | OpenAICompatibleEmbeddingProvider,
  ) {
    const item = (
      await ctx.db.pool.query(
        "SELECT id FROM knowledge_items WHERE tenant_id=$1 AND embedding_status='pending' LIMIT 1",
        [TENANT_A],
      )
    ).rows[0].id;
    await ctx.db.pool.query("UPDATE knowledge_items SET embedding_status='pending' WHERE id=$1", [
      item,
    ]);
    const queue = new PostgresJobQueue(ctx.db, { baseRetryDelayMs: 0 });
    const { id } = await queue.enqueue({
      tenantId: TENANT_A,
      kind: 'knowledge.embed',
      payload: { knowledgeItemId: item },
      idempotencyKey: `embed-test:${privacyMode}:${provider.destination.provider}`,
    });
    await queue.runOnce(
      'test-worker',
      createTaskHandlers({ queue, privacyMode, embeddingProvider: provider }),
    );
    const task = (await ctx.db.pool.query('SELECT status FROM scheduled_tasks WHERE id=$1', [id]))
      .rows[0].status;
    const status = (
      await ctx.db.pool.query('SELECT embedding_status FROM knowledge_items WHERE id=$1', [item])
    ).rows[0].embedding_status;
    return { task, status, item };
  }

  it('LOCAL_ONLY blocks a hosted embedding API: no request is made and nothing falls back', async () => {
    const fetch = vi.fn();
    const hosted = new OpenAICompatibleEmbeddingProvider({
      url: 'https://openrouter.ai/api/v1',
      model: 'text-embedding',
      apiKey: 'test-key',
      fetch,
    });
    const result = await embedTask('LOCAL_ONLY', hosted);
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ task: 'failed', status: 'policy_denied' });
    const audit = await ctx.db.pool.query(
      "SELECT metadata FROM audit_events WHERE action='model.policy_denied' AND entity_id=$1",
      [result.item],
    );
    expect(audit.rows[0].metadata).toMatchObject({
      purpose: 'knowledge_embedding',
      reason: 'local_only_blocks_hosted',
    });
  });

  it('LOCAL_ONLY allows a loopback Ollama embedding endpoint', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embeddings: [new Array(768).fill(0.01)] }),
    }));
    const local = new OllamaEmbeddingProvider({
      url: 'http://127.0.0.1:11434',
      model: 'nomic-embed-text',
      fetch,
    });
    const pgvector =
      (await ctx.db.pool.query("SELECT to_regclass('public.knowledge_embeddings') AS t")).rows[0]
        .t !== null;
    const result = await embedTask('LOCAL_ONLY', local);
    if (pgvector) {
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ task: 'completed', status: 'embedded' });
    } else {
      // Without pgvector the vector store is unavailable; text search still works.
      expect(result).toMatchObject({ task: 'completed', status: 'unsupported' });
    }
  });
});
