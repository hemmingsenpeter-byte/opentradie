import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FormFetch } from '@opentradie/integrations';
import { parseRawEmail, type MailFetch } from '@opentradie/integrations/mail';
import { PostgresJobQueue } from '@opentradie/platform';
import {
  createMailSyncTaskHandlers,
  MAIL_SYNC_KIND,
  syncMailbox,
  type MailSyncDependencies,
} from '../../apps/api/src/services/mail-sync.js';
import {
  createTestContext,
  newKey,
  TENANT_A,
  TENANT_B,
  TEST_CREDENTIAL_KEY,
  type TestContext,
} from '../helpers/app.js';
import { INBOUND_SECRET, postInboundEmail, rawEmail } from '../helpers/email.js';

/** Synthetic data only. */
const enquiry = (messageId = `<${randomUUID()}@customer.example.test>`) =>
  rawEmail({
    from: `sender-${randomUUID().slice(0, 8)}@customer.example.test`,
    subject: 'Heat pump install',
    text: 'Could you quote a heat pump install?',
    messageId,
  });

async function connect(ctx: TestContext, owner: string, provider: string, code: string) {
  const started = await ctx.get(`/api/integrations/mail/${provider}/connect`, owner);
  expect(started.status).toBe(200);
  const state = new URL(started.body.authorizeUrl, 'http://x').searchParams.get('state')!;
  const done = await ctx.app.inject({
    method: 'GET',
    url: `/api/integrations/mail/${provider}/callback?${new URLSearchParams({ code, state })}`,
  });
  expect(done.headers.location).toBe('/#/settings?mail=connected');
}

const connection = async (ctx: TestContext, provider: string) =>
  (
    await ctx.db.pool.query(
      `SELECT status,status_reason AS "statusReason",sync_cursor AS cursor,last_synced_at AS "lastSyncedAt"
       FROM provider_connections WHERE tenant_id=$1 AND provider=$2`,
      [TENANT_A, provider],
    )
  ).rows[0];

const synced = async (ctx: TestContext, messageId: string) =>
  (
    await ctx.db.pool.query(
      `SELECT id,origin,thread_id AS "threadId",customer_id AS "customerId" FROM communications
       WHERE tenant_id=$1 AND message_id_header=$2`,
      [TENANT_A, messageId],
    )
  ).rows;

describe('mailbox sync: fake mailbox (MOCK)', () => {
  let ctx: TestContext;
  let owner: string;
  let deps: MailSyncDependencies;
  const fake = () => ctx.mailRuntime!.fake!;
  const deliver = async (raw: string) =>
    fake().deliver(await parseRawEmail(Buffer.from(raw), 'fake', {}));

  beforeAll(async () => {
    ctx = await createTestContext({
      env: {
        MAIL_PROVIDER: 'fake',
        MAIL_ALLOW_FAKE: 'true',
        CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_KEY,
        INBOUND_EMAIL_SECRET: INBOUND_SECRET,
      },
      seedTenantB: true,
    });
    owner = await ctx.login('owner');
    deps = {
      db: ctx.db,
      queue: new PostgresJobQueue(ctx.db),
      fileStore: ctx.fileStore,
      mail: ctx.mailRuntime,
    };
  });
  afterAll(async () => ctx?.close());

  it('does nothing before the mailbox is connected', async () => {
    expect((await syncMailbox(deps, TENANT_A, 'test')).outcome).toBe('not_connected');
  });

  it('first run starts from now: records the cursor and imports nothing', async () => {
    await connect(ctx, owner, 'fake', 'fake-mail-authorisation-code');
    const queued = await ctx.db.pool.query(
      'SELECT 1 FROM scheduled_tasks WHERE tenant_id=$1 AND kind=$2',
      [TENANT_A, MAIL_SYNC_KIND],
    );
    expect(queued.rowCount).toBe(1);
    const old = `<${randomUUID()}@customer.example.test>`;
    await deliver(enquiry(old));
    const summary = await syncMailbox(deps, TENANT_A, 'test');
    expect(summary).toMatchObject({ outcome: 'cursor_initialised', imported: 0 });
    expect(await synced(ctx, old)).toHaveLength(0);
    const row = await connection(ctx, 'fake_mail');
    expect(row.cursor).toBe('1');
    expect(row.lastSyncedAt).toBeInstanceOf(Date);
  });

  it('a new message becomes one thread, communication and customer; a replay adds nothing', async () => {
    const before = (await connection(ctx, 'fake_mail')).cursor;
    const messageId = `<${randomUUID()}@customer.example.test>`;
    await deliver(enquiry(messageId));
    expect(await syncMailbox(deps, TENANT_A, 'test')).toMatchObject({
      outcome: 'synced',
      imported: 1,
      duplicates: 0,
    });
    const rows = await synced(ctx, messageId);
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe('mailbox_sync');
    expect(rows[0].threadId).toBeTruthy();
    expect(rows[0].customerId).toBeTruthy();
    expect((await connection(ctx, 'fake_mail')).cursor).not.toBe(before);

    // Replaying the same changes (cursor rewound) stores nothing twice.
    await ctx.db.pool.query(
      "UPDATE provider_connections SET sync_cursor=$2 WHERE tenant_id=$1 AND provider='fake_mail'",
      [TENANT_A, before],
    );
    expect(await syncMailbox(deps, TENANT_A, 'test')).toMatchObject({
      imported: 0,
      duplicates: 1,
    });
    expect(await synced(ctx, messageId)).toHaveLength(1);
    const threads = await ctx.db.pool.query(
      'SELECT count(*)::int AS n FROM communication_threads WHERE tenant_id=$1 AND id=$2',
      [TENANT_A, rows[0].threadId],
    );
    expect(threads.rows[0].n).toBe(1);
  });

  it('a message delivered by webhook and then seen by sync is stored once', async () => {
    const messageId = `<${randomUUID()}@customer.example.test>`;
    const raw = enquiry(messageId);
    expect((await postInboundEmail(ctx, raw)).status).toBe(202);
    await deliver(raw);
    expect(await syncMailbox(deps, TENANT_A, 'test')).toMatchObject({
      imported: 0,
      duplicates: 1,
    });
    const rows = await synced(ctx, messageId);
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe('webhook');
  });

  it('does not advance the cursor when ingestion throws', async () => {
    const before = (await connection(ctx, 'fake_mail')).cursor;
    const messageId = `<${randomUUID()}@customer.example.test>`;
    await deliver(enquiry(messageId));
    // The triage enqueue inside the ingestion transaction fails: the batch must not commit.
    const failing = {
      ...deps,
      queue: {
        enqueue: async () => {
          throw new Error('queue down');
        },
      } as unknown as PostgresJobQueue,
    };
    await expect(syncMailbox(failing, TENANT_A, 'test')).rejects.toThrow('queue down');
    expect((await connection(ctx, 'fake_mail')).cursor).toBe(before);
    expect(await synced(ctx, messageId)).toHaveLength(0);
    // The next run picks the message up.
    expect((await syncMailbox(deps, TENANT_A, 'test')).imported).toBe(1);
    expect(await synced(ctx, messageId)).toHaveLength(1);
  });

  it('the task handler chains the next run five minutes later', async () => {
    const queue = new PostgresJobQueue(ctx.db);
    const handlers = createMailSyncTaskHandlers({ ...deps, queue });
    await ctx.db.pool.query(
      "UPDATE scheduled_tasks SET run_at=now() WHERE tenant_id=$1 AND kind=$2 AND status='pending'",
      [TENANT_A, MAIL_SYNC_KIND],
    );
    expect(await queue.runOnce('test-worker', handlers)).toBe(1);
    const next = await ctx.db.pool.query<{ runAt: Date }>(
      `SELECT run_at AS "runAt" FROM scheduled_tasks WHERE tenant_id=$1 AND kind=$2 AND status='pending'`,
      [TENANT_A, MAIL_SYNC_KIND],
    );
    expect(next.rows).toHaveLength(1);
    expect(next.rows[0]!.runAt.getTime()).toBeGreaterThan(Date.now() + 3 * 60_000);
  });

  it('a run that fails keeps the polling cycle alive (one pending task, never duplicated)', async () => {
    const queue = new PostgresJobQueue(ctx.db);
    const broken = {
      ...deps,
      queue,
      mail: {
        ...ctx.mailRuntime!,
        mail: {
          forTenant: async () => {
            throw new Error('provider down');
          },
        },
      } as unknown as MailSyncDependencies['mail'],
    };
    const handler = createMailSyncTaskHandlers(broken)[MAIL_SYNC_KIND]!;
    await ctx.db.pool.query('DELETE FROM scheduled_tasks WHERE tenant_id=$1 AND kind=$2', [
      TENANT_A,
      MAIL_SYNC_KIND,
    ]);
    const task = { id: randomUUID(), tenantId: TENANT_A } as Parameters<typeof handler>[0];
    for (let attempt = 0; attempt < 3; attempt += 1)
      await expect(handler(task, { db: ctx.db })).rejects.toThrow('provider down');
    const pending = await ctx.db.pool.query(
      `SELECT 1 FROM scheduled_tasks WHERE tenant_id=$1 AND kind=$2 AND status='pending'`,
      [TENANT_A, MAIL_SYNC_KIND],
    );
    expect(pending.rowCount).toBe(1);
  });

  it('mail sent by the mailbox itself is skipped, not imported as an enquiry', async () => {
    const messageId = `<${randomUUID()}@customer.example.test>`;
    expect((await postInboundEmail(ctx, enquiry(messageId))).status).toBe(202);
    await ctx.db.pool.query(
      `UPDATE communications SET direction='outbound',provider_message_id=NULL
       WHERE tenant_id=$1 AND message_id_header=$2`,
      [TENANT_A, messageId],
    );
    await deliver(enquiry(messageId));
    expect(await syncMailbox(deps, TENANT_A, 'test')).toMatchObject({
      imported: 0,
      skippedOwn: 1,
    });
  });

  it('owner-only "sync now" route is audited and reports the last sync; tenancy holds', async () => {
    const viewer = await ctx.login('viewer');
    expect((await ctx.send('POST', '/api/integrations/mail/sync', viewer, {})).status).toBe(403);
    await deliver(enquiry());
    const key = newKey();
    const run = await ctx.send('POST', '/api/integrations/mail/sync', owner, {}, { key });
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ outcome: 'synced', imported: 1 });
    expect(typeof run.body.lastSyncedAt).toBe('string');
    const replay = await ctx.send('POST', '/api/integrations/mail/sync', owner, {}, { key });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const audit = await ctx.db.pool.query(
      "SELECT metadata FROM audit_events WHERE tenant_id=$1 AND action='mail.sync_requested'",
      [TENANT_A],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0].metadata)).not.toMatch(/heat pump|@customer/i);
    const status = await ctx.get('/api/integrations/mail/status', viewer);
    expect(status.body.lastSyncedAt).toBe(run.body.lastSyncedAt);
    // Another tenant has no connection: nothing is synced for it.
    expect((await syncMailbox(deps, TENANT_B, 'test')).outcome).toBe('not_connected');
  });
});

/** Fake identity provider (code exchange + refresh). */
const tokenFetch: FormFetch = async () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }),
});
const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const unauthorised = {
  ok: false,
  status: 401,
  headers: { get: () => null },
  text: async () => '{}',
};

describe('mailbox sync: Gmail history.list (fake HTTP)', () => {
  let ctx: TestContext;
  let deps: MailSyncDependencies;
  const calls: string[] = [];
  const messageId = `<${randomUUID()}@customer.example.test>`;
  const state = { revoked: false, historyExpired: false };
  const mailFetch: MailFetch = async (url) => {
    calls.push(url);
    if (state.revoked) return unauthorised;
    if (url.endsWith('/profile')) return ok({ historyId: state.historyExpired ? '900' : '100' });
    if (url.includes('/history?') && state.historyExpired) return { ...unauthorised, status: 404 };
    if (url.includes('/history?'))
      return ok({ history: [{ messagesAdded: [{ message: { id: 'gm1' } }] }], historyId: '105' });
    if (url.includes('/messages/gm1?format=raw'))
      return ok({
        id: 'gm1',
        threadId: 'gt1',
        raw: Buffer.from(enquiry(messageId)).toString('base64url'),
      });
    return { ...unauthorised, status: 404 };
  };

  beforeAll(async () => {
    ctx = await createTestContext({
      env: {
        CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_KEY,
        MAIL_PROVIDER: 'gmail',
        GMAIL_CLIENT_ID: 'test-google-client-id',
        GMAIL_CLIENT_SECRET: 'test-google-client-secret',
        GMAIL_REDIRECT_URI: 'http://localhost:3000/api/integrations/mail/gmail/callback',
      },
      mailOverrides: { tokenFetch, mailFetch },
    });
    deps = {
      db: ctx.db,
      queue: new PostgresJobQueue(ctx.db),
      fileStore: ctx.fileStore,
      mail: ctx.mailRuntime,
    };
    await connect(ctx, await ctx.login('owner'), 'gmail', 'code-1');
  });
  afterAll(async () => ctx?.close());

  it('starts from the profile historyId, then imports added inbox messages', async () => {
    expect((await syncMailbox(deps, TENANT_A, 'test')).outcome).toBe('cursor_initialised');
    expect(calls.some((url) => url.includes('/history'))).toBe(false);
    expect((await connection(ctx, 'gmail')).cursor).toBe('100');
    expect((await syncMailbox(deps, TENANT_A, 'test')).imported).toBe(1);
    expect(calls.find((url) => url.includes('/history?'))).toContain('startHistoryId=100');
    expect((await connection(ctx, 'gmail')).cursor).toBe('105');
    const rows = await synced(ctx, messageId);
    expect(rows).toHaveLength(1);
    // A second delivery of the same id is skipped before fetching.
    const fetches = calls.filter((url) => url.includes('/messages/gm1')).length;
    expect((await syncMailbox(deps, TENANT_A, 'test')).duplicates).toBe(1);
    expect(calls.filter((url) => url.includes('/messages/gm1')).length).toBe(fetches);
  });

  it('an expired startHistoryId (404) restarts from the profile historyId and warns the owner', async () => {
    const owner = await ctx.login('owner');
    expect((await ctx.get('/api/integrations/mail/status', owner)).body.lastSyncWarning).toBeNull();
    state.historyExpired = true;
    expect(await syncMailbox(deps, TENANT_A, 'test')).toMatchObject({
      outcome: 'cursor_reset',
      imported: 0,
    });
    state.historyExpired = false;
    expect((await connection(ctx, 'gmail')).cursor).toBe('900');
    const audit = await ctx.db.pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE tenant_id=$1 AND action='mail.sync_cursor_reset'",
      [TENANT_A],
    );
    expect(audit.rows.map((row) => row.metadata)).toEqual([{ provider: 'gmail', imported: 0 }]);
    const status = (await ctx.get('/api/integrations/mail/status', owner)).body;
    expect(status.lastSyncWarning).toMatchObject({
      code: 'cursor_reset',
      message: 'Some mail may have been missed; check your inbox.',
    });
    // The next run continues from the fresh cursor; nothing from the gap is back-filled.
    expect((await syncMailbox(deps, TENANT_A, 'test')).outcome).toBe('synced');
    expect(calls.at(-1)).toContain('startHistoryId=900');
  });

  it('a revoked grant marks the connection for reauthorisation without throwing', async () => {
    state.revoked = true;
    expect(await syncMailbox(deps, TENANT_A, 'test')).toMatchObject({
      outcome: 'reauthorisation_required',
      errorCode: 'MAIL_REAUTHORISATION_REQUIRED',
    });
    expect(await connection(ctx, 'gmail')).toMatchObject({
      status: 'error',
      statusReason: 'reauthorisation_required',
      cursor: '105',
    });
    const handlers = createMailSyncTaskHandlers(deps);
    await expect(
      handlers[MAIL_SYNC_KIND]!({ id: randomUUID(), tenantId: TENANT_A, payload: {} } as never, {
        db: ctx.db,
      }),
    ).resolves.toBeUndefined();
    expect(ctx.logs.join('\n')).not.toMatch(/refresh-1|access-1/);
  });
});

describe('mailbox sync: Microsoft Graph delta (fake HTTP)', () => {
  let ctx: TestContext;
  let deps: MailSyncDependencies;
  const messageId = `<${randomUUID()}@customer.example.test>`;
  const DELTA = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta';
  const graphState = { expired: false };
  const mailFetch: MailFetch = async (url) => {
    if (graphState.expired && url === `${DELTA}?$deltatoken=B`)
      return { ...unauthorised, status: 410 };
    if (url.startsWith(`${DELTA}?$select=id`))
      return ok({ value: [{ id: 'existing' }], '@odata.deltaLink': `${DELTA}?$deltatoken=A` });
    if (url === `${DELTA}?$deltatoken=A`)
      return ok({
        value: [{ id: 'g1' }, { id: 'gone', '@removed': { reason: 'deleted' } }],
        '@odata.deltaLink': `${DELTA}?$deltatoken=B`,
      });
    if (url.endsWith('/$value')) return ok(enquiry(messageId));
    if (url.includes('/messages/g1?')) return ok({ id: 'g1', conversationId: 'c1' });
    return { ...unauthorised, status: 404 };
  };

  beforeAll(async () => {
    ctx = await createTestContext({
      env: {
        CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_KEY,
        MAIL_PROVIDER: 'microsoft_graph',
        MS_GRAPH_CLIENT_ID: 'test-entra-client-id',
        MS_GRAPH_CLIENT_SECRET: 'test-entra-client-secret',
        MS_GRAPH_REDIRECT_URI:
          'http://localhost:3000/api/integrations/mail/microsoft_graph/callback',
      },
      mailOverrides: { tokenFetch, mailFetch },
    });
    deps = {
      db: ctx.db,
      queue: new PostgresJobQueue(ctx.db),
      fileStore: ctx.fileStore,
      mail: ctx.mailRuntime,
    };
    await connect(ctx, await ctx.login('owner'), 'microsoft_graph', 'code-1');
  });
  afterAll(async () => ctx?.close());

  it('stores the delta link without importing existing mail, then follows it', async () => {
    expect((await syncMailbox(deps, TENANT_A, 'test')).outcome).toBe('cursor_initialised');
    expect((await connection(ctx, 'microsoft_graph')).cursor).toBe(`${DELTA}?$deltatoken=A`);
    expect((await syncMailbox(deps, TENANT_A, 'test')).imported).toBe(1);
    expect((await connection(ctx, 'microsoft_graph')).cursor).toBe(`${DELTA}?$deltatoken=B`);
    expect(await synced(ctx, messageId)).toHaveLength(1);
  });

  it('a delta link Graph no longer accepts (410 Gone) restarts from a fresh delta and warns', async () => {
    graphState.expired = true;
    expect(await syncMailbox(deps, TENANT_A, 'test')).toMatchObject({
      outcome: 'cursor_reset',
      imported: 0,
    });
    expect((await connection(ctx, 'microsoft_graph')).cursor).toBe(`${DELTA}?$deltatoken=A`);
    const audit = await ctx.db.pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE tenant_id=$1 AND action='mail.sync_cursor_reset'",
      [TENANT_A],
    );
    expect(audit.rows.map((row) => row.metadata)).toEqual([
      { provider: 'microsoft_graph', imported: 0 },
    ]);
    const owner = await ctx.login('owner');
    const status = (await ctx.get('/api/integrations/mail/status', owner)).body;
    expect(status.lastSyncWarning?.message).toBe(
      'Some mail may have been missed; check your inbox.',
    );
  });
});
