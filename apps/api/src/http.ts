import { createHash } from 'node:crypto';
import type { Database, Transaction } from '@opentradie/database';
import { transaction } from '@opentradie/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';

export interface UserContext {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: 'owner' | 'viewer';
}

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: UserContext | null;
    /** The current session's id (sessions.id), when signed in. */
    sessionId: string | null;
    /** REQUIRE_OWNER_MFA is on and this owner has not enrolled TOTP yet. */
    mfaEnrolmentRequired: boolean;
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HandlerResult {
  status?: number;
  body: unknown;
}

type Auth = 'public' | 'user' | 'owner';

export interface RouteSpec<B = unknown, Q = unknown, P = unknown> {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  summary: string;
  tags: string[];
  auth: Auth;
  /** Mutations require an Idempotency-Key; retries with the same key and input replay the response. */
  idempotent?: boolean;
  body?: ZodType<B>;
  query?: ZodType<Q>;
  params?: ZodType<P>;
  responses: Record<number, { description: string; schema?: ZodType }>;
  rateLimit?: { max: number; timeWindow: string };
  /** Per-route JSON body limit in bytes; the app default (64 KiB) applies otherwise. */
  bodyLimit?: number;
}

export interface RouteContext<B, Q, P, U> {
  request: FastifyRequest;
  reply: FastifyReply;
  body: B;
  query: Q;
  params: P;
  user: U;
  /** Run the write inside the idempotency transaction; `prepare` runs first, outside any transaction. */
  idempotent<T>(
    write: (client: Transaction, prepared: T) => Promise<HandlerResult>,
    prepare?: () => Promise<T>,
  ): Promise<HandlerResult>;
}

const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex');

export function requireUser(request: FastifyRequest): UserContext {
  if (!request.currentUser) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  return request.currentUser;
}

export function requireOwner(request: FastifyRequest): UserContext {
  const user = requireUser(request);
  if (user.role !== 'owner')
    throw new HttpError(403, 'OWNER_REQUIRED', 'Only the business owner can make this change.');
  return user;
}

/** Registers routes and remembers their specs so the OpenAPI document is generated from the same schemas. */
export class RouteRegistry {
  constructor(
    private readonly app: FastifyInstance,
    private readonly db: Database,
    readonly specs: RouteSpec[] = [],
  ) {}

  get pool() {
    return this.db.pool;
  }

  /** A registry for an encapsulated Fastify scope that shares this registry's OpenAPI specs. */
  scoped(app: FastifyInstance): RouteRegistry {
    return new RouteRegistry(app, this.db, this.specs);
  }

  route<B, Q, P, A extends Auth>(
    spec: RouteSpec<B, Q, P> & { auth: A },
    handler: (
      context: RouteContext<B, Q, P, A extends 'public' ? UserContext | null : UserContext>,
    ) => Promise<HandlerResult>,
  ): void {
    this.specs.push(spec as RouteSpec);
    this.app.route({
      method: spec.method,
      url: spec.url,
      ...(spec.rateLimit ? { config: { rateLimit: spec.rateLimit } } : {}),
      ...(spec.bodyLimit ? { bodyLimit: spec.bodyLimit } : {}),
      handler: async (request, reply) => {
        const user =
          spec.auth === 'owner'
            ? requireOwner(request)
            : spec.auth === 'user'
              ? requireUser(request)
              : request.currentUser;
        if (
          user &&
          request.mfaEnrolmentRequired &&
          !spec.url.startsWith('/api/auth/') &&
          spec.url !== '/api/me'
        )
          throw new HttpError(
            403,
            'MFA_ENROLMENT_REQUIRED',
            'Set up two-factor sign-in in Settings › Security before continuing.',
          );
        const params = (spec.params ? spec.params.parse(request.params) : {}) as P;
        const query = (spec.query ? spec.query.parse(request.query ?? {}) : {}) as Q;
        const body = (spec.body ? spec.body.parse(request.body ?? {}) : undefined) as B;
        let key: string | null = null;
        if (spec.idempotent) {
          const parsed = idempotencyKey.safeParse(request.headers['idempotency-key']);
          if (!parsed.success)
            throw new HttpError(
              400,
              'IDEMPOTENCY_KEY_REQUIRED',
              'Send an Idempotency-Key header (8-128 letters, digits, - or _).',
            );
          key = parsed.data;
        }
        const context: RouteContext<B, Q, P, UserContext | null> = {
          request,
          reply,
          body,
          query,
          params,
          user,
          idempotent: async (write, prepare) => {
            if (!key || !user) throw new Error('Route is not declared idempotent.');
            return runIdempotent(
              this.db,
              reply,
              user,
              `${user.id}:${spec.method} ${spec.url}:${JSON.stringify(params)}`,
              key,
              hash(body),
              write,
              prepare,
            );
          },
        };
        const result = await handler(context as never);
        return reply.status(result.status ?? 200).send(result.body);
      },
    });
  }
}

async function runIdempotent<T>(
  db: Database,
  reply: FastifyReply,
  user: UserContext,
  scope: string,
  key: string,
  requestHash: string,
  write: (client: Transaction, prepared: T) => Promise<HandlerResult>,
  prepare?: () => Promise<T>,
): Promise<HandlerResult> {
  const find = (client: Pick<Transaction, 'query'>) =>
    client.query<{ request_hash: string; status_code: number; response: unknown }>(
      'SELECT request_hash,status_code,response FROM idempotency_records WHERE tenant_id=$1 AND scope=$2 AND key=$3',
      [user.tenantId, scope, key],
    );
  const replay = (row: {
    request_hash: string;
    status_code: number;
    response: unknown;
  }): HandlerResult => {
    if (row.request_hash !== requestHash)
      throw new HttpError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'This Idempotency-Key was already used with different input.',
      );
    reply.header('idempotent-replayed', 'true');
    return { status: row.status_code, body: row.response };
  };
  const existing = (await find(db.pool)).rows[0];
  if (existing) return replay(existing);
  const prepared = (prepare ? await prepare() : undefined) as T;
  return transaction(db, async (client) => {
    // Serialise concurrent duplicates, including across API processes.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${user.tenantId}:${scope}:${key}`,
    ]);
    const raced = (await find(client)).rows[0];
    if (raced) return replay(raced);
    const result = await write(client, prepared);
    await client.query(
      'INSERT INTO idempotency_records(tenant_id,scope,key,request_hash,status_code,response) VALUES($1,$2,$3,$4,$5,$6)',
      [user.tenantId, scope, key, requestHash, result.status ?? 200, JSON.stringify(result.body)],
    );
    return result;
  });
}

export function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
