import { randomUUID } from 'node:crypto';
import { recordAudit, transaction, type Database, type Queryable } from '@opentradie/database';
import { z } from 'zod';
import { type RouteRegistry } from '../http.js';
import { idParams } from '../schemas.js';
import type { FileStore } from '@opentradie/platform';
import {
  buildCustomerExport,
  CUSTOMER_EXPORT_FORMAT_VERSION,
  deleteErasedFiles,
  eraseCustomer,
} from '../services/customer-privacy.js';
import { APP_VERSION } from './system.js';
import { planExportArchive } from '../services/export-archive.js';

const formatQuery = z.object({ format: z.enum(['json', 'zip']).default('json') });

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
  'communication_threads',
  'communications',
  'approved_rates',
  'approved_rate_history',
  'quotes',
  'quote_line_items',
  'approval_requests',
  'quote_acceptance_tokens',
  'quote_decisions',
  'documents',
  'voice_notes',
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

export const EXCLUDED_COLUMNS = new Set([
  'password_hash',
  'encrypted_credentials',
  'encryption_key_id',
  'token_hash',
  'search_vector',
]);
const SECRET_COLUMN = /password|secret|token|credential|private_key|key_id/i;

export const EXCLUDED_TABLES: Record<string, string> = {
  sessions: 'Sign-in session tokens (security secrets).',
  user_mfa: 'Encrypted two-factor secrets (security secrets).',
  user_recovery_codes: 'Hashed two-factor recovery codes (security secrets).',
  auth_tokens: 'Pending two-factor sign-ins and password reset links (security secrets).',
  idempotency_records: 'Request replay cache (operational).',
  scheduled_tasks: 'Background job queue (operational).',
  scheduled_task_failures: 'Background job failures (operational).',
  relay_inbox: 'Inbound relay buffer (operational).',
  webhook_receipts: 'Inbound webhook de-duplication receipts (operational).',
  installation_claim: 'Runtime installation lock (operational, not tenant data).',
  knowledge_embeddings: 'Derived vectors; regenerated from knowledge items.',
  schema_migrations: 'Recorded as schemaVersion.',
  agent_sessions: 'Agent tool gateway sessions (operational; hashed session keys).',
  agent_tool_calls: 'Agent tool call log (operational; redacted inputs).',
  event_outbox: 'Transactional outbox (operational; identifiers only).',
  calendar_feed_tokens: 'Private calendar feed links (security secrets: hashed tokens).',
  fake_accounting_contacts: 'Fake accounting ledger (demo and test only, not business data).',
  fake_accounting_invoices: 'Fake accounting ledger (demo and test only, not business data).',
  fake_accounting_payments: 'Fake accounting ledger (demo and test only, not business data).',
  fake_accounting_idempotency: 'Fake accounting ledger (demo and test only, not business data).',
  oauth_authorisations:
    'Pending OAuth sign-ins (security secrets: hashed state, sealed PKCE verifier).',
};

export const EXPORT_FORMAT = 'opentradie-business-export';
export const EXPORT_FORMAT_VERSION = 1;

/**
 * Walk tables and return their rows as JSON, leaving out secret and derived columns. `where`
 * gives each table's filter; it must constrain tenant_id (or id for businesses) to $1.
 */
export async function dumpTables(
  client: Queryable,
  tableNames: readonly string[],
  where: (table: string) => string,
  params: unknown[],
) {
  const columns = await client.query<{ table_name: string; column_name: string }>(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name = ANY($1::text[]) ORDER BY table_name, ordinal_position",
    [tableNames],
  );
  const tables: Record<string, { columns: string[]; rows: unknown[] }> = {};
  for (const table of tableNames) {
    const names = columns.rows
      .filter((column) => column.table_name === table)
      .map((column) => column.column_name)
      .filter((name) => !EXCLUDED_COLUMNS.has(name) && !SECRET_COLUMN.test(name));
    if (!names.length) continue;
    const list = names.map((name) => `"${name}"`).join(',');
    const order = names.includes('created_at')
      ? 'created_at, id'
      : names.includes('id')
        ? 'id'
        : names.map((name) => `"${name}"`).join(',');
    // Postgres renders the JSON so bigint, numeric and timestamps keep their exact text.
    const result = await client.query<{ rows: unknown[] | null }>(
      `SELECT json_agg(row_to_json(t) ORDER BY ${order}) AS rows FROM (SELECT ${list} FROM "${table}" WHERE ${where(table)}) t`,
      params,
    );
    tables[table] = { columns: names, rows: result.rows[0]?.rows ?? [] };
  }
  return tables;
}

export async function buildExport(db: Database, tenantId: string) {
  // One REPEATABLE READ snapshot so every table reflects the same moment.
  return transaction(db, async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const migrations = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name',
    );
    const tables = await dumpTables(
      client,
      EXPORT_TABLES,
      (table) => (table === 'businesses' ? 'id=$1' : 'tenant_id=$1'),
      [tenantId],
    );
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
        note: 'Document and photo contents are not embedded. Each documents row records storage_key, size_bytes and sha256; copy the file store (or a backup) alongside this export, or request format=zip to include the files.',
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

export function registerExportRoutes(
  api: RouteRegistry,
  deps: { db: Database; fileStore: FileStore },
) {
  api.route(
    {
      method: 'GET',
      url: '/api/customers/:id/export',
      summary:
        'Owner-only export of everything held about one customer as a versioned JSON bundle (no secrets, tokens or hashes; file contents not embedded). Audited.',
      tags: ['export', 'customers'],
      auth: 'owner',
      params: idParams,
      query: formatQuery,
      rateLimit: { max: 20, timeWindow: '1 minute' },
      responses: {
        200: {
          description:
            'Customer export bundle (JSON), or with format=zip a streamed ZIP of export.json, manifest.json (sha256 per file) and files/',
        },
        413: { description: 'EXPORT_TOO_LARGE (format=zip)' },
        403: { description: 'OWNER_REQUIRED' },
        404: { description: 'CUSTOMER_NOT_FOUND (including other tenants)' },
      },
    },
    async ({ user, params, query, request, reply }) => {
      const bundle = await buildCustomerExport(deps.db, user.tenantId, params.id);
      const archive = query.format === 'zip' ? planExportArchive(bundle, deps.fileStore) : null;
      await recordAudit(deps.db.pool, {
        tenantId: user.tenantId,
        actorType: 'user',
        actorId: user.id,
        action: 'customer.exported',
        entityType: 'customer',
        entityId: params.id,
        requestId: request.id ?? randomUUID(),
        metadata: {
          formatVersion: CUSTOMER_EXPORT_FORMAT_VERSION,
          counts: bundle.counts,
          format: query.format,
          ...(archive ? { files: archive.fileCount, filesOmitted: archive.omittedCount } : {}),
        },
      });
      const name = `opentradie-customer-${params.id.slice(0, 8)}-${bundle.generatedAt.slice(0, 10)}`;
      if (archive) {
        reply.header('content-type', 'application/zip');
        reply.header('content-disposition', `attachment; filename="${name}.zip"`);
        return { body: archive.stream() };
      }
      reply.header('content-disposition', `attachment; filename="${name}.json"`);
      return { body: bundle };
    },
  );

  api.route(
    {
      method: 'POST',
      url: '/api/customers/:id/erase',
      summary:
        "Owner-only erasure of a customer's personal data. Financial records are kept pseudonymised; files are deleted. Requires the customer's name typed as confirmation. Idempotent; audited without personal data.",
      tags: ['customers'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: z.object({ confirmName: z.string().min(1).max(400) }),
      rateLimit: { max: 10, timeWindow: '1 minute' },
      responses: {
        200: { description: 'Erasure result (counts only)' },
        403: { description: 'OWNER_REQUIRED' },
        404: { description: 'CUSTOMER_NOT_FOUND (including other tenants)' },
        422: { description: 'CONFIRMATION_MISMATCH' },
      },
    },
    async ({ user, params, body, request, idempotent }) => {
      let fileKeys: string[] = [];
      const response = await idempotent(async (client) => {
        const erased = await eraseCustomer(client, user, request.id, params.id, body.confirmName);
        fileKeys = erased.fileKeys;
        return { body: { ...erased.result, filesToDelete: erased.fileKeys.length } };
      });
      // After commit: a rolled-back erasure must not have lost the files.
      if (fileKeys.length) {
        const outcome = await deleteErasedFiles(deps.fileStore, fileKeys);
        if (outcome.failed)
          request.log.warn({ failed: outcome.failed }, 'customer erasure: some files not deleted');
      }
      return response;
    },
  );

  api.route(
    {
      method: 'GET',
      url: '/api/export',
      summary:
        'Owner-only export of all business data as a versioned JSON bundle (no password hashes, session tokens or provider credentials). Audited.',
      tags: ['export'],
      auth: 'owner',
      query: formatQuery,
      rateLimit: { max: 10, timeWindow: '1 minute' },
      responses: {
        413: { description: 'EXPORT_TOO_LARGE (format=zip)' },
        200: {
          description:
            'Export bundle (JSON), or with format=zip a streamed ZIP of export.json, manifest.json (sha256 per file) and files/',
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
    async ({ user, query, request, reply }) => {
      const bundle = await buildExport(deps.db, user.tenantId);
      const archive = query.format === 'zip' ? planExportArchive(bundle, deps.fileStore) : null;
      await recordAudit(deps.db.pool, {
        tenantId: user.tenantId,
        actorType: 'user',
        actorId: user.id,
        action: 'business.exported',
        entityType: 'business',
        entityId: user.tenantId,
        requestId: request.id ?? randomUUID(),
        metadata: {
          formatVersion: EXPORT_FORMAT_VERSION,
          counts: bundle.counts,
          format: query.format,
          ...(archive ? { files: archive.fileCount, filesOmitted: archive.omittedCount } : {}),
        },
      });
      const name = `opentradie-export-${bundle.generatedAt.slice(0, 10)}`;
      if (archive) {
        reply.header('content-type', 'application/zip');
        reply.header('content-disposition', `attachment; filename="${name}.zip"`);
        return { body: archive.stream() };
      }
      reply.header('content-disposition', `attachment; filename="${name}.json"`);
      return { body: bundle };
    },
  );
}
