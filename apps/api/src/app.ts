import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import serveStatic from '@fastify/static';
import { type AgentRuntime } from '@opentradie/agent';
import { calculateQuote, canApproveQuote, enforceModelPolicy, PolicyDeniedError } from '@opentradie/core';
import { type Database, hashPassword, schema, transaction, type Transaction, verifyPassword } from '@opentradie/database';
import Fastify, { type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import type { ApiConfig } from './config.js';
import { openApiDocument } from './openapi.js';

interface UserContext {
  id: string;
  tenantId: string;
  email: string;
  role: 'owner' | 'viewer';
}
declare module 'fastify' {
  interface FastifyRequest {
    currentUser: UserContext | null;
  }
}

class HttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

const idSchema = z.string().uuid();
const customerBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(254).optional(),
  phone: z.string().trim().min(3).max(50).optional(),
}).strict();
const jobStatus = z.enum(['new', 'quoted', 'scheduled', 'in_progress', 'completed']);
const jobBody = z.object({
  customerId: idSchema,
  title: z.string().trim().min(1).max(300),
  notes: z.string().trim().max(5000).optional(),
}).strict();
const enquiryBody = z.object({ text: z.string().trim().min(5).max(8000), customerId: idSchema.optional() }).strict();
const interpretationSchema = z.object({
  customerQuery: z.string().max(200),
  workSummary: z.string().trim().min(1).max(500),
  rateCode: z.string().max(100).nullable(),
  quantity: z.number().finite().nullable(),
  missingInformation: z.array(z.string().max(500)).max(30),
}).strict();
const quoteIdParams = z.object({ id: idSchema });
const sessionCookie = 'opentradie_session';
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

function user(request: FastifyRequest): UserContext {
  if (!request.currentUser) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  return request.currentUser;
}
function owner(request: FastifyRequest): UserContext {
  const current = user(request);
  if (current.role !== 'owner') throw new HttpError(403, 'OWNER_REQUIRED', 'Only the business owner can make this change.');
  return current;
}
async function audit(client: Transaction, current: UserContext, requestId: string, action: string, entityId: string, metadata: Record<string, unknown> = {}) {
  await client.query('INSERT INTO audit_events(id,tenant_id,actor_id,action,entity_id,request_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), current.tenantId, current.id, action, entityId, requestId, JSON.stringify(metadata)]);
}
async function requireCustomer(client: Transaction, tenantId: string, customerId: string) {
  const result = await client.query<{ id: string; name: string }>('SELECT id,name FROM customers WHERE tenant_id=$1 AND id=$2', [tenantId, customerId]);
  if (!result.rows[0]) throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
  return result.rows[0];
}

async function idempotent<T>(
  db: Database,
  request: FastifyRequest,
  scope: string,
  body: unknown,
  operation: (client: Transaction) => Promise<T>,
): Promise<T> {
  const current = user(request);
  const key = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).parse(request.headers['idempotency-key']);
  const requestHash = tokenHash(JSON.stringify(body));
  const scoped = `${current.id}:${scope}`;
  return transaction(db, async (client) => {
    // Serialise duplicates before work, including across multiple API processes.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${current.tenantId}:${scoped}:${key}`]);
    const saved = await client.query<{ request_hash: string; response: T }>('SELECT request_hash,response FROM idempotency_records WHERE tenant_id=$1 AND scope=$2 AND key=$3', [current.tenantId, scoped, key]);
    const row = saved.rows[0];
    if (row) {
      if (row.request_hash !== requestHash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used for different input.');
      return row.response;
    }
    const response = await operation(client);
    await client.query('INSERT INTO idempotency_records(tenant_id,scope,key,request_hash,response) VALUES($1,$2,$3,$4,$5)', [current.tenantId, scoped, key, requestHash, JSON.stringify(response)]);
    return response;
  });
}

export async function buildApp({ db, runtime, config }: { db: Database; runtime: AgentRuntime; config: ApiConfig }) {
  const app = Fastify({
    bodyLimit: 16_384,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    disableRequestLogging: true,
    logger: process.env.NODE_ENV === 'test' ? false : {
      level: 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body', 'res.headers.set-cookie', 'password', 'prompt', 'text'],
    },
  });
  await app.register(cookie, { secret: config.sessionSecret, hook: 'onRequest' });
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
  app.decorateRequest('currentUser', null);
  // A fixed dummy hash makes unknown-user login do the same expensive password check.
  const dummyPasswordHash = await hashPassword(randomBytes(32).toString('hex'));

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'no-store');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    reply.header('referrer-policy', 'same-origin');
    if (config.secureCookies) reply.header('strict-transport-security', 'max-age=31536000');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      if (request.headers.origin !== config.appOrigin) throw new HttpError(403, 'ORIGIN_REJECTED', 'Request origin is not allowed.');
      if (request.headers['content-type'] && !request.headers['content-type'].startsWith('application/json')) {
        throw new HttpError(415, 'JSON_REQUIRED', 'Send JSON request content.');
      }
    }
    if (!request.url.startsWith('/api/') || request.url.split('?')[0] === '/api/auth/login') return;
    const signed = request.cookies[sessionCookie];
    const token = signed ? request.unsignCookie(signed) : null;
    if (!token?.valid || !token.value) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const found = await db.pool.query<UserContext>(
      'SELECT u.id,u.tenant_id AS "tenantId",u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id AND u.tenant_id=s.tenant_id WHERE s.token_hash=$1 AND s.tenant_id=$2 AND s.expires_at>now() AND u.active=true',
      [tokenHash(token.value), config.tenantId],
    );
    request.currentUser = found.rows[0] ?? null;
    user(request);
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'Check the request fields and try again.', requestId: request.id });
    if (error instanceof PolicyDeniedError) return reply.status(403).send({ error: error.code, message: error.message, requestId: request.id });
    if (error instanceof HttpError) return reply.status(error.statusCode).send({ error: error.code, message: error.message, requestId: request.id });
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    request.log.error({ requestId: request.id, code: typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR' }, 'Request failed');
    return reply.status(status).send({ error: status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_REJECTED', message: status === 500 ? 'The request could not be completed. Please try again.' : 'The request was rejected.', requestId: request.id });
  });

  app.get('/health', async (_request, reply) => {
    try {
      await db.pool.query('SELECT 1');
      return { status: 'ok', database: 'ok', profile: config.deploymentProfile };
    } catch {
      return reply.status(503).send({ status: 'unavailable', database: 'unavailable' });
    }
  });
  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) }).strict().parse(request.body);
    const found = await db.pool.query<{ id: string; tenantId: string; email: string; password_hash: string; role: 'owner' | 'viewer' }>('SELECT id,tenant_id AS "tenantId",email,password_hash,role FROM users WHERE tenant_id=$1 AND email=$2 AND active=true', [config.tenantId, body.email.toLowerCase()]);
    const record = found.rows[0];
    const valid = await verifyPassword(body.password, record?.password_hash ?? dummyPasswordHash);
    if (!record || !valid) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    const token = randomBytes(32).toString('base64url');
    const current = { id: record.id, tenantId: record.tenantId, email: record.email, role: record.role };
    await transaction(db, async (client) => {
      await client.query("INSERT INTO sessions(token_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')", [tokenHash(token), config.tenantId, record.id]);
      await audit(client, current, request.id, 'session.login', record.id);
    });
    reply.setCookie(sessionCookie, token, { signed: true, httpOnly: true, secure: config.secureCookies, sameSite: 'strict', path: '/', maxAge: 8 * 60 * 60 });
    return { user: { id: record.id, email: record.email, role: record.role } };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const current = user(request);
    const signed = request.cookies[sessionCookie];
    const token = signed ? request.unsignCookie(signed) : null;
    await transaction(db, async (client) => {
      if (token?.valid && token.value) await client.query('DELETE FROM sessions WHERE token_hash=$1 AND tenant_id=$2', [tokenHash(token.value), current.tenantId]);
      await audit(client, current, request.id, 'session.logout', current.id);
    });
    reply.clearCookie(sessionCookie, { path: '/', secure: config.secureCookies, sameSite: 'strict', httpOnly: true });
    return { ok: true };
  });
  app.get('/api/me', async (request) => {
    const current = user(request);
    return { id: current.id, email: current.email, role: current.role };
  });
  app.get('/api/openapi.json', async () => openApiDocument);

  app.get('/api/state', async (request) => {
    const current = user(request);
    const [businessRows, customers, jobs, communications, quotes, lines, rates, auditEvents, agentHealth] = await Promise.all([
      db.orm.query.businesses.findMany({ where: (businesses, { eq }) => eq(businesses.id, current.tenantId) }),
      db.pool.query('SELECT id,name,email,phone FROM customers WHERE tenant_id=$1 ORDER BY name', [current.tenantId]),
      db.pool.query('SELECT id,customer_id AS "customerId",title,status,notes FROM jobs WHERE tenant_id=$1 ORDER BY created_at DESC', [current.tenantId]),
      db.pool.query('SELECT id,customer_id AS "customerId",text,created_at AS "createdAt" FROM communications WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100', [current.tenantId]),
      db.pool.query('SELECT id,customer_id AS "customerId",job_id AS "jobId",status,version,assumptions,missing_information AS "missingInformation",subtotal_cents AS "subtotalCents",tax_cents AS "taxCents",total_cents AS "totalCents" FROM quotes WHERE tenant_id=$1 ORDER BY created_at DESC', [current.tenantId]),
      db.pool.query('SELECT quote_id AS "quoteId",description,quantity,unit_price_cents AS "unitPriceCents",line_total_cents AS "lineTotalCents" FROM quote_line_items WHERE tenant_id=$1', [current.tenantId]),
      db.pool.query('SELECT code,label,unit_price_cents AS "unitPriceCents" FROM approved_rates WHERE tenant_id=$1 AND active=true ORDER BY code', [current.tenantId]),
      db.pool.query('SELECT id,action,created_at AS "createdAt" FROM audit_events WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 30', [current.tenantId]),
      runtime.health().catch(() => ({ status: 'unavailable' as const })),
    ]);
    const business = businessRows[0];
    if (!business) throw new HttpError(503, 'BUSINESS_UNAVAILABLE', 'Business setup has not been completed.');
    return {
      business: { id: business.id, name: business.name, currency: business.currency, timeZone: business.timeZone, taxBasisPoints: business.taxBasisPoints },
      user: { id: current.id, email: current.email, role: current.role },
      customers: customers.rows,
      jobs: jobs.rows,
      communications: communications.rows,
      quotes: quotes.rows.map((quote) => ({
        ...quote,
        subtotalCents: Number(quote.subtotalCents), taxCents: Number(quote.taxCents), totalCents: Number(quote.totalCents),
        lines: lines.rows.filter((line) => line.quoteId === quote.id).map((line) => ({ description: line.description, quantity: line.quantity, unitPriceCents: Number(line.unitPriceCents), lineTotalCents: Number(line.lineTotalCents) })),
      })),
      rates: rates.rows.map((rate) => ({ ...rate, unitPriceCents: Number(rate.unitPriceCents) })),
      auditEvents: auditEvents.rows,
      settings: { profile: config.deploymentProfile, privacyMode: config.privacyMode, agentMode: config.agentMode, agentHealth: agentHealth.status, demoData: business.demoData },
    };
  });

  app.get('/api/search', async (request) => {
    const current = user(request);
    const { q } = z.object({ q: z.string().trim().min(2).max(200) }).strict().parse(request.query);
    const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const [customers, jobs, knowledge] = await Promise.all([
      db.pool.query('SELECT id,name FROM customers WHERE tenant_id=$1 AND (to_tsvector(\'simple\',name) @@ plainto_tsquery(\'simple\',$2) OR name ILIKE $3) ORDER BY name LIMIT 25', [current.tenantId, q, pattern]),
      db.pool.query('SELECT id,customer_id AS "customerId",title,status FROM jobs WHERE tenant_id=$1 AND (to_tsvector(\'simple\',title) @@ plainto_tsquery(\'simple\',$2) OR title ILIKE $3) LIMIT 25', [current.tenantId, q, pattern]),
      db.pool.query('SELECT id,source_type AS "sourceType",source_id AS "sourceId",content,provenance,created_at AS "createdAt" FROM knowledge_items WHERE tenant_id=$1 AND to_tsvector(\'simple\',content) @@ plainto_tsquery(\'simple\',$2) LIMIT 25', [current.tenantId, q]),
    ]);
    return { customers: customers.rows, jobs: jobs.rows, knowledge: knowledge.rows };
  });
  app.post('/api/customers', async (request, reply) => {
    const current = owner(request);
    const body = customerBody.parse(request.body);
    const id = randomUUID();
    await transaction(db, async (client) => {
      await client.query('INSERT INTO customers(id,tenant_id,name,email,phone) VALUES($1,$2,$3,$4,$5)', [id, current.tenantId, body.name, body.email ?? null, body.phone ?? null]);
      await audit(client, current, request.id, 'customer.created', id);
    });
    return reply.status(201).send({ id, ...body });
  });
  app.post('/api/jobs', async (request, reply) => {
    const current = owner(request);
    const body = jobBody.parse(request.body);
    const id = randomUUID();
    await transaction(db, async (client) => {
      await requireCustomer(client, current.tenantId, body.customerId);
      await client.query('INSERT INTO jobs(id,tenant_id,customer_id,title,notes) VALUES($1,$2,$3,$4,$5)', [id, current.tenantId, body.customerId, body.title, body.notes ?? null]);
      if (body.notes) await client.query('INSERT INTO job_notes(id,tenant_id,job_id,text) VALUES($1,$2,$3,$4)', [randomUUID(), current.tenantId, id, body.notes]);
      await audit(client, current, request.id, 'job.created', id);
    });
    return reply.status(201).send({ id, ...body, status: 'new' });
  });
  app.patch('/api/jobs/:id', async (request) => {
    const current = owner(request);
    const { id } = quoteIdParams.parse(request.params);
    const body = z.object({ status: jobStatus.optional(), notes: z.string().trim().max(5000).optional() }).strict().refine((value) => value.status !== undefined || value.notes !== undefined).parse(request.body);
    return transaction(db, async (client) => {
      const result = await client.query('UPDATE jobs SET status=COALESCE($3,status),notes=COALESCE($4,notes) WHERE tenant_id=$1 AND id=$2 RETURNING id,customer_id AS "customerId",title,status,notes', [current.tenantId, id, body.status ?? null, body.notes ?? null]);
      if (!result.rows[0]) throw new HttpError(404, 'JOB_NOT_FOUND', 'Job not found.');
      if (body.notes) await client.query('INSERT INTO job_notes(id,tenant_id,job_id,text) VALUES($1,$2,$3,$4)', [randomUUID(), current.tenantId, id, body.notes]);
      await audit(client, current, request.id, 'job.updated', id);
      return result.rows[0];
    });
  });

  app.post('/api/enquiries', async (request) => {
    const current = owner(request);
    const body = enquiryBody.parse(request.body);
    return idempotent(db, request, 'enquiry', body, async (client) => {
      // Runtime attestation must agree with policy: a configurable environment label is insufficient.
      const health = await runtime.health();
      if (health.status !== 'ok') throw new HttpError(503, 'AGENT_UNAVAILABLE', 'The assistant is unavailable. Your enquiry has not been sent.');
      const effectiveLocation = config.modelLocation === 'hosted' || health.inferenceLocation !== 'local' ? 'hosted' : 'local';
      enforceModelPolicy(config.privacyMode, effectiveLocation);
      await audit(client, current, request.id, 'model.policy_allowed', current.id, { purpose: 'enquiry_extraction', location: effectiveLocation, privacyMode: config.privacyMode });
      const customers = await client.query<{ id: string; name: string }>('SELECT id,name FROM customers WHERE tenant_id=$1 ORDER BY name', [current.tenantId]);
      let selected = body.customerId ? await requireCustomer(client, current.tenantId, body.customerId) : undefined;
      const rates = await client.query<{ code: string; label: string; unitPriceCents: string }>('SELECT code,label,unit_price_cents AS "unitPriceCents" FROM approved_rates WHERE tenant_id=$1 AND active=true', [current.tenantId]);
      // Customer names and rate descriptions are the only discovery context. Historical notes are
      // fetched after identity resolution, never a full business transcript dump to a model.
      const interpreted = interpretationSchema.parse(await runtime.interpret({
        requestId: request.id,
        prompt: body.text,
        context: { customers: selected ? [selected] : customers.rows, notes: [], rates: rates.rows.map(({ code, label }) => ({ code, label })) },
      }));
      const query = interpreted.customerQuery.trim().toLocaleLowerCase('en-NZ').replace(/[^\p{L}\p{N}\s]/gu, '');
      const words = query.split(/\s+/).filter((part) => part && !['mrs', 'mr', 'ms', 'dr', 'the', 'customer'].includes(part));
      const matches = selected ? [selected] : customers.rows.filter((candidate) => {
        const name = candidate.name.toLocaleLowerCase('en-NZ').replace(/[^\p{L}\p{N}\s]/gu, '');
        return words.length > 0 && words.every((word) => name.split(/\s+/).includes(word));
      });
      if (!selected && matches.length === 1) selected = matches[0];
      const enquiryId = randomUUID();
      await client.query('INSERT INTO communications(id,tenant_id,customer_id,text) VALUES($1,$2,$3,$4)', [enquiryId, current.tenantId, selected?.id ?? null, body.text]);
      await client.query("INSERT INTO knowledge_items(id,tenant_id,customer_id,source_type,source_id,content,provenance) VALUES($1,$2,$3,'communication',$4,$5,'user_supplied')", [randomUUID(), current.tenantId, selected?.id ?? null, enquiryId, body.text]);
      await audit(client, current, request.id, 'enquiry.created', enquiryId);
      if (!selected) return { enquiryId, clarification: { message: matches.length ? 'Several customers match. Select the correct customer and resubmit the enquiry.' : 'Select an existing customer or add the customer before preparing a quote.', matches } };
      const notes = await client.query<{ text: string }>('SELECT n.text FROM job_notes n JOIN jobs j ON j.id=n.job_id AND j.tenant_id=n.tenant_id WHERE n.tenant_id=$1 AND j.customer_id=$2 ORDER BY n.created_at DESC LIMIT 3', [current.tenantId, selected.id]);
      const business = await client.query<{ tax_basis_points: number }>('SELECT tax_basis_points FROM businesses WHERE id=$1', [current.tenantId]);
      const quote = calculateQuote({ rateCode: interpreted.rateCode, quantity: interpreted.quantity, approvedRates: rates.rows.map((rate) => ({ ...rate, unitPriceCents: Number(rate.unitPriceCents) })), taxBasisPoints: business.rows[0]?.tax_basis_points ?? 0, missingInformation: interpreted.missingInformation });
      // Historical information is surfaced as review context, never automatically adopted as scope.
      quote.assumptions.push(...notes.rows.map((note) => `Customer history (verify): ${note.text}`));
      const jobId = randomUUID();
      const quoteId = randomUUID();
      await client.query("INSERT INTO jobs(id,tenant_id,customer_id,title,status,notes) VALUES($1,$2,$3,$4,'quoted',$5)", [jobId, current.tenantId, selected.id, interpreted.workSummary, 'Assistant-proposed scope. Review the original enquiry and assumptions before approval.']);
      await client.query('UPDATE communications SET job_id=$3 WHERE tenant_id=$1 AND id=$2', [current.tenantId, enquiryId, jobId]);
      await client.query('UPDATE knowledge_items SET job_id=$3 WHERE tenant_id=$1 AND source_id=$2', [current.tenantId, enquiryId, jobId]);
      await client.query('INSERT INTO quotes(id,tenant_id,customer_id,job_id,assumptions,missing_information,subtotal_cents,tax_cents,total_cents,tax_basis_points) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [quoteId, current.tenantId, selected.id, jobId, JSON.stringify(quote.assumptions), JSON.stringify(quote.missingInformation), quote.subtotalCents, quote.taxCents, quote.totalCents, business.rows[0]?.tax_basis_points ?? 0]);
      for (const line of quote.lines) {
        await client.query('INSERT INTO quote_line_items(id,tenant_id,quote_id,rate_code,description,quantity,unit_price_cents,line_total_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), current.tenantId, quoteId, interpreted.rateCode, line.description, line.quantity, line.unitPriceCents, line.lineTotalCents]);
      }
      await client.query("INSERT INTO approval_requests(id,tenant_id,quote_id,status) VALUES($1,$2,$3,'pending')", [randomUUID(), current.tenantId, quoteId]);
      await audit(client, current, request.id, 'job.proposed', jobId);
      await audit(client, current, request.id, 'quote.drafted', quoteId);
      return { enquiryId, jobId, quoteId };
    });
  });

  app.post('/api/quotes/:id/approve', async (request) => {
    const current = owner(request);
    const { id } = quoteIdParams.parse(request.params);
    const body = z.object({ version: z.number().int().positive() }).strict().parse(request.body);
    return idempotent(db, request, `approve:${id}`, body, async (client) => {
      const quoteResult = await client.query<{ status: string; version: number; missingInformation: string[] }>('SELECT status,version,missing_information AS "missingInformation" FROM quotes WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [current.tenantId, id]);
      const quote = quoteResult.rows[0];
      if (!quote) throw new HttpError(404, 'QUOTE_NOT_FOUND', 'Quote not found.');
      if (quote.version !== body.version) throw new HttpError(409, 'STALE_QUOTE', 'The quote has changed. Reload it before approving.');
      if (quote.status !== 'draft') throw new HttpError(409, 'ALREADY_APPROVED', 'This quote is already approved.');
      const lines = await client.query('SELECT id FROM quote_line_items WHERE tenant_id=$1 AND quote_id=$2', [current.tenantId, id]);
      if (!canApproveQuote({ ...quote, lines: lines.rows })) throw new HttpError(409, 'INCOMPLETE_QUOTE', 'Resolve the missing information before approving this quote.');
      const result = await client.query("UPDATE quotes SET status='approved',version=version+1,approved_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,status,version", [current.tenantId, id]);
      await client.query("UPDATE approval_requests SET status='approved',approved_by=$3,decided_at=now() WHERE tenant_id=$1 AND quote_id=$2", [current.tenantId, id, current.id]);
      await audit(client, current, request.id, 'quote.approved', id, { approvedVersion: body.version });
      return result.rows[0];
    });
  });

  const webRoot = resolve(process.cwd(), 'apps/web/dist');
  if (existsSync(resolve(webRoot, 'index.html'))) {
    await app.register(serveStatic, { root: webRoot, prefix: '/', wildcard: false, index: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/') && request.headers.accept?.includes('text/html')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Page or endpoint not found.' });
    });
  }
  return app;
}
