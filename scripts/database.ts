import { createDatabase, migrate, seed } from '@opentradie/database';
import { loadDotEnv, requireEnv, startDevDatabaseIfConfigured } from './lib/env.js';

loadDotEnv();
const command = process.argv[2];
if (command !== 'migrate' && command !== 'seed') {
  process.stderr.write('Usage: tsx scripts/database.ts migrate|seed\n');
  process.exit(2);
}

const cluster = await startDevDatabaseIfConfigured();
const { DATABASE_URL } = requireEnv('DATABASE_URL');
const db = createDatabase(DATABASE_URL!);
try {
  if (command === 'migrate') {
    const result = await migrate(db);
    process.stdout.write(
      `Migrations applied: ${result.applied.length ? result.applied.join(', ') : 'none (up to date)'}.\n`,
    );
    for (const pending of result.pendingOptional) {
      process.stdout.write(
        `Optional migration ${pending.name} pending: PostgreSQL extension "${pending.extension}" is not installed. Text search works without it.\n`,
      );
    }
  } else {
    const env = requireEnv('TENANT_ID', 'OWNER_EMAIL', 'OWNER_PASSWORD');
    const result = await seed(db, {
      tenantId: env.TENANT_ID!,
      ownerEmail: env.OWNER_EMAIL!,
      ownerPassword: env.OWNER_PASSWORD!,
      ...(process.env.VIEWER_EMAIL && process.env.VIEWER_PASSWORD
        ? { viewerEmail: process.env.VIEWER_EMAIL, viewerPassword: process.env.VIEWER_PASSWORD }
        : {}),
      taxBasisPoints: Number(process.env.DEMO_TAX_BASIS_POINTS ?? 1500),
    });
    process.stdout.write(
      result.created
        ? 'Synthetic demo business seeded.\n'
        : 'Business already exists; seed left it unchanged.\n',
    );
  }
} finally {
  await db.close();
  await cluster?.stop();
}
