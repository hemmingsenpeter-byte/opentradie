import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transaction, type Database } from './db.js';

export const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
  requiresExtension: string | null;
}

async function readMigrations(directory = migrationsDirectory): Promise<MigrationFile[]> {
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(`${directory}/${name}`, 'utf8');
      return {
        name,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
        requiresExtension: /^-- requires-extension: ([a-z0-9_]+)$/m.exec(sql)?.[1] ?? null,
      };
    }),
  );
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
  /** Optional migrations whose extension is not installed on this server. */
  pendingOptional: Array<{ name: string; extension: string }>;
}

/**
 * Checksummed, transactional migrations shared by every deployment profile. Safe to run
 * concurrently (advisory lock) and repeatedly (applied files are skipped, edited files refused).
 */
export async function migrate(
  db: Database,
  directory = migrationsDirectory,
): Promise<MigrationResult> {
  const files = await readMigrations(directory);
  const result: MigrationResult = { applied: [], alreadyApplied: [], pendingOptional: [] };
  await transaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('opentradie:migrations'))");
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const file of files) {
      const applied = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE name=$1',
        [file.name],
      );
      if (applied.rows[0]) {
        if (applied.rows[0].checksum !== file.checksum)
          throw new Error(`Applied migration was modified: ${file.name}`);
        result.alreadyApplied.push(file.name);
        continue;
      }
      if (file.requiresExtension) {
        const available = await client.query(
          'SELECT 1 FROM pg_available_extensions WHERE name=$1',
          [file.requiresExtension],
        );
        if (!available.rowCount) {
          result.pendingOptional.push({ name: file.name, extension: file.requiresExtension });
          continue;
        }
      }
      await client.query(file.sql);
      await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [
        file.name,
        file.checksum,
      ]);
      result.applied.push(file.name);
    }
  });
  return result;
}

export interface DatabaseStatus {
  status: 'ok' | 'unavailable';
  appliedMigrations: number;
  pendingMigrations: string[];
  pgvector: 'enabled' | 'not_installed';
}

export async function databaseStatus(
  db: Database,
  directory = migrationsDirectory,
): Promise<DatabaseStatus> {
  try {
    const files = await readMigrations(directory);
    const applied = await db.pool.query<{ name: string }>('SELECT name FROM schema_migrations');
    const names = new Set(applied.rows.map((row) => row.name));
    const vector = await db.pool.query("SELECT 1 FROM pg_extension WHERE extname='vector'");
    return {
      status: 'ok',
      appliedMigrations: names.size,
      pendingMigrations: files.filter((file) => !names.has(file.name)).map((file) => file.name),
      pgvector: vector.rowCount ? 'enabled' : 'not_installed',
    };
  } catch {
    return {
      status: 'unavailable',
      appliedMigrations: 0,
      pendingMigrations: [],
      pgvector: 'not_installed',
    };
  }
}
