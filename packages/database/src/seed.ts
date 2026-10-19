import { createDatabase, seed } from './index.js';
const { DATABASE_URL, TENANT_ID, OWNER_EMAIL, OWNER_PASSWORD, VIEWER_EMAIL, VIEWER_PASSWORD } = process.env;
if (!DATABASE_URL || !TENANT_ID || !OWNER_EMAIL || !OWNER_PASSWORD) {
  throw new Error('DATABASE_URL, TENANT_ID, OWNER_EMAIL and OWNER_PASSWORD are required.');
}
const db = createDatabase(DATABASE_URL);
try {
  await seed(db, {
    tenantId: TENANT_ID,
    ownerEmail: OWNER_EMAIL,
    ownerPassword: OWNER_PASSWORD,
    ...(VIEWER_EMAIL && VIEWER_PASSWORD ? { viewerEmail: VIEWER_EMAIL, viewerPassword: VIEWER_PASSWORD } : {}),
    taxBasisPoints: Number(process.env.DEMO_TAX_BASIS_POINTS ?? 1500),
  });
  process.stdout.write('Synthetic demo seed ready. Existing tenants are left intact.\n');
} finally {
  await db.pool.end();
}
