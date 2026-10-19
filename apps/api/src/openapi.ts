import { z, type ZodType } from 'zod';
import type { RouteSpec } from './http.js';
import { APP_VERSION } from './routes/system.js';

function schema(type: ZodType): unknown {
  return z.toJSONSchema(type, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' });
}

function parameters(spec: RouteSpec): unknown[] {
  const result: unknown[] = [];
  for (const [location, type] of [
    ['path', spec.params],
    ['query', spec.query],
  ] as const) {
    if (!type) continue;
    const json = schema(type) as { properties?: Record<string, unknown>; required?: string[] };
    for (const [name, property] of Object.entries(json.properties ?? {})) {
      result.push({ name, in: location, required: location === 'path' || (json.required ?? []).includes(name), schema: property });
    }
  }
  if (spec.idempotent) {
    result.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      description: 'Reuse only when retrying the same operation with the same input; the original response is replayed.',
      schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' },
    });
  }
  return result;
}

/** Generated from the same Zod schemas that validate requests, so the document cannot drift. */
export function buildOpenApiDocument(specs: readonly RouteSpec[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const spec of specs) {
    const path = spec.url.replace(/:([a-zA-Z]+)/g, '{$1}');
    paths[path] ??= {};
    paths[path][spec.method.toLowerCase()] = {
      summary: spec.summary,
      tags: spec.tags,
      security: spec.auth === 'public' ? [] : [{ session: [] }],
      ...(spec.auth === 'owner' ? { description: 'Requires the owner role. Viewers receive 403 OWNER_REQUIRED.' } : {}),
      parameters: parameters(spec),
      ...(spec.body ? { requestBody: { required: true, content: { 'application/json': { schema: schema(spec.body) } } } } : {}),
      responses: Object.fromEntries(
        Object.entries(spec.responses).map(([status, response]) => [
          status,
          { description: response.description, ...(response.schema ? { content: { 'application/json': { schema: schema(response.schema) } } } : {}) },
        ]),
      ),
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'OPENTRADIE API',
      version: APP_VERSION,
      description:
        'Single-tenant runtime. Tenant identity comes only from the authenticated server-side session. Browser mutations must send an Origin matching APP_ORIGIN. Errors are {error,message,requestId}. Money is integer cents.',
    },
    components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'opentradie_session' } } },
    paths,
  };
}
