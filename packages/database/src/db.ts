import pg, { type PoolClient } from 'pg';

// int8 columns hold cents and counts. Every value we store is far below 2^53; refuse anything else.
pg.types.setTypeParser(20, (value) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError('Database integer exceeds the safe range.');
  return parsed;
});

export interface Database {
  pool: pg.Pool;
  close(): Promise<void>;
}
export type Queryable = Pick<PoolClient, 'query'>;
export type Transaction = PoolClient;

export function createDatabase(url: string, options: { max?: number } = {}): Database {
  const pool = new pg.Pool({ connectionString: url, max: options.max ?? 10, connectionTimeoutMillis: 5_000 });
  // An idle client error must not crash the process; the next checkout reconnects.
  pool.on('error', () => {});
  return { pool, close: () => pool.end() };
}

export async function transaction<T>(db: Database, work: (client: Transaction) => Promise<T>): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
