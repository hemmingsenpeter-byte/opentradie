import type { AgentRuntime } from '@opentradie/agent';
import { recordAudit, databaseStatus, transaction, type Database } from '@opentradie/database';
import {
  describeConfig,
  receiveRelayEvent,
  relayEnvelopeSchema,
  RELAY_SIGNATURE_HEADER,
  verifyRelaySignature,
  type FileStore,
  type PostgresJobQueue,
  type RuntimeConfig,
} from '@opentradie/platform';
import type { EmbeddingProvider } from '@opentradie/core';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, type RouteRegistry } from '../http.js';
import { errorResponse, healthResponse, loginBody, userResponse } from '../schemas.js';
import { agentHealthWithTimeout } from '../services/agent-info.js';
import { hashPassword, verifyPassword } from '@opentradie/core';

export const SESSION_COOKIE = 'opentradie_session';
export const SESSION_HOURS = 8;
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const APP_VERSION = '0.1.0';

export async function registerSystemRoutes(
  app: FastifyInstance,
  api: RouteRegistry,
  deps: { db: Database; runtime: AgentRuntime; config: RuntimeConfig; fileStore: FileStore; queue: PostgresJobQueue; embeddingProvider: EmbeddingProvider | null },
) {
  const { db, runtime, config, fileStore } = deps;
  // A fixed dummy hash makes unknown-user logins cost the same as real ones.
  const dummyPasswordHash = await hashPassword(randomBytes(32).toString('hex'));

  api.route(
    {
      method: 'GET',
      url: '/health',
      summary: 'Deployment profile, privacy mode, agent mode/health, database and storage status. No secrets.',
      tags: ['system'],
      auth: 'public',
      responses: { 200: { description: 'Healthy or degraded', schema: healthResponse }, 503: { description: 'Database unavailable', schema: healthResponse } },
    },
    async () => {
      const [database, agent, files] = await Promise.all([databaseStatus(db), agentHealthWithTimeout(runtime), fileStore.health()]);
      const safe = describeConfig(config);
      const body: z.infer<typeof healthResponse> = {
        status: database.status !== 'ok' ? 'unavailable' : agent?.status === 'ok' && files.status === 'ok' ? 'ok' : 'degraded',
        version: APP_VERSION,
        deployment: { profile: safe.profile, installationId: safe.installationId, authoritative: safe.authoritative },
        privacyMode: config.privacyMode,
        agent: {
          mode: config.agent.mode,
          status: agent?.status ?? 'unavailable',
          synthetic: agent?.synthetic ?? config.agent.mode === 'mock',
          provider: agent?.provider ?? 'unavailable',
          version: agent?.version ?? 'unknown',
          inferenceLocation: agent?.inferenceLocation ?? 'unverified',
          attestation: agent?.attestation ?? 'runtime',
          label: agent?.synthetic ? (agent.detail ?? null) : null,
        },
        database,
        fileStore: { kind: fileStore.kind, status: files.status },
        embeddings: { provider: deps.embeddingProvider?.destination.provider ?? 'none', location: deps.embeddingProvider?.destination.location ?? null },
      };
      return { status: database.status === 'ok' ? 200 : 503, body };
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/auth/login',
      summary: 'Sign in; sets an HttpOnly, SameSite=Strict signed session cookie. Rate limited.',
      tags: ['auth'],
      auth: 'public',
      body: loginBody,
      rateLimit: { max: 10, timeWindow: '1 minute' },
      responses: { 200: { description: 'Signed in', schema: z.object({ user: userResponse }) }, 401: { description: 'INVALID_CREDENTIALS', schema: errorResponse }, 429: { description: 'Too many attempts', schema: errorResponse } },
    },
    async ({ body, request, reply }) => {
      const found = await db.pool.query<{ id: string; tenantId: string; email: string; displayName: string; role: 'owner' | 'viewer'; passwordHash: string }>(
        'SELECT id,tenant_id AS "tenantId",email,display_name AS "displayName",role,password_hash AS "passwordHash" FROM users WHERE tenant_id=$1 AND email=$2 AND active=true',
        [config.tenantId, body.email.toLowerCase()],
      );
      const record = found.rows[0];
      const valid = await verifyPassword(body.password, record?.passwordHash ?? dummyPasswordHash);
      if (!record || !valid) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
      const token = randomBytes(32).toString('base64url');
      await transaction(db, async (client) => {
        await client.query(`INSERT INTO sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now() + interval '${SESSION_HOURS} hours')`, [tokenHash(token), record.tenantId, record.id]);
        await client.query('DELETE FROM sessions WHERE expires_at < now()');
        await recordAudit(client, { tenantId: record.tenantId, actorType: 'user', actorId: record.id, action: 'session.login', entityType: 'user', entityId: record.id, requestId: request.id });
      });
      reply.setCookie(SESSION_COOKIE, token, { signed: true, httpOnly: true, secure: config.secureCookies, sameSite: 'strict', path: '/', maxAge: SESSION_HOURS * 3600 });
      const { passwordHash: _passwordHash, ...user } = record;
      return { body: { user } };
    },
  );

  api.route(
    { method: 'POST', url: '/api/auth/logout', summary: 'Sign out and revoke the session', tags: ['auth'], auth: 'user', responses: { 200: { description: 'Signed out' } } },
    async ({ request, reply, user }) => {
      const signed = request.cookies[SESSION_COOKIE];
      const token = signed ? request.unsignCookie(signed) : null;
      await transaction(db, async (client) => {
        if (token?.valid && token.value) await client.query('DELETE FROM sessions WHERE token_hash=$1 AND tenant_id=$2', [tokenHash(token.value), user.tenantId]);
        await recordAudit(client, { tenantId: user.tenantId, actorType: 'user', actorId: user.id, action: 'session.logout', entityType: 'user', entityId: user.id, requestId: request.id });
      });
      reply.clearCookie(SESSION_COOKIE, { path: '/', secure: config.secureCookies, sameSite: 'strict', httpOnly: true });
      return { body: { ok: true } };
    },
  );

  api.route(
    { method: 'GET', url: '/api/me', summary: 'The signed-in user', tags: ['auth'], auth: 'user', responses: { 200: { description: 'User', schema: userResponse } } },
    async ({ user }) => ({ body: user }),
  );

  // Relay ingress: authenticated by HMAC signature (not a session), so it needs the raw body.
  if (config.relaySharedSecret) {
    const secret = config.relaySharedSecret;
    await app.register(async (scope) => {
      scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 65_536 }, (_request, body, done) => done(null, body));
      api.scoped(scope).route(
        {
          method: 'POST',
          url: '/relay/v1/events',
          summary: 'Signed relay event ingress (HMAC-SHA256, 5 minute tolerance). Deduplicated by source and event id.',
          tags: ['relay'],
          auth: 'public',
          rateLimit: { max: 600, timeWindow: '1 minute' },
          responses: { 202: { description: 'Accepted or duplicate' }, 401: { description: 'Bad signature', schema: errorResponse }, 409: { description: 'Same event id, different payload', schema: errorResponse } },
        },
        async ({ request }) => {
          const raw = typeof request.body === 'string' ? request.body : '';
          if (!verifyRelaySignature(raw, request.headers[RELAY_SIGNATURE_HEADER] as string | undefined, secret)) throw new HttpError(401, 'INVALID_SIGNATURE', 'Relay signature invalid or expired.');
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(raw);
          } catch {
            throw new HttpError(400, 'VALIDATION_ERROR', 'Relay body is not JSON.');
          }
          const envelope = relayEnvelopeSchema.parse(parsedJson);
          if (envelope.tenantId !== config.tenantId) throw new HttpError(403, 'WRONG_RUNTIME', 'This runtime does not serve that business.');
          const result = await receiveRelayEvent(db, deps.queue, envelope);
          if (result.status === 'conflict') throw new HttpError(409, 'EVENT_CONFLICT', 'Event id was already delivered with different content.');
          return { status: 202, body: result };
        },
      );
    });
  }
}
