import type { Database } from '@opentradie/database';
import type {
  FakeContact,
  FakeInvoice,
  FakeLedgerStore,
  FakePayment,
} from '@opentradie/integrations';

/**
 * DEMO AND TEST ONLY (ADR 0029, migration 0018). PostgreSQL-backed ledger for the fake accounting
 * provider so the API and a separate worker process see one shared "external system". Tenant-scoped.
 * Not a real integration and not business data.
 */
export class PostgresFakeLedger implements FakeLedgerStore {
  constructor(private readonly db: Database) {}

  async nextId(kind: string) {
    const result = await this.db.pool.query<{ n: string }>(
      "SELECT nextval('fake_accounting_seq')::text AS n",
    );
    return `fake-${kind}-${result.rows[0]!.n.padStart(4, '0')}`;
  }

  async getContact(tenantId: string, id: string) {
    const r = await this.db.pool.query<{ data: FakeContact }>(
      'SELECT data FROM fake_accounting_contacts WHERE tenant_id=$1 AND id=$2',
      [tenantId, id],
    );
    return r.rows[0]?.data ?? null;
  }
  async listContacts(tenantId: string) {
    const r = await this.db.pool.query<{ data: FakeContact }>(
      'SELECT data FROM fake_accounting_contacts WHERE tenant_id=$1 ORDER BY id',
      [tenantId],
    );
    return r.rows.map((row) => row.data);
  }
  async putContact(tenantId: string, contact: FakeContact) {
    await this.db.pool.query(
      `INSERT INTO fake_accounting_contacts(tenant_id,id,data) VALUES($1,$2,$3)
       ON CONFLICT (tenant_id,id) DO UPDATE SET data=EXCLUDED.data`,
      [tenantId, contact.id, JSON.stringify(contact)],
    );
  }

  async getInvoice(tenantId: string, id: string) {
    const r = await this.db.pool.query<{ data: FakeInvoice }>(
      'SELECT data FROM fake_accounting_invoices WHERE tenant_id=$1 AND id=$2',
      [tenantId, id],
    );
    return reviveInvoice(r.rows[0]?.data);
  }
  async findInvoice(id: string) {
    const r = await this.db.pool.query<{ data: FakeInvoice }>(
      'SELECT data FROM fake_accounting_invoices WHERE id=$1',
      [id],
    );
    return reviveInvoice(r.rows[0]?.data);
  }
  async listInvoices(tenantId: string) {
    const r = await this.db.pool.query<{ data: FakeInvoice }>(
      'SELECT data FROM fake_accounting_invoices WHERE tenant_id=$1 ORDER BY id',
      [tenantId],
    );
    return r.rows.map((row) => reviveInvoice(row.data)!);
  }
  async putInvoice(invoice: FakeInvoice) {
    await this.db.pool.query(
      `INSERT INTO fake_accounting_invoices(tenant_id,id,data,updated_at) VALUES($1,$2,$3,$4)
       ON CONFLICT (tenant_id,id) DO UPDATE SET data=EXCLUDED.data, updated_at=EXCLUDED.updated_at`,
      [invoice.tenantId, invoice.externalInvoiceId, JSON.stringify(invoice), invoice.updatedAt],
    );
  }

  async listPayments(tenantId: string) {
    const r = await this.db.pool.query<{ data: FakePayment }>(
      'SELECT data FROM fake_accounting_payments WHERE tenant_id=$1 ORDER BY id',
      [tenantId],
    );
    return r.rows.map((row) => ({ ...row.data, updatedAt: new Date(row.data.updatedAt) }));
  }
  async addPayment(payment: FakePayment) {
    await this.db.pool.query(
      `INSERT INTO fake_accounting_payments(tenant_id,id,data,updated_at) VALUES($1,$2,$3,$4)`,
      [payment.tenantId, payment.externalPaymentId, JSON.stringify(payment), payment.updatedAt],
    );
  }

  async getIdempotency(tenantId: string, key: string) {
    const r = await this.db.pool.query<{ fingerprint: string; result: unknown }>(
      'SELECT fingerprint,result FROM fake_accounting_idempotency WHERE tenant_id=$1 AND key=$2',
      [tenantId, key],
    );
    return r.rows[0] ?? null;
  }
  async putIdempotency(
    tenantId: string,
    key: string,
    value: { fingerprint: string; result: unknown },
  ) {
    await this.db.pool.query(
      `INSERT INTO fake_accounting_idempotency(tenant_id,key,fingerprint,result) VALUES($1,$2,$3,$4)
       ON CONFLICT (tenant_id,key) DO NOTHING`,
      [tenantId, key, value.fingerprint, JSON.stringify(value.result)],
    );
  }

  /** Session-level advisory lock on a dedicated connection: serialises across processes. */
  async withLock<T>(tenantId: string, key: string, run: () => Promise<T>): Promise<T> {
    const client = await this.db.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
        `fake_accounting:${tenantId}:${key}`,
      ]);
      try {
        return await run();
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
          `fake_accounting:${tenantId}:${key}`,
        ]);
      }
    } finally {
      client.release();
    }
  }
}

function reviveInvoice(invoice: FakeInvoice | undefined): FakeInvoice | null {
  return invoice ? { ...invoice, updatedAt: new Date(invoice.updatedAt) } : null;
}
