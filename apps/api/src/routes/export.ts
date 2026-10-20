import { randomUUID } from 'node:crypto';
import { recordAudit, transaction, type Database } from '@opentradie/database';
import { z } from 'zod';
import { type RouteRegistry } from '../http.js';
import { APP_VERSION } from './system.js';

/**
 * Business data the owner can take with them. Every table here is tenant-scoped; operational
 * tables (sessions, idempotency records, queue, relay inbox, installation claim) are not
 * business records and are left out. Columns that hold secrets or derived indexes are never
 * exported, whatever table they appear in.
 */
export const EXPORT_TABLES = [
  'businesses',
  'users',
  'customers',
  'customer_contacts',
  'properties',
  'jobs',
  'job_notes',
  'job_events',
  'appointments',
  'availability_rules',
  'scheduling_settings',
  'reminders',
  'communications',
  'approved_rates',
  'quotes',
  'quote_line_items',
  'approval_requests',
  'quote_acceptance_tokens',
  'quote_decisions',
  'documents',
  'knowledge_items',
  'model_use_approvals',
  'provider_connections',
  'action_proposals',
  'agent_tool_policies',
  'job_time_entries',
  'job_materials',
  'invoices',
  'invoice_lines',
  'external_references',
  'accounting_sync_attempts',
  'payment_snapshots',
  'audit_events',
] as const;

const EXCLUDED_COLUMNS = new Set([
  'password_hash',
  'encrypted_credentials',
  'encryption_key_id',
  'token_hash',
  'search_vector',
]);
const SECRET_COLUMN = /password|secret|token|credential|private_key|key_id/i;

export const EXCLUDED_TABLES: Record<string, string> = {
  sessions: 'Sign-in session tokens (security secrets).',
  idempotency_records: 'Request replay cache (operational).',
  scheduled_tasks: 'Background job queue (operational).',
  scheduled_task_failures: 'Background job failures (operational).',
  relay_inbox: 'Inbound relay buffer (operational).',
  installation_claim: 'Runtime installation lock (operational, not tenant data).',
  knowledge_embeddings: 'Derived vectors; regenerated from knowledge items.',
  schema_migrations: 'Recorded as schemaVersion.',
  agent_sessions: 'Agent tool gateway sessions (operational; hashed session keys).',
  agent_tool_calls: 'Agent tool call log (operational; redacted inputs).',
  event_outbox: 'Transactional outbox (operational; identifiers only).',
  oauth_authorisations:
    'Pending OAuth sign-ins (security secrets: hashed state, sealed PKCE verifier).',
};

export const EXPORT_FORMAT = 'opentradie-business-export';
export const EXPORT_FORMAT_VERSION = 1;

export async function buildExport(db: Database, tenantId: string) {
  // One REPEATABLE READ snapshot so every table reflects the same moment.
  return transaction(db, async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const migrations = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name',
    );
    const columns = await client.query<{ table_name: string; column_name: string }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name = ANY($1::text[]) ORDER BY table_name, ordinal_position",
      [EXPORT_TABLES],
    );
    const tables: Record<string, { columns: string[]; rows: unknown[] }> = {};
    for (const table of EXPORT_TABLES) {
      const names = columns.rows
        .filter((column) => column.table_name === table)
        .map((column) => column.column_name)
        .filter((name) => !EXCLUDED_COLUMNS.has(name) && !SECRET_COLUMN.test(name));
      if (!names.length) continue;
      const list = names.map((name) => `"${name}"`).join(',');
      const where = table === 'businesses' ? 'id=$1' : 'tenant_id=$1';
      const order = names.includes('created_at')
        ? 'created_at, id'
        : names.includes('id')
          ? 'id'
          : names.map((name) => `"${name}"`).join(',');
      // Postgres renders the JSON so bigint, numeric and timestamps keep their exact text.
      const result = await client.query<{ rows: unknown[] | null }>(
        `SELECT json_agg(row_to_json(t) ORDER BY ${order}) AS rows FROM (SELECT ${list} FROM "${table}" WHERE ${where}) t`,
        [tenantId],
      );
      tables[table] = { columns: names, rows: result.rows[0]?.rows ?? [] };
    }
    return {
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      appVersion: APP_VERSION,
      schemaVersion: migrations.rows.at(-1)?.name ?? null,
      appliedMigrations: migrations.rows.map((row) => row.name),
      generatedAt: new Date().toISOString(),
      tenantId,
      files: {
        included: false,
        note: 'Document and photo contents are not embedded. Each documents row records storage_key, size_bytes and sha256; copy the file store (or a backup) alongside this export.',
      },
      excludedColumns: [...EXCLUDED_COLUMNS],
      excludedTables: EXCLUDED_TABLES,
      counts: Object.fromEntries(
        Object.entries(tables).map(([name, table]) => [name, table.rows.length]),
      ),
      tables,
    };
  });
}

export function registerExportRoutes(api: RouteRegistry, deps: { db: Database }) {
  api.route(
    {
      method: 'GET',
      url: '/api/export',
      summary:
        'Owner-only export of all business data as a versioned JSON bundle (no password hashes, session tokens or provider credentials). Audited.',
      tags: ['export'],
      auth: 'owner',
      rateLimit: { max: 10, timeWindow: '1 minute' },
      responses: {
        200: {
          description: 'Export bundle',
          schema: z.object({
            format: z.literal(EXPORT_FORMAT),
            formatVersion: z.number().int(),
            schemaVersion: z.string().nullable(),
            generatedAt: z.string(),
            tables: z.record(
              z.string(),
              z.object({ columns: z.array(z.string()), rows: z.array(z.unknown()) }),
            ),
          }),
        },
        403: { description: 'OWNER_REQUIRED' },
      },
    },
    async ({ user, request, reply }) => {
      const bundle = await buildExport(deps.db, user.tenantId);
      await recordAudit(deps.db.pool, {
        tenantId: user.tenantId,
        actorType: 'user',
        actorId: user.id,
        action: 'business.exported',
        entityType: 'business',
        entityId: user.tenantId,
        requestId: request.id ?? randomUUID(),
        metadata: { formatVersion: EXPORT_FORMAT_VERSION, counts: bundle.counts },
      });
      reply.header(
        'content-disposition',
        `attachment; filename="opentradie-export-${bundle.generatedAt.slice(0, 10)}.json"`,
      );
      return { body: bundle };
    },
  );
}
