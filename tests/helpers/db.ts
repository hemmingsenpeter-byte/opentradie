import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createDatabase, migrate, type Database } from '@opentradie/database';

export function databaseUrlFor(name: string): string {
  const url = new URL(inject('adminDatabaseUrl'));
  url.pathname = `/${name}`;
  return url.toString();
}

/** A fresh, isolated database per test file (or test). Migrated unless asked otherwise. */
export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<{ db: Database; url: string; name: string; drop(): Promise<void> }> {
  const name = `ot_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: inject('adminDatabaseUrl') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = databaseUrlFor(name);
  const db = createDatabase(url, { max: 5 });
  if (options.migrate !== false) await migrate(db);
  return {
    db,
    url,
    name,
    drop: async () => {
      await db.close();
      const cleanup = new pg.Client({ connectionString: inject('adminDatabaseUrl') });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}
