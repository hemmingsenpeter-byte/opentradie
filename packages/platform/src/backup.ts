import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import pg from 'pg';

const run = promisify(execFile);

export interface TableChecksum {
  rows: number;
  sha256: string;
}
export type DatabaseFingerprint = Record<string, TableChecksum>;

interface TableInfo {
  name: string;
  primaryKey: string[];
  insertColumns: string[];
  serialColumns: string[];
}

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

async function withClient<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("SET TIME ZONE 'UTC'");
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Public tables in foreign-key order (parents first). */
async function listTables(client: pg.Client): Promise<TableInfo[]> {
  const tables = await client.query<{ name: string }>("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const dependencies = await client.query<{ child: string; parent: string }>(
    `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
     FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
     WHERE c.contype='f' AND n.nspname='public' AND c.conrelid <> c.confrelid`,
  );
  const columns = await client.query<{ table_name: string; column_name: string; is_generated: string; column_default: string | null }>(
    "SELECT table_name, column_name, is_generated, column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position",
  );
  const keys = await client.query<{ table_name: string; column_name: string }>(
    `SELECT t.relname AS table_name, a.attname AS column_name
     FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
     JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, position) ON true
     JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
     WHERE i.indisprimary AND n.nspname='public' ORDER BY t.relname, k.position`,
  );
  const names = tables.rows.map((row) => row.name);
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visit = (name: string) => {
    if (ordered.includes(name) || visiting.has(name)) return;
    visiting.add(name);
    for (const dependency of dependencies.rows.filter((row) => row.child === name)) visit(dependency.parent);
    visiting.delete(name);
    ordered.push(name);
  };
  names.forEach(visit);
  return ordered.map((name) => {
    const own = columns.rows.filter((column) => column.table_name === name);
    const primaryKey = keys.rows.filter((key) => key.table_name === name).map((key) => key.column_name);
    if (primaryKey.length === 0) throw new Error(`Table ${name} has no primary key; backups require deterministic row order.`);
    return {
      name,
      primaryKey,
      insertColumns: own.filter((column) => column.is_generated !== 'ALWAYS').map((column) => column.column_name),
      serialColumns: own.filter((column) => column.column_default?.startsWith('nextval(')).map((column) => column.column_name),
    };
  });
}

/** Row count and SHA-256 over every row in primary-key order, computed inside Postgres. */
export async function fingerprintDatabase(url: string): Promise<DatabaseFingerprint> {
  return withClient(url, async (client) => {
    const result: DatabaseFingerprint = {};
    for (const table of await listTables(client)) {
      const order = table.primaryKey.map(quote).join(', ');
      const row = await client.query<{ rows: number; sha256: string }>(
        `SELECT count(*)::integer AS rows,
           encode(sha256(convert_to(coalesce(string_agg(row_to_json(t)::text, E'\\n' ORDER BY ${order}), ''), 'UTF8')), 'hex') AS sha256
         FROM ${quote(table.name)} t`,
      );
      result[table.name] = row.rows[0]!;
    }
    return result;
  });
}

interface LogicalBackup {
  format: 'opentradie-logical-v1';
  createdAt: string;
  migrations: Array<{ name: string; checksum: string }>;
  fingerprint: DatabaseFingerprint;
  /** Each table as the JSON text Postgres produced; never re-parsed in JavaScript, so no precision loss. */
  tables: Array<{ name: string; json: string }>;
}

const MAGIC = Buffer.from('OTBK1');

function seal(data: Buffer, key: Buffer | null): Buffer {
  if (!key) return data;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

function unseal(data: Buffer, key: Buffer | null): Buffer {
  if (!data.subarray(0, MAGIC.length).equals(MAGIC)) return data;
  if (!key) throw new Error('Backup is encrypted; provide the backup encryption key.');
  const iv = data.subarray(5, 17);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(data.subarray(17, 33));
  return Buffer.concat([decipher.update(data.subarray(33)), decipher.final()]);
}

/**
 * Logical backup: works anywhere the app can connect (no server binaries needed). The file is
 * gzip-compressed and, when a key is supplied, AES-256-GCM encrypted.
 */
export async function createLogicalBackup(url: string, file: string, options: { encryptionKey?: Buffer } = {}): Promise<{ fingerprint: DatabaseFingerprint; sha256: string }> {
  const backup = await withClient(url, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = await listTables(client);
    const exported: LogicalBackup['tables'] = [];
    for (const table of tables) {
      const order = table.primaryKey.map(quote).join(', ');
      const result = await client.query<{ json: string }>(`SELECT coalesce(json_agg(t ORDER BY ${order}), '[]'::json)::text AS json FROM ${quote(table.name)} t`);
      exported.push({ name: table.name, json: result.rows[0]!.json });
    }
    const migrations = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations ORDER BY name');
    await client.query('COMMIT');
    return { tables: exported, migrations: migrations.rows };
  });
  const fingerprint = await fingerprintDatabase(url);
  const document: LogicalBackup = { format: 'opentradie-logical-v1', createdAt: new Date().toISOString(), fingerprint, ...backup };
  const bytes = seal(gzipSync(Buffer.from(JSON.stringify(document))), options.encryptionKey ?? null);
  await writeFile(file, bytes, { mode: 0o600 });
  return { fingerprint, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Restore into an EMPTY database whose schema was created by the same migrations. Refuses a
 * migration mismatch, then verifies the restored fingerprint equals the one recorded at backup.
 */
export async function restoreLogicalBackup(url: string, file: string, options: { encryptionKey?: Buffer } = {}): Promise<DatabaseFingerprint> {
  const document = JSON.parse(gunzipSync(unseal(await readFile(file), options.encryptionKey ?? null)).toString('utf8')) as LogicalBackup;
  if (document.format !== 'opentradie-logical-v1') throw new Error('Unsupported backup format.');
  await withClient(url, async (client) => {
    const migrations = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations ORDER BY name');
    if (JSON.stringify(migrations.rows) !== JSON.stringify(document.migrations)) {
      throw new Error('Target schema version differs from the backup. Apply the same migrations before restoring.');
    }
    const tables = await listTables(client);
    await client.query('BEGIN');
    try {
      for (const table of tables) {
        if (table.name === 'schema_migrations') continue;
        const existing = await client.query(`SELECT 1 FROM ${quote(table.name)} LIMIT 1`);
        if (existing.rowCount) throw new Error(`Restore target is not empty (${table.name}).`);
        const data = document.tables.find((entry) => entry.name === table.name);
        if (!data) continue;
        const columns = table.insertColumns.map(quote).join(', ');
        await client.query(`INSERT INTO ${quote(table.name)} (${columns}) SELECT ${columns} FROM json_populate_recordset(NULL::${quote(table.name)}, $1::json)`, [data.json]);
        for (const column of table.serialColumns) {
          await client.query(
            `SELECT setval(pg_get_serial_sequence($1, $2), coalesce((SELECT max(${quote(column)}) FROM ${quote(table.name)}), 0) + 1, false)`,
            [table.name, column],
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  const restored = await fingerprintDatabase(url);
  assertFingerprintsEqual(document.fingerprint, restored);
  return restored;
}

export function assertFingerprintsEqual(expected: DatabaseFingerprint, actual: DatabaseFingerprint): void {
  const tables = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const mismatches = [...tables].filter((table) => JSON.stringify(expected[table]) !== JSON.stringify(actual[table]));
  if (mismatches.length) throw new Error(`Restored data does not match the backup: ${mismatches.join(', ')}.`);
}

/** pg_dump/pg_restore custom-format backup, used when client binaries matching the server are on PATH. */
export async function pgDumpAvailable(url: string): Promise<{ available: boolean; reason: string }> {
  try {
    const { stdout } = await run('pg_dump', ['--version']);
    const clientMajor = Number(/(\d+)(?:\.\d+)?/.exec(stdout)?.[1]);
    await run('pg_restore', ['--version']);
    const serverMajor = await withClient(url, async (client) => Math.floor(Number((await client.query<{ v: string }>('SHOW server_version_num')).rows[0]!.v) / 10_000));
    if (clientMajor < serverMajor) return { available: false, reason: `pg_dump ${clientMajor} is older than server ${serverMajor}.` };
    return { available: true, reason: `pg_dump ${clientMajor} for server ${serverMajor}.` };
  } catch {
    return { available: false, reason: 'pg_dump/pg_restore are not on PATH.' };
  }
}

/** Keep the password out of the process list: pass it through PGPASSWORD instead of argv. */
function clientArgs(url: string): { dbname: string; env: NodeJS.ProcessEnv } {
  const parsed = new URL(url);
  const password = decodeURIComponent(parsed.password);
  parsed.password = '';
  return { dbname: parsed.toString(), env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) } };
}

export async function createPgDumpBackup(url: string, file: string): Promise<void> {
  const { dbname, env } = clientArgs(url);
  await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', file, '--dbname', dbname], { env });
}

export async function restorePgDumpBackup(url: string, file: string): Promise<void> {
  const { dbname, env } = clientArgs(url);
  await run('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', dbname, file], { env });
}
