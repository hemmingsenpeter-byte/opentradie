import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerResponse, healthResponse, jobResponse } from '../../apps/api/src/schemas.js';
import { createTestContext, customerId, type TestContext } from '../helpers/app.js';

describe('customers, jobs, search and dashboard', () => {
  let ctx: TestContext;
  let owner: string;
  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await ctx.login();
  });
  afterAll(async () => ctx?.close());

  it('creates, reads, updates and archives a customer with audit events', async () => {
    const created = await ctx.send('POST', '/api/customers', owner, {
      name: 'Wiremu Parata',
      email: 'wiremu@example.test',
      address: '9 Tōtara Ave, Hamilton',
    });
    expect(created.status).toBe(201);
    const customer = customerResponse.parse(created.body);
    const updated = await ctx.send('PATCH', `/api/customers/${customer.id}`, owner, {
      phone: '+64 27 555 0199',
      preferredName: 'Wiremu',
    });
    expect(updated.body).toMatchObject({
      phone: '+64 27 555 0199',
      preferredName: 'Wiremu',
      name: 'Wiremu Parata',
    });
    const profile = await ctx.get(`/api/customers/${customer.id}`, owner);
    expect(profile.body.customer.id).toBe(customer.id);
    const archived = await ctx.send('DELETE', `/api/customers/${customer.id}`, owner);
    expect(archived.body.archived).toBe(true);
    const listed = await ctx.get('/api/customers', owner);
    expect(listed.body.customers.map((c: { id: string }) => c.id)).not.toContain(customer.id);
    const audit = await ctx.get(`/api/audit-events?entityId=${customer.id}`, owner);
    expect(audit.body.auditEvents.map((event: { action: string }) => event.action).sort()).toEqual([
      'customer.archived',
      'customer.created',
      'customer.updated',
    ]);
  });

  it('searches customers with Postgres full-text and partial name match', async () => {
    const byName = await ctx.get('/api/customers?q=johnson', owner);
    expect(byName.body.customers.map((c: { name: string }) => c.name).sort()).toEqual([
      'Helen Johnson',
      'Mrs Johnson',
    ]);
    const partial = await ctx.get('/api/customers?q=Hel', owner);
    expect(partial.body.customers.map((c: { name: string }) => c.name)).toEqual(['Helen Johnson']);
    const byEmail = await ctx.get('/api/customers?q=margaret', owner);
    expect(byEmail.body.customers.map((c: { name: string }) => c.name)).toEqual(['Mrs Johnson']);
    const search = await ctx.get('/api/search?q=ceramic', owner);
    expect(search.body.knowledge[0]).toMatchObject({
      sourceType: 'job_note',
      provenance: 'verified',
    });
    expect(search.body.knowledge[0].content).toMatch(/ceramic-fuse/);
  });

  it('creates and updates jobs with notes', async () => {
    const margaret = await customerId(ctx.db, 'Mrs Johnson');
    const created = await ctx.send('POST', '/api/jobs', owner, {
      customerId: margaret,
      title: 'Install heated towel rail',
      notes: 'Bathroom, existing circuit.',
    });
    expect(created.status).toBe(201);
    const job = jobResponse.parse(created.body);
    expect(job).toMatchObject({
      status: 'new',
      notes: 'Bathroom, existing circuit.',
      customerName: 'Mrs Johnson',
    });
    const updated = await ctx.send('PATCH', `/api/jobs/${job.id}`, owner, {
      status: 'completed',
      notes: 'Done; tested RCD.',
    });
    expect(updated.body).toMatchObject({ status: 'completed', notes: 'Done; tested RCD.' });
    expect(updated.body.completedAt).not.toBeNull();
    const note = await ctx.send('POST', `/api/jobs/${job.id}/notes`, owner, {
      text: 'Customer happy.',
    });
    expect(note.status).toBe(201);
    const detail = await ctx.get(`/api/jobs/${job.id}`, owner);
    expect(detail.body.notes).toHaveLength(3);
    const filtered = await ctx.get(`/api/jobs?status=completed&q=towel`, owner);
    expect(filtered.body.jobs.map((j: { id: string }) => j.id)).toEqual([job.id]);
    const invalid = await ctx.send('PATCH', `/api/jobs/${job.id}`, owner, { status: 'teleported' });
    expect(invalid.status).toBe(400);
  });

  it('serves the dashboard snapshot the web app uses', async () => {
    const state = (await ctx.get('/api/state', owner)).body;
    expect(state.business).toMatchObject({
      currency: 'NZD',
      timeZone: 'Pacific/Auckland',
      taxBasisPoints: 1500,
      demoData: true,
    });
    expect(state.rates.map((rate: { code: string }) => rate.code)).toContain('power_point_replace');
    expect(state.settings).toMatchObject({
      profile: 'local',
      privacyMode: 'LOCAL_ONLY',
      agentMode: 'mock',
      agentHealth: 'ok',
      agentSynthetic: true,
      demoData: true,
    });
    expect(state.communications.length).toBeGreaterThan(0);
    for (const key of ['user', 'customers', 'jobs', 'quotes', 'auditEvents'])
      expect(state).toHaveProperty(key);
  });

  it('reports health without secrets', async () => {
    const response = await ctx.get('/health', '');
    const health = healthResponse.parse(response.body);
    expect(health).toMatchObject({
      status: 'ok',
      privacyMode: 'LOCAL_ONLY',
      agent: { mode: 'mock', synthetic: true, status: 'ok' },
      database: { status: 'ok' },
    });
    expect(health.agent.label).toMatch(/Mock agent runtime/);
    expect(JSON.stringify(response.body)).not.toMatch(/postgres:\/\/|SESSION|secret/i);
  });

  it('serves an OpenAPI 3.1 document generated from every registered route', async () => {
    const document = (await ctx.get('/api/openapi.json', '')).body;
    expect(document.openapi).toBe('3.1.0');
    const operations = Object.entries(
      document.paths as Record<string, Record<string, { parameters: Array<{ name: string }> }>>,
    ).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, operation]) => ({
        id: `${method.toUpperCase()} ${path}`,
        operation,
      })),
    );
    const ids = operations.map((operation) => operation.id);
    for (const expected of [
      'POST /api/auth/login',
      'GET /api/state',
      'GET /api/customers',
      'POST /api/customers',
      'PATCH /api/customers/{id}',
      'POST /api/jobs',
      'PATCH /api/jobs/{id}',
      'POST /api/enquiries',
      'POST /api/quotes/{id}/approve',
      'POST /api/quotes/{id}/reject',
      'GET /health',
    ]) {
      expect(ids).toContain(expected);
    }
    for (const { id, operation } of operations.filter((operation) =>
      /^(POST|PATCH|DELETE) \/api\/(?!auth)/.test(operation.id),
    )) {
      expect(
        operation.parameters.map((parameter) => parameter.name),
        id,
      ).toContain('Idempotency-Key');
    }
  });
});
