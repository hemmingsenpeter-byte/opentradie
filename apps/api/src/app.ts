import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Writable } from 'node:stream';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import serveStatic from '@fastify/static';
import { AgentRuntimeError, type AgentRuntime } from '@opentradie/agent';
import { LOG_REDACT_PATHS, PolicyDeniedError, type EmbeddingProvider } from '@opentradie/core';
import type { Database } from '@opentradie/database';
import { noMailConnections, type MailConnections } from '@opentradie/integrations/mail';
import { PostgresJobQueue, type FileStore, type RuntimeConfig } from '@opentradie/platform';
import Fastify, { LogController, type FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { HttpError, RouteRegistry, type UserContext } from './http.js';
import { buildOpenApiDocument } from './openapi.js';
import { registerAssistantRoutes } from './routes/assistant.js';
import { registerExportRoutes } from './routes/export.js';
import { registerInboxRoutes } from './routes/inbox.js';
import { registerJobCardRoutes } from './routes/job-cards.js';
import { registerPublicQuoteRoutes } from './routes/public-quotes.js';
import { registerQuoteRoutes } from './routes/quotes.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerRecordRoutes } from './routes/records.js';
import { registerSystemRoutes, SESSION_COOKIE, tokenHash } from './routes/system.js';

export interface AppDependencies {
  db: Database;
  runtime: AgentRuntime;
  config: RuntimeConfig;
  fileStore: FileStore;
  embeddingProvider?: EmbeddingProvider | null;
  queue?: PostgresJobQueue;
  /** Mail connection per tenant; none by default (sending fails visibly with NO_MAIL_CONNECTION). */
  mail?: MailConnections;
  /** Structured log destination (tests capture it to prove redaction). */
  logStream?: Writable;
  /** Directory of the built web app; served when present. */
  webRoot?: string;
}

const CORRELATION_ID = /^[A-Za-z0-9_-]{8,128}$/;
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

export async function buildApp(deps: AppDependencies) {
  const { db, config } = deps;
  const queue = deps.queue ?? new PostgresJobQueue(db);
  const app = Fastify({
    bodyLimit: 65_536,
    trustProxy: config.profile === 'cloud',
    requestIdHeader: false,
    genReqId: (request) => {
      const supplied = request.headers['x-correlation-id'];
      return typeof supplied === 'string' && CORRELATION_ID.test(supplied)
        ? supplied
        : randomUUID();
    },
    // Our own onResponse hook logs route patterns only; Fastify's default request logs include URLs.
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: config.logLevel,
      redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
  });

  await app.register(cookie, { secret: config.sessionSecret, hook: 'onRequest' });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.decorateRequest('currentUser', null);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('x-correlation-id', request.id);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    if (config.secureCookies) reply.header('strict-transport-security', 'max-age=31536000');
    const path = request.url.split('?')[0]!;
    if (!path.startsWith('/api/')) return;
    // CSRF defence for cookie-authenticated mutations (in addition to SameSite=Strict).
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      request.headers.origin !== config.appOrigin
    ) {
      throw new HttpError(403, 'ORIGIN_REJECTED', 'Request origin is not allowed.');
    }
    const signed = request.cookies[SESSION_COOKIE];
    const token = signed ? request.unsignCookie(signed) : null;
    if (!token?.valid || !token.value) return;
    // Tenant identity comes only from the server-side session joined to this runtime's tenant.
    const found = await db.pool.query<UserContext>(
      `SELECT u.id,u.tenant_id AS "tenantId",u.email,u.display_name AS "displayName",u.role
       FROM sessions s JOIN users u ON u.id=s.user_id AND u.tenant_id=s.tenant_id
       WHERE s.token_hash=$1 AND s.tenant_id=$2 AND s.expires_at>now() AND u.active=true`,
      [tokenHash(token.value), config.tenantId],
    );
    request.currentUser = found.rows[0] ?? null;
  });

  app.addHook('onResponse', async (request, reply) => {
    // Route pattern only: query strings and bodies may contain customer data.
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
  });

  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    const send = (
      status: number,
      code: string,
      message: string,
      extra: Record<string, unknown> = {},
    ) => reply.status(status).send({ error: code, message, requestId: request.id, ...extra });
    if (error instanceof ZodError) {
      return send(400, 'VALIDATION_ERROR', 'Check the request fields and try again.', {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    if (error instanceof HttpError)
      return send(error.statusCode, error.code, error.message, error.extra);
    if (error instanceof PolicyDeniedError) {
      const { destination, dataCategories, reason, mode, explanation } = error.decision;
      return send(error.code === 'MODEL_POLICY_DENIED' ? 403 : 409, error.code, explanation, {
        decision: { destination, dataCategories, reason, mode },
      });
    }
    if (error instanceof AgentRuntimeError) {
      if (error.code === 'INVALID_OUTPUT')
        return send(
          502,
          'AGENT_INVALID_OUTPUT',
          'The assistant returned an invalid proposal. Nothing was created; enter the job manually or retry.',
        );
      if (error.code === 'INVALID_REQUEST')
        return send(400, 'AGENT_REQUEST_REJECTED', 'The assistant could not accept this request.');
      return send(
        503,
        'AGENT_UNAVAILABLE',
        'The assistant is unavailable. Your enquiry was not processed.',
      );
    }
    const status =
      'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status === 429)
      return send(429, 'RATE_LIMITED', 'Too many requests. Wait a minute and try again.');
    if (status >= 400 && status < 500)
      return send(
        status,
        'REQUEST_REJECTED',
        status === 415 ? 'Send JSON request content.' : 'The request was rejected.',
      );
    // Log the class and code only: messages from drivers or providers may echo data.
    request.log.error(
      {
        requestId: request.id,
        errorName: error.name,
        code: 'code' in error ? error.code : undefined,
      },
      'request failed',
    );
    return send(500, 'INTERNAL_ERROR', 'The request could not be completed. Please try again.');
  });

  const api = new RouteRegistry(app, db);
  const embeddingProvider = deps.embeddingProvider ?? null;
  await registerSystemRoutes(app, api, {
    db,
    runtime: deps.runtime,
    config,
    fileStore: deps.fileStore,
    queue,
    embeddingProvider,
  });
  registerRecordRoutes(api, { db, runtime: deps.runtime, config });
  registerAssistantRoutes(api, { db, runtime: deps.runtime, config, queue });
  registerQuoteRoutes(api, { fileStore: deps.fileStore, queue, config });
  registerPublicQuoteRoutes(api, { db, config, fileStore: deps.fileStore });
  registerSettingsRoutes(api);
  registerJobCardRoutes(api, { fileStore: deps.fileStore });
  registerExportRoutes(api, { db });
  await registerInboxRoutes(app, api, {
    db,
    queue,
    runtime: deps.runtime,
    config,
    fileStore: deps.fileStore,
    mail: deps.mail ?? noMailConnections,
  });
  const openApi = buildOpenApiDocument(api.specs);
  app.get('/api/openapi.json', async () => openApi);

  const webRoot = deps.webRoot ?? resolve(process.cwd(), 'apps/web/dist');
  if (existsSync(resolve(webRoot, 'index.html'))) {
    await app.register(serveStatic, { root: webRoot, prefix: '/', wildcard: false, index: false });
    app.get('/', (_request, reply) => reply.type('text/html').sendFile('index.html'));
  }
  app.setNotFoundHandler((request, reply) => {
    if (
      request.method === 'GET' &&
      !request.url.startsWith('/api/') &&
      request.headers.accept?.includes('text/html') &&
      existsSync(resolve(webRoot, 'index.html'))
    ) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply
      .status(404)
      .send({ error: 'NOT_FOUND', message: 'Page or endpoint not found.', requestId: request.id });
  });
  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
