const uuid = { type: 'string', format: 'uuid' };
const string = { type: 'string' };
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const response = { description: 'Validated JSON response. Errors use {error,message,requestId}.' };
const json = (schema: unknown) => ({ required: true, content: { 'application/json': { schema } } });
const id = { name: 'id', in: 'path', required: true, schema: uuid };
const idempotency = { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' }, description: 'Reuse the key only when retrying the same operation and input.' };

/** Runtime validation lives in app.ts; this compact document exposes the supported HTTP surface. */
export const openApiDocument = {
  openapi: '3.1.0',
  info: { title: 'OPENTRADIE API', version: '0.1.0', description: 'Single-tenant runtime. Tenant identity comes from the authenticated server-side session. Mutations require an Origin header matching APP_ORIGIN; owner role required except logout.' },
  security: [{ session: [] }],
  components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'opentradie_session' } } },
  paths: {
    '/health': { get: { security: [], responses: { '200': response, '503': response } } },
    '/api/auth/login': { post: { security: [], requestBody: json(object({ email: { type: 'string', format: 'email' }, password: { type: 'string', maxLength: 256 } }, ['email', 'password'])), responses: { '200': response, '401': response, '429': response } } },
    '/api/auth/logout': { post: { responses: { '200': response } } },
    '/api/me': { get: { responses: { '200': response } } },
    '/api/state': { get: { responses: { '200': response } } },
    '/api/search': { get: { parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 2, maxLength: 200 } }], responses: { '200': response } } },
    '/api/customers': { post: { requestBody: json(object({ name: { type: 'string', minLength: 1, maxLength: 200 }, email: { type: 'string', format: 'email' }, phone: string }, ['name'])), responses: { '201': response } } },
    '/api/jobs': { post: { requestBody: json(object({ customerId: uuid, title: { type: 'string', minLength: 1, maxLength: 300 }, notes: { type: 'string', maxLength: 5000 } }, ['customerId', 'title'])), responses: { '201': response } } },
    '/api/jobs/{id}': { patch: { parameters: [id], requestBody: json(object({ status: { enum: ['new', 'quoted', 'scheduled', 'in_progress', 'completed'] }, notes: { type: 'string', maxLength: 5000 } }, [])), responses: { '200': response, '404': response } } },
    '/api/enquiries': { post: { parameters: [idempotency], requestBody: json(object({ text: { type: 'string', minLength: 5, maxLength: 8000 }, customerId: uuid }, ['text'])), responses: { '200': response, '403': response, '409': response, '503': response } } },
    '/api/quotes/{id}/approve': { post: { parameters: [id, idempotency], requestBody: json(object({ version: { type: 'integer', minimum: 1 } }, ['version'])), responses: { '200': response, '403': response, '404': response, '409': response } } },
  },
};
