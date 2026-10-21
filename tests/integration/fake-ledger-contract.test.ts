import { FakeAccountingAdapter } from '@opentradie/integrations';
import { PostgresFakeLedger } from '@opentradie/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  describeAccountingContract,
  fakeHarness,
  TENANT,
} from '../../packages/integrations/src/accounting/contract-suite.js';
import { createTestDatabase } from '../helpers/db.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let ledger: PostgresFakeLedger;

beforeAll(async () => {
  database = await createTestDatabase();
  ledger = new PostgresFakeLedger(database.db);
  await database.db.pool.query(
    "INSERT INTO businesses(id,name,trade,tax_basis_points,call_out_rate_code) VALUES($1,'Contract (synthetic)','electrician',1500,'call_out')",
    [TENANT],
  );
});
afterAll(async () => database?.drop());

// The same suite every adapter passes, against the PostgreSQL-backed fake ledger.
describeAccountingContract([
  [
    'FakeAccountingAdapter with PostgreSQL ledger (mock)',
    async () => {
      for (const table of [
        'fake_accounting_idempotency',
        'fake_accounting_payments',
        'fake_accounting_invoices',
        'fake_accounting_contacts',
      ])
        await database.db.pool.query(`DELETE FROM ${table}`);
      return fakeHarness(ledger);
    },
  ],
]);

describe('PostgreSQL fake ledger', () => {
  it('is shared by two adapter instances (two processes) and scoped by tenant', async () => {
    const a = new FakeAccountingAdapter({ ledger });
    const b = new FakeAccountingAdapter({ ledger: new PostgresFakeLedger(database.db) });
    const id = await ledger.nextId('invoice');
    expect(id).toMatch(/^fake-invoice-\d{4,}$/);
    expect(await b.simulateAuthorise(id).catch((e: unknown) => e)).toMatchObject({
      code: 'not_found',
    });
    expect(a.provider).toBe(b.provider);
  });
});
