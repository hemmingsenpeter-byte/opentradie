import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockAgentRuntime } from '@opentradie/agent';
import type { FormFetch } from '@opentradie/integrations';
import type { MailFetch } from '@opentradie/integrations/mail';
import { PostgresJobQueue } from '@opentradie/platform';
import { createInboxTaskHandlers } from '../../apps/api/src/services/inbox.js';
import {
  createTestContext,
  TENANT_A,
  TENANT_B,
  TEST_CREDENTIAL_KEY,
  type TestContext,
} from '../helpers/app.js';
import { INBOUND_SECRET, postInboundEmail, rawEmail } from '../helpers/email.js';

const ORIGIN_ENV = (provider: 'gmail' | 'microsoft_graph'): Record<string, string> =>
  provider === 'gmail'
    ? {
        MAIL_PROVIDER: 'gmail',
        GMAIL_CLIENT_ID: 'test-google-client-id',
        GMAIL_CLIENT_SECRET: 'test-google-client-secret',
        GMAIL_REDIRECT_URI: 'http://localhost:3000/api/integrations/mail/gmail/callback',
      }
    : {
        MAIL_PROVIDER: 'microsoft_graph',
        MS_GRAPH_CLIENT_ID: 'test-entra-client-id',
        MS_GRAPH_CLIENT_SECRET: 'test-entra-client-secret',
        MS_GRAPH_REDIRECT_URI:
          'http://localhost:3000/api/integrations/mail/microsoft_graph/callback',
      };

interface TokenCall {
  url: string;
  form: URLSearchParams;
}
interface MailCall {
  url: string;
  method: string;
  token: string;
  body: string | undefined;
}

/** A fake identity provider + mail API behind the injectable fetches. Synthetic values only. */
function fakeProvider() {
  const tokenCalls: TokenCall[] = [];
  const mailCalls: MailCall[] = [];
  let issued = 0;
  const state = { refreshRevoked: false };
  const tokenFetch: FormFetch = async (url, init) => {
    const form = new URLSearchParams(init.body);
    tokenCalls.push({ url, form });
    if (form.get('grant_type') === 'refresh_token' && state.refreshRevoked)
      return {
        ok: false,
        status: 400,
        headers: { get: () => null },
        json: async () => ({ error: 'invalid_grant' }),
      };
    issued++;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        access_token: `access-${issued}`,
        // Google-style: a refresh token only on the code exchange.
        ...(form.get('grant_type') === 'authorization_code'
          ? { refresh_token: 'refresh-secret-1' }
          : {}),
        expires_in: 3600,
      }),
    };
  };
  const mailFetch: MailFetch = async (url, init) => {
    mailCalls.push({
      url,
      method: init.method,
      token: init.headers.authorization ?? '',
      body: init.body,
    });
    const n = mailCalls.length;
    const json = url.endsWith('/messages/send')
      ? { id: `gmail-sent-${n}`, threadId: 'gmail-thread-1' }
      : url.endsWith('/createReply') || url.endsWith('/me/messages')
        ? { id: `graph-draft-${n}`, conversationId: 'graph-conv-1' }
        : {};
    return {
      ok: true,
      status: url.endsWith('/send') && !url.includes('gmail') ? 202 : 200,
      headers: { get: () => null },
      text: async () =>
        url.endsWith('/send') && !url.includes('gmail') ? '' : JSON.stringify(json),
    };
  };
  return { tokenCalls, mailCalls, tokenFetch, mailFetch, state };
}

async function setup(provider: 'gmail' | 'microsoft_graph') {
  const fake = fakeProvider();
  let nowMs = Date.now();
  const now = () => new Date(nowMs);
  const ctx = await createTestContext({
    env: {
      INBOUND_EMAIL_SECRET: INBOUND_SECRET,
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_KEY,
      ...ORIGIN_ENV(provider),
    },
    runtime: new MockAgentRuntime(),
    seedTenantB: true,
    mailOverrides: { tokenFetch: fake.tokenFetch, mailFetch: fake.mailFetch, now },
  });
  const queue = new PostgresJobQueue(ctx.db, { baseRetryDelayMs: 0 });
  const handlers = createInboxTaskHandlers({
    db: ctx.db,
    runtime: new MockAgentRuntime(),
    config: ctx.config,
    mail: ctx.mailRuntime!.mail,
  });
  const runTasks = async () => {
    for (let i = 0; i < 10; i++) if ((await queue.runOnce('test-worker', handlers)) === 0) break;
  };
  return {
    ctx,
    fake,
    runTasks,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const callback = (ctx: TestContext, provider: string, query: Record<string, string>) =>
  ctx.app.inject({
    method: 'GET',
    url: `/api/integrations/mail/${provider}/callback?${new URLSearchParams(query)}`,
  });

async function connect(ctx: TestContext, owner: string, provider: string) {
  const started = await ctx.get(`/api/integrations/mail/${provider}/connect`, owner);
  expect(started.status).toBe(200);
  const url = new URL(started.body.authorizeUrl);
  return { url, state: url.searchParams.get('state')! };
}

/** Ingests an inbound enquiry, lets the mock agent draft a reply and approves it. */
async function approvedReply(env: Awaited<ReturnType<typeof setup>>, owner: string) {
  const { ctx, runTasks } = env;
  const messageId = `<${randomUUID()}@customer.example.test>`;
  const received = await postInboundEmail(
    ctx,
    rawEmail({
      from: 'aroha.ngata@customer.example.test',
      subject: 'Heat pump install',
      text: 'Could you quote a heat pump install?',
      messageId,
    }),
  );
  expect(received.status).toBe(202);
  await runTasks();
  const draftId = (
    await ctx.db.pool.query(
      "SELECT id FROM communications WHERE tenant_id=$1 AND reply_to_communication_id=$2 AND origin='agent_draft'",
      [TENANT_A, received.body.communicationId],
    )
  ).rows[0].id as string;
  await ctx.db.pool.query(
    'UPDATE communications SET provider_message_id=$3 WHERE tenant_id=$1 AND id=$2',
    [TENANT_A, received.body.communicationId, `inbound-${draftId.slice(0, 8)}`],
  );
  await ctx.db.pool.query(
    "UPDATE communications SET provider_thread_id='thread-abc' WHERE tenant_id=$1 AND id=$2",
    [TENANT_A, draftId],
  );
  const approved = await ctx.send('POST', `/api/communications/${draftId}/approve-send`, owner, {});
  expect(approved.status).toBe(202);
  return { draftId, messageId, inboundId: `inbound-${draftId.slice(0, 8)}` };
}

const communication = async (ctx: TestContext, id: string) =>
  (
    await ctx.db.pool.query(
      'SELECT status,send_error_code AS code FROM communications WHERE tenant_id=$1 AND id=$2',
      [TENANT_A, id],
    )
  ).rows[0];

describe('mail OAuth connection: Gmail (fake HTTP)', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  let owner: string;
  let viewer: string;
  beforeAll(async () => {
    env = await setup('gmail');
    owner = await env.ctx.login('owner');
    viewer = await env.ctx.login('viewer');
  });
  afterAll(async () => env?.ctx.close());

  it('only the owner connects or disconnects; viewers see status', async () => {
    const { ctx } = env;
    expect((await ctx.get('/api/integrations/mail/gmail/connect', viewer)).status).toBe(403);
    expect((await ctx.send('POST', '/api/integrations/mail/gmail/disconnect', viewer)).status).toBe(
      403,
    );
    const status = await ctx.get('/api/integrations/mail/status', viewer);
    expect(status.body).toMatchObject({ provider: 'gmail', mock: false, status: 'disconnected' });
    // A provider this installation is not configured for.
    expect(
      (await ctx.get('/api/integrations/mail/microsoft_graph/connect', owner)).body.error,
    ).toBe('MAIL_PROVIDER_NOT_CONFIGURED');
  });

  it('starts consent with hashed single-use state and a sealed PKCE verifier', async () => {
    const { ctx } = env;
    const { url, state } = await connect(ctx, owner, 'gmail');
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const row = (
      await ctx.db.pool.query(
        "SELECT state_hash,sealed_verifier FROM oauth_authorisations WHERE tenant_id=$1 AND provider='gmail' ORDER BY created_at DESC LIMIT 1",
        [TENANT_A],
      )
    ).rows[0];
    expect(row.state_hash).toBe(createHash('sha256').update(state).digest('hex'));
    expect(row.sealed_verifier).toBeInstanceOf(Buffer);

    // Unknown and expired states are refused without a token exchange.
    const before = env.fake.tokenCalls.length;
    expect((await callback(ctx, 'gmail', { code: 'c', state: 'unknown' })).headers.location).toBe(
      '/#/settings?mail=invalid_state',
    );
    const expired = await connect(ctx, owner, 'gmail');
    await ctx.db.pool.query(
      "UPDATE oauth_authorisations SET expires_at=now()-interval '1 minute' WHERE state_hash=$1",
      [createHash('sha256').update(expired.state).digest('hex')],
    );
    expect(
      (await callback(ctx, 'gmail', { code: 'c', state: expired.state })).headers.location,
    ).toBe('/#/settings?mail=invalid_state');
    // State minted for Gmail is not accepted on another provider's callback.
    expect((await callback(ctx, 'fake', { code: 'c', state })).headers.location).toBe(
      '/#/settings?mail=invalid_state',
    );
    expect(env.fake.tokenCalls.length).toBe(before);

    const done = await callback(ctx, 'gmail', { code: 'auth-code-1', state, scope: 'x' });
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe('/#/settings?mail=connected');
    const exchange = env.fake.tokenCalls.at(-1)!;
    expect(exchange.url).toBe('https://oauth2.googleapis.com/token');
    expect(exchange.form.get('grant_type')).toBe('authorization_code');
    expect(exchange.form.get('client_secret')).toBe('test-google-client-secret');
    expect(
      createHash('sha256').update(exchange.form.get('code_verifier')!).digest('base64url'),
    ).toBe(url.searchParams.get('code_challenge'));

    // Replay of a used state is refused.
    expect((await callback(ctx, 'gmail', { code: 'auth-code-1', state })).headers.location).toBe(
      '/#/settings?mail=invalid_state',
    );

    // Tokens are sealed at rest.
    const stored = (
      await ctx.db.pool.query(
        "SELECT status,encrypted_credentials FROM provider_connections WHERE tenant_id=$1 AND provider='gmail'",
        [TENANT_A],
      )
    ).rows[0];
    expect(stored.status).toBe('connected');
    const bytes = (stored.encrypted_credentials as Buffer).toString('latin1');
    expect(bytes).not.toContain('refresh-secret-1');
    expect(bytes).not.toContain('access-');
    expect((await ctx.get('/api/integrations/mail/gmail/status', viewer)).body.status).toBe(
      'connected',
    );
    // Tenancy: another tenant has no mailbox.
    expect(await ctx.mailRuntime!.mail.forTenant(TENANT_B)).toBeNull();
  });

  it('sends an approved reply through users.messages.send with threading headers', async () => {
    const { ctx, runTasks, fake } = env;
    const { draftId, messageId } = await approvedReply(env, owner);
    await runTasks();
    expect(await communication(ctx, draftId)).toEqual({ status: 'sent', code: null });
    const send = fake.mailCalls.filter((call) => call.url.endsWith('/messages/send'));
    expect(send).toHaveLength(1);
    expect(send[0]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(send[0]!.token).toBe('Bearer access-1');
    const body = JSON.parse(send[0]!.body!);
    expect(body.threadId).toBe('thread-abc');
    expect(body.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const mime = Buffer.from(body.raw, 'base64url').toString('utf8');
    expect(mime).toContain(`In-Reply-To: ${messageId}`);
    expect(mime).toMatch(new RegExp(`References:.*${messageId.replace(/[.]/g, '\\.')}`));
    // Re-running the queue never sends again.
    await runTasks();
    expect(fake.mailCalls.filter((call) => call.url.endsWith('/messages/send'))).toHaveLength(1);
  });

  it('refreshes an expired access token under the row lock before sending', async () => {
    const { ctx, runTasks, fake } = env;
    env.advance(2 * 3600_000);
    const { draftId } = await approvedReply(env, owner);
    await runTasks();
    expect(await communication(ctx, draftId)).toEqual({ status: 'sent', code: null });
    const refresh = fake.tokenCalls.at(-1)!;
    expect(refresh.form.get('grant_type')).toBe('refresh_token');
    expect(refresh.form.get('refresh_token')).toBe('refresh-secret-1');
    expect(fake.mailCalls.at(-1)!.token).toBe('Bearer access-2');
  });

  it('a revoked grant fails the send visibly with MAIL_REAUTHORISATION_REQUIRED and never resends', async () => {
    const { ctx, runTasks, fake } = env;
    env.advance(2 * 3600_000);
    fake.state.refreshRevoked = true;
    const sendsBefore = fake.mailCalls.length;
    const { draftId } = await approvedReply(env, owner);
    await runTasks();
    expect(await communication(ctx, draftId)).toEqual({
      status: 'failed',
      code: 'MAIL_REAUTHORISATION_REQUIRED',
    });
    expect(fake.mailCalls.length).toBe(sendsBefore);
    const status = await ctx.get('/api/integrations/mail/status', owner);
    expect(status.body).toMatchObject({
      status: 'error',
      statusReason: 'reauthorisation_required',
    });
    // Re-approving fails fast on the errored connection, still sending nothing.
    expect(
      (await ctx.send('POST', `/api/communications/${draftId}/approve-send`, owner, {})).status,
    ).toBe(202);
    await runTasks();
    expect(await communication(ctx, draftId)).toEqual({
      status: 'failed',
      code: 'MAIL_REAUTHORISATION_REQUIRED',
    });
    expect(fake.mailCalls.length).toBe(sendsBefore);
    // Logs never carry tokens.
    expect(ctx.logs.join('\n')).not.toMatch(/refresh-secret-1|access-\d/);
  });

  it('disconnect deletes the stored tokens', async () => {
    const { ctx } = env;
    expect(
      (await ctx.send('POST', '/api/integrations/mail/gmail/disconnect', owner)).body.status,
    ).toBe('disconnected');
    const row = (
      await ctx.db.pool.query(
        "SELECT status,encrypted_credentials FROM provider_connections WHERE tenant_id=$1 AND provider='gmail'",
        [TENANT_A],
      )
    ).rows[0];
    expect(row).toEqual({ status: 'disconnected', encrypted_credentials: null });
  });
});

describe('mail OAuth connection: Microsoft Graph (fake HTTP)', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  let owner: string;
  beforeAll(async () => {
    env = await setup('microsoft_graph');
    owner = await env.ctx.login('owner');
  });
  afterAll(async () => env?.ctx.close());

  it('connects through the Microsoft identity platform and replies via createReply + send', async () => {
    const { ctx, fake, runTasks } = env;
    const { url, state } = await connect(ctx, owner, 'microsoft_graph');
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('scope')!.split(' ')).toEqual(
      expect.arrayContaining(['offline_access', 'Mail.Send', 'Mail.Read']),
    );
    expect(
      (await callback(ctx, 'microsoft_graph', { code: 'ms-code', state })).headers.location,
    ).toBe('/#/settings?mail=connected');
    expect(fake.tokenCalls.at(-1)!.url).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    );
    const { draftId, inboundId } = await approvedReply(env, owner);
    await runTasks();
    expect(await communication(ctx, draftId)).toEqual({ status: 'sent', code: null });
    const calls = fake.mailCalls.map((call) => `${call.method} ${call.url}`);
    expect(calls).toEqual([
      `POST https://graph.microsoft.com/v1.0/me/messages/${inboundId}/createReply`,
      'PATCH https://graph.microsoft.com/v1.0/me/messages/graph-draft-1',
      'POST https://graph.microsoft.com/v1.0/me/messages/graph-draft-1/send',
    ]);

    // Refresh sends the scopes (Microsoft) and a revoked grant needs reauthorisation.
    env.advance(2 * 3600_000);
    fake.state.refreshRevoked = true;
    const second = await approvedReply(env, owner);
    await runTasks();
    expect(fake.tokenCalls.at(-1)!.form.get('scope')).toContain('offline_access');
    expect(await communication(ctx, second.draftId)).toEqual({
      status: 'failed',
      code: 'MAIL_REAUTHORISATION_REQUIRED',
    });
    expect(fake.mailCalls).toHaveLength(3);
  });
});

describe('mail OAuth connection: fake mailbox (MOCK)', () => {
  it('connects without a consent screen, labels itself mock and is refused in production', async () => {
    const ctx = await createTestContext({
      env: {
        MAIL_PROVIDER: 'fake',
        MAIL_ALLOW_FAKE: 'true',
        CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_KEY,
      },
    });
    try {
      const owner = await ctx.login('owner');
      const { url } = await connect(ctx, owner, 'fake');
      const done = await ctx.app.inject({ method: 'GET', url: url.pathname + url.search });
      expect(done.headers.location).toBe('/#/settings?mail=connected');
      expect((await ctx.get('/api/integrations/mail/status', owner)).body).toMatchObject({
        provider: 'fake',
        mock: true,
        status: 'connected',
      });
      expect(await ctx.mailRuntime!.mail.forTenant(TENANT_A)).toBe(ctx.mailRuntime!.fake);
    } finally {
      await ctx.close();
    }
  });
});

describe('mail configuration', () => {
  it('refuses the fake mailbox without opt-in, in the cloud profile and in production', async () => {
    const { loadRuntimeConfig } = await import('@opentradie/platform');
    const { baseEnv } = await import('../helpers/app.js');
    const env = (extra: Record<string, string>) =>
      baseEnv('postgres://u:p@127.0.0.1:5432/x', {
        CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_KEY,
        MAIL_PROVIDER: 'fake',
        ...extra,
      });
    expect(() => loadRuntimeConfig(env({}))).toThrow(/MAIL_ALLOW_FAKE/);
    expect(() =>
      loadRuntimeConfig({ ...env({ MAIL_ALLOW_FAKE: 'true' }), NODE_ENV: 'production' }),
    ).toThrow(/not allowed/);
    expect(() =>
      loadRuntimeConfig(
        baseEnv('postgres://u:p@127.0.0.1:5432/x', {
          MAIL_PROVIDER: 'gmail',
          CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_KEY,
        }),
      ),
    ).toThrow(/GMAIL_CLIENT_ID/);
  });
});
