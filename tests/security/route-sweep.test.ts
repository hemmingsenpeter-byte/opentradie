import { randomUUID } from 'node:crypto';
import { MockAgentRuntime } from '@opentradie/agent';
import { loadRuntimeConfig } from '@opentradie/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../apps/api/src/app.js';
import { AGENT_TOOLS_PATH } from '../../apps/api/src/routes/agent-tools.js';
import {
  baseEnv,
  createTestContext,
  FAKE_ACCOUNTING_ENV,
  TENANT_A,
  TENANT_B,
  type TestContext,
} from '../helpers/app.js';

/** Every optional route family switched on, so the sweep sees the whole surface. */
const SWEEP_ENV = {
  ...FAKE_ACCOUNTING_ENV,
  RATE_LIMIT_PER_MINUTE: '100000',
  RELAY_SHARED_SECRET: 'sweep-relay-secret-throwaway-0123456789',
  INBOUND_EMAIL_SECRET: 'sweep-inbound-secret-throwaway-0123456789',
};

/**
 * Route-wide sweep. Every route the API registers is enumerated from the OpenAPI document
 * (generated from the RouteRegistry) plus Fastify's own route table, and checked for:
 * unauthenticated 401, viewer 403 on mutations, and tenant B 404 on tenant A ids.
 * A route that is not classified here fails the sweep.
 */

/** Routes reachable without a session. Each has its own authentication or is deliberately public. */
const PUBLIC_ROUTES = new Set([
  'GET /health',
  'GET /api/openapi.json',
  'POST /api/auth/login',
  'GET /api/public/quotes/:token',
  'GET /api/public/quotes/:token/pdf',
  'POST /api/public/quotes/:token/accept',
  'POST /api/public/quotes/:token/decline',
  'GET /calendar/feed/:token.ics',
  'POST /inbound/email/:provider',
  'POST /relay/v1/events',
  'GET /api/integrations/xero/callback',
  'GET /api/integrations/mail/:provider/callback',
  // MCP: bearer key per session (tests/integration/agent-tools.test.ts), never a cookie.
  `POST ${AGENT_TOOLS_PATH}`,
  `DELETE ${AGENT_TOOLS_PATH}`,
  `GET ${AGENT_TOOLS_PATH}`,
]);

/** Session-authenticated mutations a viewer may perform (they affect only the viewer). */
const VIEWER_MUTATIONS = new Set(['POST /api/auth/logout', 'POST /api/inbox/threads/:id/read']);

/** First path segment before an id parameter -> the tenant table that holds that resource. */
const ID_TABLES: Record<string, string> = {
  customers: 'customers',
  jobs: 'jobs',
  properties: 'properties',
  quotes: 'quotes',
  appointments: 'appointments',
  communications: 'communications',
  documents: 'documents',
  threads: 'communication_threads',
  invoices: 'invoices',
  proposals: 'action_proposals',
  'voice-notes': 'voice_notes',
};
/** Path parameters that are not tenant resource ids (provider names). */
const NON_ID_PARAMS = new Set([':provider']);

/** Bodies that pass schema validation, so the tenant B request reaches the tenant-scoped lookup. */
const BODIES: Record<string, unknown> = {
  'PATCH /api/customers/:id': { name: 'Cross tenant' },
  'POST /api/customers/:id/contacts': { name: 'Cross tenant' },
  'POST /api/customers/:id/properties': { addressLine1: '1 Cross Street' },
  'POST /api/customers/:id/erase': { confirmName: 'x' },
  'PATCH /api/jobs/:id': { status: 'completed' },
  'POST /api/jobs/:id/notes': { text: 'cross tenant' },
  'POST /api/jobs/:id/evidence': {
    fileName: 'a.pdf',
    mediaType: 'application/pdf',
    dataBase64: 'JVBERi0xLjQK',
  },
  'POST /api/jobs/:id/assistant-actions': { text: 'Spent 1 hour.' },
  'POST /api/jobs/:id/invoices': {},
  'POST /api/jobs/:id/appointments': {},
  'PATCH /api/properties/:id': { label: 'x' },
  'PATCH /api/quotes/:id': {
    version: 1,
    lines: [{ rateCode: 'call_out', quantity: 1 }],
    missingInformation: [],
  },
  'POST /api/quotes/:id/approve': { version: 1 },
  'POST /api/quotes/:id/reject': { version: 1 },
  'POST /api/quotes/:id/send': { version: 1 },
  'POST /api/quotes/:id/revise': { version: 1 },
  'PATCH /api/appointments/:id': {
    version: 1,
    startsAt: '2030-01-07T09:00:00.000Z',
    endsAt: '2030-01-07T10:00:00.000Z',
  },
  'POST /api/appointments/:id/cancel': { version: 1 },
  'POST /api/appointments/:id/confirm': { version: 1 },
  'PATCH /api/invoices/:id': { version: 1, lines: [{ lineId: randomUUID() }] },
  'POST /api/invoices/:id/approve': { version: 1 },
  'POST /api/invoices/:id/void': { version: 1 },
  'POST /api/invoices/:id/collections-hold': { hold: true },
  'POST /api/invoices/:id/retry-sync': {},
  'PATCH /api/inbox/threads/:id': { status: 'archived' },
  'POST /api/inbox/threads/:id/link': {},
  'POST /api/inbox/threads/:id/create-job': {},
  'PATCH /api/communications/:id': { text: 'x' },
  'POST /api/communications/:id/approve-send': {},
  'POST /api/communications/:id/discard': {},
  'POST /api/proposals/:id/approve': {},
  'POST /api/proposals/:id/reject': { reason: 'cross tenant' },
  'POST /api/voice-notes/:id/clarify': { rateCode: 'labour_hour' },
  'PATCH /api/voice-notes/:id/transcript': { transcript: 'x' },
};

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
type Route = { method: string; url: string };
const key = (route: Route) => `${route.method} ${route.url}`;

function wav(): Buffer {
  const data = Buffer.from('synthetic-audio-sweep');
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  return Buffer.concat([header, data]);
}

/**
 * Every route in Fastify's route table, as `METHOD /url` (HEAD and OPTIONS aliases dropped),
 * rebuilt from the printRoutes tree (each line is a path segment relative to its parent).
 * Built web assets (GET-only, outside the API prefixes) are returned separately.
 */
function fastifyRoutes(app: App): Route[] {
  const text = app.printRoutes({ commonPrefix: false });
  const routes: Route[] = [];
  const stack: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^(.*?)(?:└── |├── )(\S+)(?: \(([A-Z, ]+)\))?$/.exec(line);
    if (!match) continue;
    const depth = match[1]!.length / 4;
    stack.length = depth;
    stack.push(match[2]!);
    if (!match[3]) continue;
    const url = stack.join('').replace(/^\/\//, '/');
    for (const method of match[3].split(',').map((m) => m.trim())) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      routes.push({ method, url });
    }
  }
  return routes;
}
const API_PREFIX = /^\/(api|health|calendar|inbound|relay|agent-tools)(\/|$)/;
const isWebAsset = (route: Route) => route.method === 'GET' && !API_PREFIX.test(route.url);

describe('route-wide authentication, role and tenant sweep', () => {
  let ctx: TestContext;
  let appB: App;
  let owner: string;
  let viewer: string;
  let ownerB: string;
  let routes: Route[];
  let ownerOnly: Set<string>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await createTestContext({
      seedTenantB: true,
      env: SWEEP_ENV,
    });
    owner = await ctx.login('owner');
    viewer = await ctx.login('viewer');

    // Real tenant A resources of every type an id route addresses.
    const customer = (await ctx.get('/api/customers', owner)).body.customers[0].id as string;
    const enquiry = await ctx.send('POST', '/api/enquiries', owner, {
      text: 'Mrs Johnson needs two power points replaced. Check her existing information and prepare a quote.',
      customerId: customer,
    });
    expect(enquiry.status).toBe(201);
    const drafted = enquiry.body.quote;
    const job = drafted.jobId as string;
    const approved = await ctx.send('POST', `/api/quotes/${drafted.id}/approve`, owner, {
      version: drafted.version,
    });
    const sent = await ctx.send('POST', `/api/quotes/${drafted.id}/send`, owner, {
      version: approved.body.version,
    });
    const token = new URL(sent.body.acceptanceUrl).pathname.split('/').at(-1)!;
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: `/api/public/quotes/${token}/accept`,
      headers: { origin: ctx.config.appOrigin },
      payload: { name: 'Margaret Johnson' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(
      (
        await ctx.send('POST', `/api/jobs/${job}/evidence`, owner, {
          fileName: 'a.pdf',
          mediaType: 'application/pdf',
          dataBase64: 'JVBERi0xLjQK',
        })
      ).status,
    ).toBe(201);
    for (const status of ['in_progress', 'completed'])
      expect((await ctx.send('PATCH', `/api/jobs/${job}`, owner, { status })).status).toBe(200);
    const invoice = await ctx.send('POST', `/api/jobs/${job}/invoices`, owner, {});
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(201);
    expect(
      (
        await ctx.send('POST', `/api/jobs/${job}/assistant-actions`, owner, {
          text: 'Spent 1.5 hours. Mark the job as in progress.',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await ctx.send('POST', '/api/inbox/paste', owner, {
          from: 'sweep.customer@customer.example.test',
          subject: 'Heat pump',
          text: 'Hi, can you quote a heat pump install?',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await ctx.send('POST', '/api/voice-notes', owner, {
          fileName: 'note.wav',
          mediaType: 'audio/wav',
          dataBase64: wav().toString('base64'),
          jobId: job,
        })
      ).status,
    ).toBe(201);
    await ctx.db.pool.query(
      `INSERT INTO appointments(id,tenant_id,job_id,starts_at,ends_at,title)
       VALUES($1,$2,$3,now()+interval '1 day',now()+interval '1 day 1 hour','Sweep visit')`,
      [randomUUID(), TENANT_A, job],
    );
    for (const table of new Set(Object.values(ID_TABLES))) {
      const row = await ctx.db.pool.query<{ id: string }>(
        `SELECT id FROM ${table} WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [TENANT_A],
      );
      expect(row.rows[0], `tenant A ${table} seeded`).toBeDefined();
      ids[table] = row.rows[0]!.id;
    }

    // A second runtime for tenant B over the same database: its owner signs in there.
    const configB = loadRuntimeConfig(baseEnv(ctx.url, { ...SWEEP_ENV, TENANT_ID: TENANT_B }));
    appB = await buildApp({
      db: ctx.db,
      runtime: new MockAgentRuntime(),
      config: configB,
      fileStore: ctx.fileStore,
      mailRuntime: null,
      embeddingProvider: null,
    });
    await appB.ready();
    const login = await appB.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: configB.appOrigin },
      payload: { email: 'owner@other.test', password: 'other-owner-password' },
    });
    expect(login.statusCode).toBe(200);
    ownerB = `opentradie_session=${login.cookies.find((c) => c.name === 'opentradie_session')!.value}`;

    const openApi = (await ctx.get('/api/openapi.json', '')).body as {
      paths: Record<string, Record<string, { security: unknown[]; description?: string }>>;
    };
    routes = [];
    ownerOnly = new Set();
    for (const [path, methods] of Object.entries(openApi.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const route = { method: method.toUpperCase(), url: path.replace(/\{(\w+)\}/g, ':$1') };
        routes.push(route);
        if (operation.description?.includes('Requires the owner role')) ownerOnly.add(key(route));
      }
    }
    routes.push({ method: 'GET', url: '/api/openapi.json' });
  });
  afterAll(async () => {
    await appB?.close();
    await ctx?.close();
  });

  it('every Fastify route is documented, and every public route is explicitly allowlisted', () => {
    const documented = new Set(routes.map(key));
    const undocumented = fastifyRoutes(ctx.app)
      .filter((route) => !isWebAsset(route))
      .map(key)
      .filter((route) => !documented.has(route) && !PUBLIC_ROUTES.has(route));
    // Sanity: the tree parser found the API routes themselves.
    expect(fastifyRoutes(ctx.app).filter((r) => documented.has(key(r))).length).toBe(
      documented.size,
    );
    expect(undocumented).toEqual([]);
    expect(routes.length).toBeGreaterThan(100);
  });

  it('rejects unauthenticated requests on every non-public route with 401', async () => {
    const failures: string[] = [];
    for (const route of routes) {
      if (PUBLIC_ROUTES.has(key(route))) continue;
      const url = route.url.replace(/:(\w+)/g, (_m, name) =>
        name === 'provider' ? 'gmail' : randomUUID(),
      );
      const response = await ctx.app.inject({
        method: route.method as 'GET',
        url,
        headers: { origin: ctx.config.appOrigin, 'idempotency-key': randomUUID() },
        ...(MUTATING.has(route.method) ? { payload: {} } : {}),
      });
      if (response.statusCode !== 401) failures.push(`${key(route)} -> ${response.statusCode}`);
    }
    expect(failures).toEqual([]);
  });

  it('every public route in the allowlist is still registered (the list cannot rot)', () => {
    const all = new Set([...routes.map(key), ...fastifyRoutes(ctx.app).map(key)]);
    const missing = [...PUBLIC_ROUTES].filter((r) => !all.has(r));
    expect(missing).toEqual([]);
  });

  it('gives a viewer 403 OWNER_REQUIRED on every mutating route', async () => {
    const failures: string[] = [];
    for (const route of routes) {
      const k = key(route);
      if (!MUTATING.has(route.method) || PUBLIC_ROUTES.has(k) || VIEWER_MUTATIONS.has(k)) continue;
      if (!ownerOnly.has(k)) failures.push(`${k} is mutating but not owner-only`);
      const url = route.url.replace(/:(\w+)/g, (_m, name) =>
        name === 'provider' ? 'gmail' : randomUUID(),
      );
      const response = await ctx.send(route.method as 'POST', url, viewer, BODIES[k] ?? {});
      if (response.status !== 403 || response.body.error !== 'OWNER_REQUIRED')
        failures.push(`${k} -> ${response.status}`);
    }
    expect(failures).toEqual([]);
  });

  it("gives tenant B's owner 404 for tenant A ids on every id route, and changes nothing", async () => {
    const auditBefore = (
      await ctx.db.pool.query('SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=$1', [
        TENANT_A,
      ])
    ).rows[0].n;
    const failures: string[] = [];
    let checked = 0;
    for (const route of routes) {
      const k = key(route);
      if (PUBLIC_ROUTES.has(k) || !route.url.includes(':')) continue;
      const segments = route.url.split('/');
      const params = segments.filter((s) => s.startsWith(':'));
      if (params.every((p) => NON_ID_PARAMS.has(p))) continue;
      let url = route.url;
      let foreign: string | null = null;
      for (const [index, segment] of segments.entries()) {
        if (!segment.startsWith(':id')) continue;
        const table = ID_TABLES[segments[index - 1]!];
        if (!table) {
          failures.push(`${k}: no tenant table classified for /${segments[index - 1]}/:id`);
          continue;
        }
        foreign = ids[table]!;
        url = url.replace(':id', foreign);
      }
      if (!foreign) continue;
      checked++;
      const response = MUTATING.has(route.method)
        ? await appB.inject({
            method: route.method as 'POST',
            url,
            headers: {
              cookie: ownerB,
              origin: ctx.config.appOrigin,
              'idempotency-key': randomUUID(),
            },
            payload: (BODIES[k] ?? {}) as object,
          })
        : await appB.inject({ method: 'GET', url, headers: { cookie: ownerB } });
      if (response.statusCode !== 404)
        failures.push(`${k} -> ${response.statusCode} ${response.body.slice(0, 120)}`);
      if (response.body.includes(foreign) || response.body.includes(TENANT_A))
        failures.push(`${k} leaked tenant A data`);
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(40);
    const auditAfter = (
      await ctx.db.pool.query('SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=$1', [
        TENANT_A,
      ])
    ).rows[0].n;
    expect(auditAfter).toBe(auditBefore);
  });
});
