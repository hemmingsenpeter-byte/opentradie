import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { databaseStatus, migrate, migrationsDirectory } from '@opentradie/database';
import { createTestDatabase } from '../helpers/db.js';

let drop: (() => Promise<void>) | undefined;
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
    ]) {
      expect(names, entity).toContain(entity);
    }
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
    // Hold back 0004 and every later migration (later files may depend on 0004's tables).
    const held = (await readdir(directory)).filter((name) => name >= '0004_');
    const upgrades = await Promise.all(
      held.map(async (name) => [name, await readFile(join(directory, name), 'utf8')] as const),
    );
    for (const name of held) await rm(join(directory, name));
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
    for (const [name, sql] of upgrades) await writeFile(join(directory, name), sql);
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
