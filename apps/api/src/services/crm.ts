import { randomUUID } from 'node:crypto';
import {
  computeCustomerReport,
  findDuplicateCandidates,
  normaliseAddress,
  normaliseTagName,
  type DateRange,
  type DuplicateReason,
} from '@opentradie/core';
import { recordAudit, type Queryable, type Transaction } from '@opentradie/database';
import { HttpError, iso, type UserContext } from '../http.js';

/**
 * CRM services (ADR 0034): tags, duplicate detection, customer merge and customer reports.
 * Every query is tenant-scoped; the tenant always comes from the session.
 */

export interface TagDto {
  id: string;
  name: string;
  colour: string;
  customerCount: number;
  createdAt: string;
}

export async function listTags(client: Queryable, tenantId: string): Promise<TagDto[]> {
  const result = await client.query<Omit<TagDto, 'createdAt'> & { createdAt: Date }>(
    `SELECT t.id,t.name,t.colour,t.created_at AS "createdAt",
       (SELECT count(*)::int FROM customer_tags ct JOIN customers c ON c.tenant_id=ct.tenant_id AND c.id=ct.customer_id
        WHERE ct.tenant_id=t.tenant_id AND ct.tag_id=t.id AND c.archived_at IS NULL) AS "customerCount"
     FROM tags t WHERE t.tenant_id=$1 ORDER BY t.name`,
    [tenantId],
  );
  return result.rows.map((row) => ({ ...row, createdAt: iso(row.createdAt)! }));
}

export async function getTag(client: Queryable, tenantId: string, id: string): Promise<TagDto> {
  const tag = (await listTags(client, tenantId)).find((row) => row.id === id);
  if (!tag) throw new HttpError(404, 'TAG_NOT_FOUND', 'Tag not found.');
  return tag;
}

/** Find a tag by name or create it (normalised). Returns the id. */
export async function ensureTag(
  client: Queryable,
  tenantId: string,
  name: string,
  colour = 'slate',
): Promise<{ id: string; created: boolean }> {
  const normalised = normaliseTagName(name);
  if (!normalised) throw new HttpError(422, 'TAG_NAME_REQUIRED', 'Give the tag a name.');
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO tags(id,tenant_id,name,colour) VALUES($1,$2,$3,$4)
     ON CONFLICT (tenant_id,name) DO NOTHING RETURNING id`,
    [randomUUID(), tenantId, normalised, colour],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM tags WHERE tenant_id=$1 AND name=$2',
    [tenantId, normalised],
  );
  return { id: existing.rows[0]!.id, created: false };
}

/** Replace a customer's tag set. Unknown (or other-tenant) tag ids are refused. */
export async function setCustomerTags(
  client: Queryable,
  tenantId: string,
  customerId: string,
  tagIds: readonly string[],
): Promise<{ added: string[]; removed: string[] }> {
  const customer = await client.query<{ archived: boolean }>(
    'SELECT (archived_at IS NOT NULL) AS archived FROM customers WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
    [tenantId, customerId],
  );
  if (!customer.rows[0]) throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
  if (customer.rows[0].archived)
    throw new HttpError(422, 'CUSTOMER_ARCHIVED', 'Archived customers cannot be tagged.');
  const wanted = [...new Set(tagIds)];
  const known = await client.query<{ id: string }>(
    'SELECT id FROM tags WHERE tenant_id=$1 AND id = ANY($2::uuid[])',
    [tenantId, wanted],
  );
  if (known.rows.length !== wanted.length)
    throw new HttpError(404, 'TAG_NOT_FOUND', 'One or more tags were not found.');
  const current = await client.query<{ tag_id: string }>(
    'SELECT tag_id FROM customer_tags WHERE tenant_id=$1 AND customer_id=$2',
    [tenantId, customerId],
  );
  const before = new Set(current.rows.map((row) => row.tag_id));
  const added = wanted.filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !wanted.includes(id));
  if (removed.length)
    await client.query(
      'DELETE FROM customer_tags WHERE tenant_id=$1 AND customer_id=$2 AND tag_id = ANY($3::uuid[])',
      [tenantId, customerId, removed],
    );
  if (added.length)
    await client.query(
      `INSERT INTO customer_tags(tenant_id,customer_id,tag_id)
       SELECT $1,$2,unnest($3::uuid[]) ON CONFLICT DO NOTHING`,
      [tenantId, customerId, added],
    );
  return { added, removed };
}

// ------------------------------------------------------------------ duplicates

export interface DuplicatePairDto {
  score: number;
  reasons: DuplicateReason[];
  customers: [DuplicateCustomer, DuplicateCustomer];
}
interface DuplicateCustomer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  jobCount: number;
  createdAt: string;
}

export async function listDuplicates(
  client: Queryable,
  tenantId: string,
): Promise<DuplicatePairDto[]> {
  const customers = await client.query<
    Omit<DuplicateCustomer, 'createdAt'> & { createdAt: Date; addresses: string[] }
  >(
    `SELECT c.id,c.name,c.email,c.phone,c.address,c.created_at AS "createdAt",
       (SELECT count(*)::int FROM jobs j WHERE j.tenant_id=c.tenant_id AND j.customer_id=c.id) AS "jobCount",
       array_remove(array_append(coalesce((SELECT array_agg(concat_ws(' ', p.address_line1, p.suburb, p.city))
         FROM properties p WHERE p.tenant_id=c.tenant_id AND p.customer_id=c.id AND p.archived_at IS NULL), '{}'), c.address), NULL) AS addresses
     FROM customers c WHERE c.tenant_id=$1 AND c.archived_at IS NULL ORDER BY c.created_at, c.id`,
    [tenantId],
  );
  const dismissed = await client.query<{ customer_a: string; customer_b: string }>(
    'SELECT customer_a,customer_b FROM customer_duplicate_dismissals WHERE tenant_id=$1',
    [tenantId],
  );
  const skip = new Set(dismissed.rows.map((row) => `${row.customer_a}:${row.customer_b}`));
  const byId = new Map(customers.rows.map((row) => [row.id, row]));
  const dto = (id: string): DuplicateCustomer => {
    const row = byId.get(id)!;
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      address: row.address,
      jobCount: row.jobCount,
      createdAt: iso(row.createdAt)!,
    };
  };
  return findDuplicateCandidates(customers.rows)
    .filter((pair) => !skip.has(`${pair.a}:${pair.b}`))
    .slice(0, 100)
    .map((pair) => ({
      score: pair.score,
      reasons: pair.reasons,
      customers: [dto(pair.a), dto(pair.b)],
    }));
}

export async function dismissDuplicate(
  client: Transaction,
  user: UserContext,
  first: string,
  second: string,
): Promise<{ dismissed: true; customerIds: [string, string] }> {
  if (first === second)
    throw new HttpError(422, 'SAME_CUSTOMER', 'Choose two different customers.');
  const [a, b] = first < second ? [first, second] : [second, first];
  const found = await client.query(
    'SELECT id FROM customers WHERE tenant_id=$1 AND id = ANY($2::uuid[])',
    [user.tenantId, [a, b]],
  );
  if (found.rowCount !== 2) throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
  await client.query(
    `INSERT INTO customer_duplicate_dismissals(tenant_id,customer_a,customer_b,dismissed_by)
     VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [user.tenantId, a, b, user.id],
  );
  return { dismissed: true, customerIds: [a, b] };
}

// ------------------------------------------------------------------ merge

/** Tables whose (tenant_id, X) column references customers, found from the catalogue. */
export async function customerReferenceColumns(
  client: Queryable,
): Promise<{ table: string; column: string }[]> {
  const result = await client.query<{ table: string; column: string }>(
    `SELECT cl.relname AS "table", a.attname AS "column"
     FROM pg_constraint con
     JOIN pg_class cl ON cl.oid = con.conrelid
     JOIN LATERAL unnest(con.conkey) AS k(attnum) ON true
     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
     WHERE con.contype = 'f' AND con.confrelid = 'customers'::regclass AND a.attname <> 'tenant_id'
     ORDER BY 1, 2`,
  );
  return result.rows;
}

/** Handled specially by the merge (or the customer row itself). */
const SPECIAL_REFERENCES = new Set([
  'customers.merged_into_id',
  'customer_tags.customer_id',
  'customer_duplicate_dismissals.customer_a',
  'customer_duplicate_dismissals.customer_b',
  'properties.customer_id',
]);

interface MergeCustomerRow {
  id: string;
  name: string;
  archived: boolean;
  erased: boolean;
  mergedIntoId: string | null;
}

async function loadMergePair(
  client: Queryable,
  tenantId: string,
  sourceId: string,
  intoId: string,
  lock: boolean,
) {
  const rows = await client.query<MergeCustomerRow>(
    `SELECT id,name,(archived_at IS NOT NULL) AS archived,(erased_at IS NOT NULL) AS erased,merged_into_id AS "mergedIntoId"
     FROM customers WHERE tenant_id=$1 AND id = ANY($2::uuid[]) ORDER BY id ${lock ? 'FOR UPDATE' : ''}`,
    [tenantId, [sourceId, intoId]],
  );
  const source = rows.rows.find((row) => row.id === sourceId);
  const into = rows.rows.find((row) => row.id === intoId);
  if (!source || !into) throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
  if (sourceId === intoId)
    throw new HttpError(422, 'MERGE_INTO_SELF', 'A customer cannot be merged into itself.');
  if (into.archived || into.erased || into.mergedIntoId)
    throw new HttpError(
      422,
      'MERGE_TARGET_INVALID',
      'The surviving customer must be active (not archived, erased or merged).',
    );
  if (source.erased)
    throw new HttpError(422, 'MERGE_SOURCE_ERASED', 'An erased customer cannot be merged.');
  if (source.mergedIntoId && source.mergedIntoId !== intoId)
    throw new HttpError(
      409,
      'ALREADY_MERGED',
      'This customer was already merged into someone else.',
    );
  return { source, into };
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

export interface MergePreview {
  source: { id: string; name: string };
  into: { id: string; name: string };
  alreadyMerged: boolean;
  /** Rows that will point at the surviving customer, by table. */
  moves: Record<string, number>;
  duplicatePropertiesArchived: number;
  warnings: { code: string; message: string }[];
}

export async function mergePreview(
  client: Queryable,
  tenantId: string,
  sourceId: string,
  intoId: string,
): Promise<MergePreview> {
  const { source, into } = await loadMergePair(client, tenantId, sourceId, intoId, false);
  const moves: Record<string, number> = {};
  for (const ref of await customerReferenceColumns(client)) {
    if (ref.table === 'customers' || ref.table === 'customer_duplicate_dismissals') continue;
    const count = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${quoteIdent(ref.table)} WHERE tenant_id=$1 AND ${quoteIdent(ref.column)}=$2`,
      [tenantId, sourceId],
    );
    const n = count.rows[0]!.n;
    if (n) moves[ref.table] = (moves[ref.table] ?? 0) + n;
  }
  const duplicates = await duplicateProperties(client, tenantId, sourceId, intoId);
  const warnings: MergePreview['warnings'] = [];
  const xero = await client.query<{ provider: string; entity_id: string }>(
    `SELECT provider, entity_id FROM external_references
     WHERE tenant_id=$1 AND entity_type='contact' AND entity_id = ANY($2::uuid[])`,
    [tenantId, [sourceId, intoId]],
  );
  if (xero.rows.some((row) => row.entity_id === sourceId))
    warnings.push({
      code: 'ACCOUNTING_CONTACT_NOT_MERGED',
      message:
        'This customer has a contact in your accounting system. OPENTRADIE keeps that link for invoices already posted, but does not merge contacts in the accounting system: merge them there yourself.',
    });
  const posted = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM invoices WHERE tenant_id=$1 AND customer_id=$2 AND external_invoice_id IS NOT NULL`,
    [tenantId, sourceId],
  );
  if (posted.rows[0]!.n)
    warnings.push({
      code: 'POSTED_INVOICES',
      message: `${posted.rows[0]!.n} invoice(s) were already posted to accounting under the old contact; they stay there unchanged.`,
    });
  return {
    source: { id: source.id, name: source.name },
    into: { id: into.id, name: into.name },
    alreadyMerged: source.mergedIntoId === intoId,
    moves,
    duplicatePropertiesArchived: duplicates.length,
    warnings,
  };
}

/** Source properties whose address matches an active property of the survivor. */
async function duplicateProperties(
  client: Queryable,
  tenantId: string,
  sourceId: string,
  intoId: string,
): Promise<{ from: string; to: string }[]> {
  const rows = await client.query<{ id: string; customerId: string; address: string }>(
    `SELECT id, customer_id AS "customerId", concat_ws(' ', address_line1, address_line2, suburb, city, postcode) AS address
     FROM properties WHERE tenant_id=$1 AND customer_id = ANY($2::uuid[]) AND archived_at IS NULL ORDER BY created_at, id`,
    [tenantId, [sourceId, intoId]],
  );
  const survivor = new Map<string, string>();
  for (const row of rows.rows)
    if (row.customerId === intoId && !survivor.has(normaliseAddress(row.address)))
      survivor.set(normaliseAddress(row.address), row.id);
  return rows.rows
    .filter((row) => row.customerId === sourceId && survivor.has(normaliseAddress(row.address)))
    .map((row) => ({ from: row.id, to: survivor.get(normaliseAddress(row.address))! }));
}

/**
 * Merge `sourceId` into `intoId` in the caller's transaction. Every row that references the
 * merged customer moves to the survivor (found from the catalogue, so new tables are covered);
 * identical property addresses are de-duplicated; tags are unioned. The merged customer stays,
 * archived, with merged_into_id set. Append-only rows (job_events, audit_events) keep the old id.
 */
export async function mergeCustomers(
  client: Transaction,
  user: UserContext,
  sourceId: string,
  intoId: string,
  confirm: string,
  requestId: string,
) {
  const tenantId = user.tenantId;
  const { source, into } = await loadMergePair(client, tenantId, sourceId, intoId, true);
  if (source.mergedIntoId === intoId)
    return { merged: true, alreadyMerged: true, sourceId, intoId, moves: {} };
  const wanted = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-NZ');
  if (wanted(confirm) !== wanted(into.name))
    throw new HttpError(
      422,
      'CONFIRMATION_MISMATCH',
      'Type the surviving customer’s name exactly to confirm the merge.',
    );
  const moves: Record<string, number> = {};
  const params = [tenantId, sourceId, intoId];

  // Properties: duplicates collapse onto the survivor's property; the copy is archived.
  const duplicates = await duplicateProperties(client, tenantId, sourceId, intoId);
  const propertyRefs = await client.query<{ table: string; column: string }>(
    `SELECT cl.relname AS "table", a.attname AS "column"
     FROM pg_constraint con
     JOIN pg_class cl ON cl.oid = con.conrelid
     JOIN LATERAL unnest(con.conkey) AS k(attnum) ON true
     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
     WHERE con.contype = 'f' AND con.confrelid = 'properties'::regclass AND a.attname <> 'tenant_id'`,
  );
  for (const duplicate of duplicates) {
    for (const ref of propertyRefs.rows)
      await client.query(
        `UPDATE ${quoteIdent(ref.table)} SET ${quoteIdent(ref.column)}=$3 WHERE tenant_id=$1 AND ${quoteIdent(ref.column)}=$2`,
        [tenantId, duplicate.from, duplicate.to],
      );
    await client.query(
      'UPDATE properties SET archived_at=coalesce(archived_at, now()), updated_at=now() WHERE tenant_id=$1 AND id=$2',
      [tenantId, duplicate.from],
    );
  }
  const properties = await client.query(
    'UPDATE properties SET customer_id=$3, updated_at=now() WHERE tenant_id=$1 AND customer_id=$2',
    params,
  );
  if (properties.rowCount) moves.properties = properties.rowCount;

  // Tags: union onto the survivor.
  await client.query(
    `INSERT INTO customer_tags(tenant_id,customer_id,tag_id)
     SELECT tenant_id,$3,tag_id FROM customer_tags WHERE tenant_id=$1 AND customer_id=$2
     ON CONFLICT DO NOTHING`,
    params,
  );
  const tags = await client.query(
    'DELETE FROM customer_tags WHERE tenant_id=$1 AND customer_id=$2',
    params.slice(0, 2),
  );
  if (tags.rowCount) moves.customer_tags = tags.rowCount;
  await client.query(
    'DELETE FROM customer_duplicate_dismissals WHERE tenant_id=$1 AND (customer_a=$2 OR customer_b=$2)',
    params.slice(0, 2),
  );

  // Everything else that references the customer.
  for (const ref of await customerReferenceColumns(client)) {
    if (SPECIAL_REFERENCES.has(`${ref.table}.${ref.column}`)) continue;
    const updated = await client.query(
      `UPDATE ${quoteIdent(ref.table)} SET ${quoteIdent(ref.column)}=$3 WHERE tenant_id=$1 AND ${quoteIdent(ref.column)}=$2`,
      params,
    );
    if (updated.rowCount) moves[ref.table] = (moves[ref.table] ?? 0) + updated.rowCount;
  }
  // Merged customers that pointed at the source now point at the survivor (no chains).
  await client.query(
    'UPDATE customers SET merged_into_id=$3, updated_at=now() WHERE tenant_id=$1 AND merged_into_id=$2',
    params,
  );
  await client.query(
    `UPDATE customers SET merged_into_id=$3, archived_at=coalesce(archived_at, now()), updated_at=now()
     WHERE tenant_id=$1 AND id=$2`,
    params,
  );
  // Identifiers and counts only.
  for (const [entityId, role] of [
    [sourceId, 'merged'],
    [intoId, 'survivor'],
  ] as const)
    await recordAudit(client, {
      tenantId,
      actorType: 'user',
      actorId: user.id,
      action: 'customer.merged',
      entityType: 'customer',
      entityId,
      requestId,
      metadata: {
        role,
        sourceId,
        intoId,
        moves,
        duplicatePropertiesArchived: duplicates.length,
      },
    });
  return { merged: true, alreadyMerged: false, sourceId, intoId, moves };
}

// ------------------------------------------------------------------ reports

/** Report inputs read from the database; the maths is in packages/core/src/crm.ts. */
export async function customerReport(client: Queryable, tenantId: string, range: DateRange) {
  const [customers, jobs, quotes, invoices] = await Promise.all([
    client.query<{ id: string; name: string; createdAt: string }>(
      `SELECT id,name,to_char(created_at,'YYYY-MM-DD') AS "createdAt" FROM customers
       WHERE tenant_id=$1 AND merged_into_id IS NULL AND erased_at IS NULL`,
      [tenantId],
    ),
    // Job dates are local to the business time zone.
    client.query<{ customerId: string; date: string }>(
      `SELECT j.customer_id AS "customerId", to_char(j.created_at AT TIME ZONE b.time_zone,'YYYY-MM-DD') AS date
       FROM jobs j JOIN businesses b ON b.id=j.tenant_id WHERE j.tenant_id=$1 AND j.status <> 'cancelled'`,
      [tenantId],
    ),
    client.query<{ customerId: string; status: string; sentDate: string | null }>(
      `SELECT q.customer_id AS "customerId", q.status,
         to_char(q.sent_at AT TIME ZONE b.time_zone,'YYYY-MM-DD') AS "sentDate"
       FROM quotes q JOIN businesses b ON b.id=q.tenant_id WHERE q.tenant_id=$1 AND q.sent_at IS NOT NULL`,
      [tenantId],
    ),
    // Paid amount: the latest payment snapshot; a `paid` invoice without one counts as paid in full.
    client.query<{
      customerId: string;
      status: string;
      issueDate: string;
      subtotalCents: string;
      taxCents: string;
      totalCents: string;
      paidCents: string | null;
      paidDate: string | null;
    }>(
      `SELECT i.customer_id AS "customerId", i.status, to_char(i.issue_date,'YYYY-MM-DD') AS "issueDate",
         i.subtotal_cents AS "subtotalCents", i.tax_cents AS "taxCents", i.total_cents AS "totalCents",
         (SELECT ps.amount_paid_cents FROM payment_snapshots ps WHERE ps.tenant_id=i.tenant_id AND ps.invoice_id=i.id
          ORDER BY ps.fetched_at DESC, ps.id DESC LIMIT 1) AS "paidCents",
         (SELECT to_char(min(ps.fetched_at) AT TIME ZONE b.time_zone,'YYYY-MM-DD') FROM payment_snapshots ps
          WHERE ps.tenant_id=i.tenant_id AND ps.invoice_id=i.id AND ps.amount_due_cents <= 0) AS "paidDate"
       FROM invoices i JOIN businesses b ON b.id=i.tenant_id WHERE i.tenant_id=$1`,
      [tenantId],
    ),
  ]);
  return computeCustomerReport({
    range,
    customers: customers.rows,
    jobs: jobs.rows,
    quotes: quotes.rows,
    invoices: invoices.rows.map((row) => {
      const total = Number(row.totalCents);
      const paid =
        row.paidCents !== null ? Number(row.paidCents) : row.status === 'paid' ? total : 0;
      return {
        customerId: row.customerId,
        status: row.status,
        issueDate: row.issueDate,
        subtotalCents: Number(row.subtotalCents),
        taxCents: Number(row.taxCents),
        totalCents: total,
        paidCents: paid,
        paidDate: row.paidDate,
      };
    }),
  });
}
