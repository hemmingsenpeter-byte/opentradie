import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createDatabase, migrate, seed } from '@opentradie/database';
import { loadDotEnv, startDevDatabaseIfConfigured } from './lib/env.js';

/**
 * pnpm setup:dev — first-run setup for local development.
 * Creates .env with freshly generated secrets (never overwrites an existing one), creates .data/,
 * starts the embedded development PostgreSQL when no DATABASE_URL server is configured,
 * applies migrations and seeds the synthetic demo business.
 */
const secret = (bytes: number) => randomBytes(bytes).toString('base64url');

if (!existsSync('.env')) {
  const template = await readFile('.env.example', 'utf8');
  const dbPassword = secret(18);
  const values: Record<string, string> = {
    DATABASE_URL: `postgres://opentradie:${dbPassword}@127.0.0.1:54329/opentradie`,
    POSTGRES_PASSWORD: dbPassword,
    DEV_EMBEDDED_POSTGRES: 'true',
    SESSION_SECRET: secret(48),
    OWNER_PASSWORD: secret(18),
    VIEWER_PASSWORD: secret(18),
    CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    RELAY_SHARED_SECRET: secret(32),
  };
  const lines = template.split('\n').map((line) => {
    const match = /^#?\s*([A-Z_]+)=/.exec(line);
    return match && values[match[1]!] !== undefined ? `${match[1]}=${values[match[1]!]}` : line;
  });
  await writeFile('.env', lines.join('\n'), { mode: 0o600 });
  process.stdout.write(
    'Created .env with generated secrets (git-ignored). Edit DATABASE_URL to use your own PostgreSQL server.\n',
  );
} else {
  process.stdout.write('.env already exists; leaving it unchanged.\n');
}
await mkdir('.data/files', { recursive: true, mode: 0o700 });
loadDotEnv();

const cluster = await startDevDatabaseIfConfigured();
const db = createDatabase(process.env.DATABASE_URL!);
try {
  const result = await migrate(db);
  process.stdout.write(
    `Migrations: ${result.applied.length} applied, ${result.alreadyApplied.length} already applied.\n`,
  );
  for (const pending of result.pendingOptional)
    process.stdout.write(
      `Note: ${pending.name} needs the "${pending.extension}" extension (pgvector); semantic search stays off, text search works.\n`,
    );
  const seeded = await seed(db, {
    tenantId: process.env.TENANT_ID!,
    ownerEmail: process.env.OWNER_EMAIL!,
    ownerPassword: process.env.OWNER_PASSWORD!,
    ...(process.env.VIEWER_EMAIL && process.env.VIEWER_PASSWORD
      ? { viewerEmail: process.env.VIEWER_EMAIL, viewerPassword: process.env.VIEWER_PASSWORD }
      : {}),
  });
  process.stdout.write(
    seeded.created ? 'Seeded the synthetic demo business.\n' : 'Demo business already present.\n',
  );
  process.stdout.write(
    `Ready. Run pnpm dev, then sign in as ${process.env.OWNER_EMAIL} (password: OWNER_PASSWORD in .env).\n`,
  );
} finally {
  await db.close();
  await cluster?.stop();
}
