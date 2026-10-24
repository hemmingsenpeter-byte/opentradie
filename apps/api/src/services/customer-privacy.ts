import { randomUUID } from 'node:crypto';
import { recordAudit, transaction, type Database, type Transaction } from '@opentradie/database';
import type { FileStore } from '@opentradie/platform';
import { HttpError, type UserContext } from '../http.js';
import { dumpTables } from '../routes/export.js';
import { APP_VERSION } from '../routes/system.js';

/**
 * Per-customer export and erasure (ADR 0025). Both use the same scope: every row that belongs
 * to one customer, found through the customer's own id, its jobs, quotes, invoices, threads,
 * communications and voice notes. $1 is always the tenant and $2 the customer.
 */
const JOBS = 'SELECT id FROM jobs WHERE tenant_id=$1 AND customer_id=$2';
const QUOTES = 'SELECT id FROM quotes WHERE tenant_id=$1 AND customer_id=$2';
const INVOICES = 'SELECT id FROM invoices WHERE tenant_id=$1 AND customer_id=$2';
const THREADS = `SELECT id FROM communication_threads WHERE tenant_id=$1 AND (customer_id=$2 OR job_id IN (${JOBS}))`;
const COMMUNICATIONS = `SELECT id FROM communications WHERE tenant_id=$1 AND (customer_id=$2 OR job_id IN (${JOBS}) OR thread_id IN (${THREADS}))`;
const VOICE_NOTES = `SELECT id FROM voice_notes WHERE tenant_id=$1 AND (resolved_customer_id=$2 OR resolved_job_id IN (${JOBS}))`;
const DOCUMENTS = `SELECT id FROM documents WHERE tenant_id=$1 AND (customer_id=$2 OR job_id IN (${JOBS}) OR quote_id IN (${QUOTES}) OR invoice_id IN (${INVOICES}) OR communication_id IN (${COMMUNICATIONS}) OR id IN (SELECT document_id FROM voice_notes WHERE tenant_id=$1 AND id IN (${VOICE_NOTES})))`;

export const CUSTOMER_SCOPE: Record<string, string> = {
  customers: 'id=$2',
  customer_contacts: 'customer_id=$2',
  properties: 'customer_id=$2',
  jobs: 'customer_id=$2',
  job_notes: `job_id IN (${JOBS})`,
  job_events: `job_id IN (${JOBS})`,
  appointments: `job_id IN (${JOBS})`,
  reminders: `(customer_id=$2 OR job_id IN (${JOBS}))`,
  communication_threads: `id IN (${THREADS})`,
  communications: `id IN (${COMMUNICATIONS})`,
  quotes: 'customer_id=$2',
  quote_line_items: `quote_id IN (${QUOTES})`,
  approval_requests: `quote_id IN (${QUOTES})`,
  quote_decisions: `quote_id IN (${QUOTES})`,
  documents: `id IN (${DOCUMENTS})`,
  voice_notes: `id IN (${VOICE_NOTES})`,
  knowledge_items: `(customer_id=$2 OR job_id IN (${JOBS}))`,
  action_proposals: `(customer_id=$2 OR job_id IN (${JOBS}))`,
  job_time_entries: `job_id IN (${JOBS})`,
  job_materials: `job_id IN (${JOBS})`,
  invoices: 'customer_id=$2',
  invoice_lines: `invoice_id IN (${INVOICES})`,
  payment_snapshots: `invoice_id IN (${INVOICES})`,
};

export const CUSTOMER_EXPORT_FORMAT = 'opentradie-customer-export';
export const CUSTOMER_EXPORT_FORMAT_VERSION = 1;

async function requireCustomer(client: Transaction, tenantId: string, customerId: string) {
  const result = await client.query<{ id: string; name: string; erased_at: Date | null }>(
    'SELECT id,name,erased_at FROM customers WHERE tenant_id=$1 AND id=$2',
    [tenantId, customerId],
  );
  const customer = result.rows[0];
  if (!customer) throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
  return customer;
}

export async function buildCustomerExport(db: Database, tenantId: string, customerId: string) {
  return transaction(db, async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await requireCustomer(client, tenantId, customerId);
    const migrations = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name',
    );
    const tables = await dumpTables(
      client,
      Object.keys(CUSTOMER_SCOPE),
      (table) => `tenant_id=$1 AND ${CUSTOMER_SCOPE[table]}`,
      [tenantId, customerId],
    );
    return {
      format: CUSTOMER_EXPORT_FORMAT,
      formatVersion: CUSTOMER_EXPORT_FORMAT_VERSION,
      appVersion: APP_VERSION,
      schemaVersion: migrations.rows.at(-1)?.name ?? null,
      generatedAt: new Date().toISOString(),
      tenantId,
      customerId,
      files: {
        included: false,
        note: 'File contents are not embedded. Each documents row records file_name, media_type, size_bytes and sha256; request format=zip to include the files.',
      },
      counts: Object.fromEntries(
        Object.entries(tables).map(([name, table]) => [name, table.rows.length]),
      ),
      tables,
    };
  });
}

export const ERASED_TEXT = '[erased]';
/** Must match the value migration 0012 lets the job_events trigger accept. */
const ERASED_EVENT_SUMMARY = "Details erased at the customer's request";
/** Quote and invoice PDFs are financial records and are kept with the invoice or quote. */
const RETAINED_DOCUMENT_KINDS = ['approved_quote', 'quote_pdf'];

export interface ErasureResult {
  customerId: string;
  alreadyErased: boolean;
  erasedAt: string;
  counts: Record<string, number>;
}

/**
 * Erase one customer's personal data. Financial records (quotes, invoices, their lines and
 * decisions, payments) are kept with the customer pseudonymised; everything else that can
 * identify the person is redacted, and their files are deleted from the file store after the
 * transaction commits. Re-running on an erased customer changes nothing.
 */
export async function eraseCustomer(
  client: Transaction,
  user: UserContext,
  requestId: string,
  customerId: string,
  confirmName: string,
): Promise<{ result: ErasureResult; fileKeys: string[] }> {
  const customer = await requireCustomer(client, user.tenantId, customerId);
  if (customer.erased_at)
    return {
      result: {
        customerId,
        alreadyErased: true,
        erasedAt: customer.erased_at.toISOString(),
        counts: {},
      },
      fileKeys: [],
    };
  if (confirmName.trim() !== customer.name.trim())
    throw new HttpError(
      422,
      'CONFIRMATION_MISMATCH',
      "Type the customer's name exactly to confirm erasure.",
    );

  const params = [user.tenantId, customerId];
  const counts: Record<string, number> = {};
  const run = async (label: string, sql: string, extra: unknown[] = []) => {
    const result = await client.query(sql, [...params, ...extra]);
    counts[label] = (counts[label] ?? 0) + (result.rowCount ?? 0);
    return result;
  };
  // Lifted only for this transaction; migration 0012 accepts only the fixed redaction values.
  await client.query("SELECT set_config('opentradie.erasure', 'on', true)");

  // Files first: collect what to delete from the store once the transaction commits.
  const files = await client.query<{ storage_key: string }>(
    `SELECT storage_key FROM documents WHERE tenant_id=$1 AND ${CUSTOMER_SCOPE.documents}
       AND kind <> ALL($3::text[]) AND id NOT IN (SELECT pdf_document_id FROM invoices WHERE tenant_id=$1 AND pdf_document_id IS NOT NULL)`,
    [...params, RETAINED_DOCUMENT_KINDS],
  );
  await run(
    'documents',
    `UPDATE documents SET file_name=$3 WHERE tenant_id=$1 AND ${CUSTOMER_SCOPE.documents}
       AND kind <> ALL($4::text[]) AND id NOT IN (SELECT pdf_document_id FROM invoices WHERE tenant_id=$1 AND pdf_document_id IS NOT NULL)`,
    [ERASED_TEXT, RETAINED_DOCUMENT_KINDS],
  );

  await run(
    'voice_notes',
    `UPDATE voice_notes SET transcript=NULL, corrected_transcript=NULL, corrected_at=NULL, corrected_by=NULL,
       segments='[]', clarification='{}', updated_at=now() WHERE tenant_id=$1 AND ${CUSTOMER_SCOPE.voice_notes}`,
  );
  await run(
    'communications',
    `UPDATE communications SET text=$3, subject=NULL, sender=NULL, from_address=NULL, from_name=NULL,
       to_addresses='{}', cc_addresses='{}', message_id_header=NULL, in_reply_to=NULL, references_header='{}',
       triage=NULL, updated_at=now() WHERE tenant_id=$1 AND ${CUSTOMER_SCOPE.communications}`,
    [ERASED_TEXT],
  );
  await run(
    'communication_threads',
    `UPDATE communication_threads SET subject=NULL, subject_normalised=NULL, updated_at=now()
       WHERE tenant_id=$1 AND ${CUSTOMER_SCOPE.communication_threads}`,
  );
  // knowledge_embeddings exists only where pgvector is installed (migration 0003).
  const vectors = await client.query<{ present: boolean }>(
    "SELECT to_regclass('public.knowledge_embeddings') IS NOT NULL AS present",
  );
  if (vectors.rows[0]?.present)
    await run(
      'knowledge_embeddings',
      `DELETE FROM knowledge_embeddings WHERE tenant_id=$1 AND knowledge_item_id IN (
       SELECT id FROM knowledge_items WHERE tenant_id=$1 AND (${CUSTOMER_SCOPE.knowledge_items}
         OR (source_type='communication' AND source_id IN (${COMMUNICATIONS}))))`,
    );
  await run(
    'knowledge_items',
    `DELETE FROM knowledge_items WHERE tenant_id=$1 AND (${CUSTOMER_SCOPE.knowledge_items}
       OR (source_type='communication' AND source_id IN (${COMMUNICATIONS})))`,
  );
  await run(
    'job_notes',
    `UPDATE job_notes SET text=$3 WHERE tenant_id=$1 AND ${CUSTOMER_SCOPE.job_notes}`,
    [ERASED_TEXT],
  );
  await run(
    'job_events',
    `UPDATE job_events SET summary=$3, metadata='{"erased": true}'::jsonb
       WHERE tenant_id=$1 AND ${CUSTOMER_SCOPE.job_events}`,
    [ERASED_EVENT_SUMMARY],
  );
  await run(
    'appointments',
    `UPDATE appointments SET title='Appointment', notes=NULL, location=NULL, cancel_reason=NULL
       WHERE tenant_id=$1 AND ${CUSTOMER_SCOPE.appointments}`,
  );
  await run(
    'tasks',
    `UPDATE tasks SET title='Erased task', notes=NULL, updated_at=now() WHERE tenant_id=$1
       AND (customer_id=$2 OR job_id IN (SELECT id FROM jobs WHERE tenant_id=$1 AND customer_id=$2))`,
  );
  await run(
    'reminders',
    `UPDATE reminders SET payload='{}' WHERE tenant_id=$1 AND ${CUSTOMER_SCOPE.reminders}`,
  );
  await run(
    'action_proposals',
    `UPDATE action_proposals SET summary=$3, payload='{}', clarifications='[]', decision_reason=NULL, failure_reason=NULL
       WHERE tenant_id=$1 AND ${CUSTOMER_SCOPE.action_proposals}`,
    [ERASED_TEXT],
  );
  await run(
    'jobs',
    `UPDATE jobs SET title='Erased job', description=NULL, site_address=NULL, updated_at=now()
       WHERE tenant_id=$1 AND customer_id=$2`,
  );
  await run(
    'quote_decisions',
    `UPDATE quote_decisions SET signer_name=$3, comment=NULL WHERE tenant_id=$1 AND ${CUSTOMER_SCOPE.quote_decisions}`,
    [ERASED_TEXT],
  );
  await run(
    'invoices',
    `UPDATE invoices SET notes=NULL, updated_at=now() WHERE tenant_id=$1 AND customer_id=$2`,
  );
  await run(
    'properties',
    `UPDATE properties SET label=NULL, address_line1=$3, address_line2=NULL, suburb=NULL, city=NULL,
       postcode=NULL, access_notes=NULL, archived_at=coalesce(archived_at, now()), updated_at=now()
       WHERE tenant_id=$1 AND customer_id=$2`,
    [ERASED_TEXT],
  );
  await run(
    'customer_contacts',
    'DELETE FROM customer_contacts WHERE tenant_id=$1 AND customer_id=$2',
  );
  const erased = await client.query<{ erased_at: Date }>(
    `UPDATE customers SET name=$3, preferred_name=NULL, email=NULL, phone=NULL, address=NULL,
       archived_at=coalesce(archived_at, now()), erased_at=now(), updated_at=now()
       WHERE tenant_id=$1 AND id=$2 RETURNING erased_at`,
    [...params, `Erased customer ${customerId.slice(0, 8)}`],
  );
  // Counts and identifiers only: the audit trail must not keep what was erased.
  await recordAudit(client, {
    tenantId: user.tenantId,
    actorType: 'user',
    actorId: user.id,
    action: 'customer.erased',
    entityType: 'customer',
    entityId: customerId,
    requestId: requestId || randomUUID(),
    metadata: { counts, filesDeleted: files.rows.length },
  });
  return {
    result: {
      customerId,
      alreadyErased: false,
      erasedAt: erased.rows[0]!.erased_at.toISOString(),
      counts,
    },
    fileKeys: files.rows.map((row) => row.storage_key),
  };
}

/** Delete erased files from the store. A missing file is already gone. */
export async function deleteErasedFiles(fileStore: FileStore, keys: string[]) {
  let failed = 0;
  for (const key of keys) {
    try {
      await fileStore.delete(key);
    } catch {
      failed += 1;
    }
  }
  return { deleted: keys.length - failed, failed };
}
