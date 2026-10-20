import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, inject, it } from 'vitest';
import {
  COMMUNICATION_ORIGINS,
  COMMUNICATION_STATUSES,
  databaseStatus,
  JOB_EVENT_TYPES,
  JOB_ORIGINS,
  migrate,
  migrationsDirectory,
} from '@opentradie/database';
import { createTestDatabase } from '../helpers/db.js';

let drop: (() => Promise<void>) | undefined;

/** Removes `from` and every later migration (they may depend on it); returns a restore function. */
async function holdBack(directory: string, from: string): Promise<() => Promise<void>> {
  const held = (await readdir(directory)).filter((name) => name >= from);
  const saved = await Promise.all(
    held.map(async (name) => [name, await readFile(join(directory, name), 'utf8')] as const),
  );
  for (const name of held) await rm(join(directory, name));
  return async () => {
    for (const [name, sql] of saved) await writeFile(join(directory, name), sql);
  };
}
afterEach(async () => {
  await drop?.();
  drop = undefined;
});

describe('migration compatibility', () => {
  it('applies cleanly from an empty database and is idempotent', async () => {
    const database = await createTestDatabase({ migrate: false });
    drop = database.drop;
    const first = await migrate(database.db);
    expect(first.applied).toEqual(
      expect.arrayContaining(['0001_foundation.sql', '0002_queue_relay_policy.sql']),
    );
    const second = await migrate(database.db);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(first.applied);
    expect(second.pendingOptional).toEqual(first.pendingOptional);
    const status = await databaseStatus(database.db);
    expect(status.status).toBe('ok');
    const tables = await database.db.pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public'",
    );
    const names = tables.rows.map((row) => row.tablename);
    for (const entity of [
      'businesses',
      'users',
      'customers',
      'customer_contacts',
      'jobs',
      'job_notes',
      'communications',
      'documents',
      'quotes',
      'quote_line_items',
      'approval_requests',
      'provider_connections',
      'audit_events',
      'knowledge_items',
      'scheduled_tasks',
      'agent_sessions',
      'agent_tool_calls',
      'action_proposals',
      'agent_tool_policies',
      'job_time_entries',
      'job_materials',
    ]) {
      expect(names, entity).toContain(entity);
    }
  });

  it('ends with CHECK constraints that allow every value the code writes', async () => {
    // 0004, 0005, 0007, 0008 and 0009 each extend these lists; a later migration must never drop a value.
    const database = await createTestDatabase({ migrate: false });
    drop = database.drop;
    await migrate(database.db);
    const allowed = async (table: string, constraint: string) => {
      const result = await database.db.pool.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid = $1::regclass AND conname = $2`,
        [table, constraint],
      );
      expect(result.rows, `${table}.${constraint}`).toHaveLength(1);
      return [...result.rows[0]!.definition.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    };
    const eventTypes = await allowed('job_events', 'job_events_type_check');
    expect([...eventTypes].sort()).toEqual([...JOB_EVENT_TYPES].sort());
    expect(await allowed('job_events', 'job_events_actor_type_check')).toEqual(
      expect.arrayContaining(['user', 'system', 'agent', 'customer']),
    );
    expect(await allowed('audit_events', 'audit_events_actor_type_check')).toEqual(
      expect.arrayContaining(['user', 'system', 'agent', 'customer']),
    );
    const sorted = (values: readonly (string | undefined)[]) => [...values].sort();
    // 0008 and 0009 both restate the communications status list.
    expect(sorted(await allowed('communications', 'communications_status_check'))).toEqual(
      sorted(COMMUNICATION_STATUSES),
    );
    expect(sorted(await allowed('communications', 'communications_origin_check'))).toEqual(
      sorted(COMMUNICATION_ORIGINS),
    );
    expect(sorted(await allowed('jobs', 'jobs_origin_check'))).toEqual(sorted(JOB_ORIGINS));
  });

  it('applies the pgvector migration where the extension exists and leaves it pending otherwise', async () => {
    const database = await createTestDatabase({ migrate: false });
    drop = database.drop;
    const available =
      (await database.db.pool.query("SELECT 1 FROM pg_available_extensions WHERE name='vector'"))
        .rowCount === 1;
    const result = await migrate(database.db);
    const status = await databaseStatus(database.db);
    if (available) {
      expect(result.applied).toContain('0003_knowledge_embeddings.sql');
      expect(status.pgvector).toBe('enabled');
    } else {
      expect(result.pendingOptional).toEqual([
        { name: '0003_knowledge_embeddings.sql', extension: 'vector' },
      ]);
      expect(status.pgvector).toBe('not_installed');
      expect(status.pendingMigrations).toEqual(['0003_knowledge_embeddings.sql']);
    }
    // The CI service container ships pgvector, so CI always exercises the real migration.
    if (process.env.CI && inject('databaseSource') === 'TEST_DATABASE_URL')
      expect(available).toBe(true);
  });

  it('refuses to run when an applied migration file was edited', async () => {
    const database = await createTestDatabase({ migrate: false });
    drop = database.drop;
    const directory = await mkdtemp(join(tmpdir(), 'opentradie-migrations-'));
    await cp(migrationsDirectory, directory, { recursive: true });
    await migrate(database.db, directory);
    const file = join(directory, '0001_foundation.sql');
    await writeFile(file, `${await readFile(file, 'utf8')}\n-- edited`);
    await expect(migrate(database.db, directory)).rejects.toThrow(/was modified/);
  });

  it('upgrades existing jobs: site addresses become properties and every job gets a timeline', async () => {
    const database = await createTestDatabase({ migrate: false });
    drop = database.drop;
    const directory = await mkdtemp(join(tmpdir(), 'opentradie-migrations-'));
    await cp(migrationsDirectory, directory, { recursive: true });
    const restore = await holdBack(directory, '0004_');
    await migrate(database.db, directory);
    const pool = database.db.pool;
    const tenant = randomUUID();
    const customer = randomUUID();
    const jobs = [randomUUID(), randomUUID(), randomUUID()];
    await pool.query("INSERT INTO businesses(id,name) VALUES($1,'Upgrade test (synthetic)')", [
      tenant,
    ]);
    await pool.query(
      "INSERT INTO customers(id,tenant_id,name) VALUES($1,$2,'Synthetic Customer')",
      [customer, tenant],
    );
    await pool.query(
      `INSERT INTO jobs(id,tenant_id,customer_id,title,status,site_address) VALUES
         ($1,$4,$5,'A','completed','1 Test Street '),($2,$4,$5,'B','new','1 Test Street'),($3,$4,$5,'C','new',NULL)`,
      [...jobs, tenant, customer],
    );
    await pool.query(
      "INSERT INTO job_notes(id,tenant_id,job_id,text) VALUES($1,$2,$3,'Synthetic note')",
      [randomUUID(), tenant, jobs[0]],
    );
    await restore();
    const result = await migrate(database.db, directory);
    expect(result.applied).toContain('0004_crm_job_cards.sql');
    const properties = await pool.query('SELECT id,address_line1 FROM properties');
    expect(properties.rows).toEqual([{ id: expect.any(String), address_line1: '1 Test Street' }]);
    const linked = await pool.query('SELECT title,property_id FROM jobs ORDER BY title');
    expect(linked.rows.map((row) => row.property_id)).toEqual([
      properties.rows[0].id,
      properties.rows[0].id,
      null,
    ]);
    const events = await pool.query(
      'SELECT job_id,type,to_status FROM job_events ORDER BY type, job_id',
    );
    expect(events.rows.filter((row) => row.type === 'created')).toHaveLength(3);
    expect(events.rows.filter((row) => row.type === 'note_added')).toEqual([
      { job_id: jobs[0], type: 'note_added', to_status: null },
    ]);
  });

  it('upgrades existing quotes to 0005: numbers, groups, milli quantities and tax breakdown', async () => {
    const database = await createTestDatabase({ migrate: false });
    drop = database.drop;
    const directory = await mkdtemp(join(tmpdir(), 'opentradie-migrations-'));
    await cp(migrationsDirectory, directory, { recursive: true });
    const restore = await holdBack(directory, '0005_');
    await migrate(database.db, directory);
    const pool = database.db.pool;
    const tenant = randomUUID();
    const customer = randomUUID();
    const job = randomUUID();
    const owner = randomUUID();
    const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
    await pool.query("INSERT INTO businesses(id,name) VALUES($1,'Upgrade test (synthetic)')", [
      tenant,
    ]);
    await pool.query(
      "INSERT INTO users(id,tenant_id,email,display_name,password_hash,role) VALUES($1,$2,'o@example.test','Owner','x','owner')",
      [owner, tenant],
    );
    await pool.query(
      "INSERT INTO customers(id,tenant_id,name) VALUES($1,$2,'Synthetic Customer')",
      [customer, tenant],
    );
    await pool.query("INSERT INTO jobs(id,tenant_id,customer_id,title) VALUES($1,$2,$3,'A')", [
      job,
      tenant,
      customer,
    ]);
    await pool.query(
      "INSERT INTO approved_rates(id,tenant_id,code,label,unit,unit_price_cents) VALUES($1,$2,'labour_hour','Labour','hour',11000),($3,$2,'call_out','Call-out','visit',9500)",
      [randomUUID(), tenant, randomUUID()],
    );
    await pool.query(
      `INSERT INTO quotes(id,tenant_id,customer_id,job_id,status,currency,subtotal_cents,tax_cents,total_cents,tax_basis_points,decided_by,decided_at,created_at)
       VALUES ($1,$4,$5,$6,'approved','NZD',31500,4725,36225,1500,$7,now(),'2026-01-01'),
              ($2,$4,$5,$6,'rejected','NZD',0,0,0,1500,$7,now(),'2026-01-02'),
              ($3,$4,$5,$6,'draft','NZD',0,0,0,1500,NULL,NULL,'2026-01-03')`,
      [first, second, third, tenant, customer, job, owner],
    );
    await pool.query(
      `INSERT INTO quote_line_items(id,tenant_id,quote_id,position,rate_code,description,unit,quantity,unit_price_cents,line_total_cents)
       VALUES ($1,$3,$4,0,'labour_hour','Labour','hour',2,11000,22000),($2,$3,$4,1,'call_out','Call-out','visit',1,9500,9500)`,
      [randomUUID(), randomUUID(), tenant, first],
    );
    await restore();
    const result = await migrate(database.db, directory);
    expect(result.applied).toContain('0005_quotes_gst_acceptance.sql');

    const quotes = await pool.query(
      'SELECT id,quote_number,quote_group_id,revision,decision_source,gst_registered,prices_entered,tax_breakdown FROM quotes ORDER BY created_at',
    );
    expect(quotes.rows.map((row) => row.quote_number)).toEqual(['Q-0001', 'Q-0002', 'Q-0003']);
    expect(quotes.rows.every((row) => row.quote_group_id === row.id && row.revision === 1)).toBe(
      true,
    );
    expect(quotes.rows.map((row) => row.decision_source)).toEqual([null, 'owner', null]);
    expect(quotes.rows[0].tax_breakdown).toEqual([
      {
        taxCode: 'standard',
        rateBasisPoints: 1500,
        netCents: 31500,
        taxCents: 4725,
        grossCents: 36225,
      },
    ]);
    expect(quotes.rows[2].tax_breakdown).toEqual([]);
    const lines = await pool.query(
      'SELECT quantity,quantity_milli,kind,tax_code,price_source,gross_cents,discount_cents,line_total_cents FROM quote_line_items ORDER BY position',
    );
    expect(lines.rows).toEqual([
      {
        quantity: 2,
        quantity_milli: 2000,
        kind: 'labour',
        tax_code: 'standard',
        price_source: 'approved_rate',
        gross_cents: 22000,
        discount_cents: 0,
        line_total_cents: 22000,
      },
      {
        quantity: 1,
        quantity_milli: 1000,
        kind: 'fee',
        tax_code: 'standard',
        price_source: 'approved_rate',
        gross_cents: 9500,
        discount_cents: 0,
        line_total_cents: 9500,
      },
    ]);
    const business = await pool.query(
      'SELECT gst_registered,gst_number,prices_entered,quote_validity_days,next_quote_number FROM businesses WHERE id=$1',
      [tenant],
    );
    expect(business.rows[0]).toEqual({
      gst_registered: true,
      gst_number: null,
      prices_entered: 'exclusive',
      quote_validity_days: 30,
      next_quote_number: 4,
    });
    // The new invariants hold: an owner-entered price must name its owner, totals must match.
    await expect(
      pool.query(
        "INSERT INTO quote_line_items(id,tenant_id,quote_id,position,description,unit,quantity_milli,kind,price_source,unit_price_cents,gross_cents,line_total_cents) VALUES($1,$2,$3,5,'x','each',1000,'fee','owner_entered',100,100,100)",
        [randomUUID(), tenant, third],
      ),
    ).rejects.toThrow(/quote_line_items_owner_source/);
    await expect(
      pool.query(
        "INSERT INTO quote_line_items(id,tenant_id,quote_id,position,description,unit,quantity_milli,kind,price_source,unit_price_cents,gross_cents,line_total_cents,entered_by) VALUES($1,$2,$3,5,'x','each',1500,'fee','owner_entered',333,499,499,$4)",
        [randomUUID(), tenant, third, owner],
      ),
    ).rejects.toThrow(/quote_line_items_gross/);
    await pool.query(
      "INSERT INTO quote_line_items(id,tenant_id,quote_id,position,description,unit,quantity_milli,kind,price_source,unit_price_cents,gross_cents,line_total_cents,entered_by) VALUES($1,$2,$3,5,'x','each',1500,'fee','owner_entered',333,500,500,$4)",
      [randomUUID(), tenant, third, owner],
    );
    await expect(
      pool.query("UPDATE quotes SET status='accepted' WHERE id=$1", [first]),
    ).rejects.toThrow(/quotes_/);
  });

  it('serialises concurrent migration runs', async () => {
    const database = await createTestDatabase({ migrate: false });
    drop = database.drop;
    const results = await Promise.all([
      migrate(database.db),
      migrate(database.db),
      migrate(database.db),
    ]);
    expect(
      results.flatMap((result) => result.applied).filter((name) => name === '0001_foundation.sql'),
    ).toHaveLength(1);
  });
});
