import { cp, mkdtemp, writeFile, readFile } from 'node:fs/promises';
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
