import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg, { type PoolClient } from 'pg';
import * as schema from './schema.js';

const scrypt = promisify(scryptCallback);
export { schema };
export function createDatabase(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5_000 });
  return { pool, orm: drizzle(pool, { schema }) };
}
export type Database = ReturnType<typeof createDatabase>;
export type Transaction = PoolClient;
export async function transaction<T>(db: Database, work: (client: Transaction) => Promise<T>): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Checksummed, transactional migration history is shared across all deployment profiles. */
export async function migrate(db: Database): Promise<void> {
  const { createHash } = await import('node:crypto');
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  await transaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('opentradie:migrations'))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of files) {
      const sql = await readFile(`${directory}/${name}`, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const applied = await client.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (applied.rows[0]) {
        if (applied.rows[0].checksum !== checksum) throw new Error(`Applied migration was modified: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
    }
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error('Passwords must contain at least 12 characters.');
  const salt = randomBytes(16).toString('hex');
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, salt, digest] = stored.split(':');
  if (algorithm !== 'scrypt' || !salt || !digest || !/^[a-f0-9]{128}$/.test(digest)) return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  return timingSafeEqual(actual, Buffer.from(digest, 'hex'));
}

export interface SeedOptions {
  tenantId: string;
  ownerEmail: string;
  ownerPassword: string;
  viewerEmail?: string;
  viewerPassword?: string;
  taxBasisPoints?: number;
}
export async function seed(db: Database, options: SeedOptions): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(options.tenantId)) throw new Error('TENANT_ID must be a UUID.');
  const ownerHash = await hashPassword(options.ownerPassword);
  const viewerHash = options.viewerPassword ? await hashPassword(options.viewerPassword) : undefined;
  await transaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`seed:${options.tenantId}`]);
    const exists = await client.query('SELECT 1 FROM businesses WHERE id=$1', [options.tenantId]);
    if (exists.rowCount) return;
    await client.query('INSERT INTO businesses(id,name,tax_basis_points,demo_data) VALUES($1,$2,$3,true)', [options.tenantId, 'Harbour Electrical · Demo', options.taxBasisPoints ?? 1500]);
    const ownerId = randomUUID();
    await client.query("INSERT INTO users(id,tenant_id,email,password_hash,role) VALUES($1,$2,$3,$4,'owner')", [ownerId, options.tenantId, options.ownerEmail.toLowerCase(), ownerHash]);
    if (options.viewerEmail && viewerHash) {
      await client.query("INSERT INTO users(id,tenant_id,email,password_hash,role) VALUES($1,$2,$3,$4,'viewer')", [randomUUID(), options.tenantId, options.viewerEmail.toLowerCase(), viewerHash]);
    }
    const johnson = randomUUID();
    const patel = randomUUID();
    await client.query('INSERT INTO customers(id,tenant_id,name,email,phone) VALUES($1,$2,$3,$4,$5),($6,$2,$7,$8,$9)', [johnson, options.tenantId, 'Mrs Johnson', 'johnson@example.test', '+64 21 555 0101', patel, 'Sam Patel', 'patel@example.test', '+64 21 555 0102']);
    const jobId = randomUUID();
    await client.query("INSERT INTO jobs(id,tenant_id,customer_id,title,status,notes) VALUES($1,$2,$3,$4,'completed',$5)", [jobId, options.tenantId, johnson, 'Kitchen lighting check', 'Synthetic history: customer prefers a morning visit. Confirm access before scheduling.']);
    await client.query('INSERT INTO job_notes(id,tenant_id,job_id,text) VALUES($1,$2,$3,$4)', [randomUUID(), options.tenantId, jobId, 'Synthetic history: customer prefers a morning visit. Confirm access before scheduling.']);
    await client.query('INSERT INTO approved_rates(id,tenant_id,code,label,unit_price_cents) VALUES($1,$2,$3,$4,$5),($6,$2,$7,$8,$9)', [randomUUID(), options.tenantId, 'power_point', 'Replace standard power point · synthetic sample rate', 8500, randomUUID(), 'labour_hour', 'Labour per hour · synthetic sample rate', 9500]);
    await client.query("INSERT INTO audit_events(id,tenant_id,actor_id,action,request_id,metadata) VALUES($1,$2,$3,'demo.seeded','setup',$4)", [randomUUID(), options.tenantId, ownerId, JSON.stringify({ syntheticData: true, taxBasisPoints: options.taxBasisPoints ?? 1500 })]);
  });
}
