import { createDatabase, migrate } from './index.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const db = createDatabase(process.env.DATABASE_URL);
try {
  await migrate(db);
  process.stdout.write('Database migrations applied.\n');
} finally {
  await db.pool.end();
}
