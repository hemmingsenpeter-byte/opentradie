/**
 * pnpm setup:dev
 *
 * Creates a local .env from .env.example with freshly generated random secrets.
 * Refuses to overwrite an existing .env. Demo passwords are printed once, here,
 * and are not stored anywhere except the new .env file (mode 0600).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const examplePath = resolve(root, '.env.example');
const envPath = resolve(root, '.env');

function fail(message: string): never {
  console.error(`setup:dev: ${message}`);
  process.exit(1);
}

if (existsSync(envPath)) {
  fail(
    '.env already exists; refusing to overwrite it. Move it aside (or delete it deliberately) and re-run.',
  );
}
if (!existsSync(examplePath)) fail('.env.example is missing.');

const password = () => randomBytes(18).toString('base64url');
const generated = {
  SESSION_SECRET: randomBytes(48).toString('base64url'),
  CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  POSTGRES_PASSWORD: randomBytes(18).toString('hex'),
  OWNER_PASSWORD: password(),
  VIEWER_PASSWORD: password(),
};

const values: Record<string, string> = { ...generated };
let text = readFileSync(examplePath, 'utf8');

for (const [key, value] of Object.entries(values)) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (!pattern.test(text)) fail(`.env.example has no ${key}= line; update scripts/setup.ts.`);
  text = text.replace(pattern, () => `${key}=${value}`);
}

// Keep DATABASE_URL consistent with the generated Postgres password.
text = text.replace(/^DATABASE_URL=.*$/m, (line) => {
  try {
    const url = new URL(line.slice('DATABASE_URL='.length));
    url.password = generated.POSTGRES_PASSWORD;
    return `DATABASE_URL=${url.toString()}`;
  } catch {
    return line;
  }
});

writeFileSync(envPath, text, { mode: 0o600, flag: 'wx' });

const emailOf = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1] ?? '(see .env)';

console.log('Created .env (mode 0600). It is git-ignored; never commit it.');
console.log('');
console.log('Demo accounts (passwords are shown ONCE; they are also stored in .env):');
console.log(`  owner  ${emailOf('OWNER_EMAIL')}   ${generated.OWNER_PASSWORD}`);
console.log(`  viewer ${emailOf('VIEWER_EMAIL')}  ${generated.VIEWER_PASSWORD}`);
console.log('');
console.log('Next: start PostgreSQL (see docs/DEPLOYMENT.md), then');
console.log('  pnpm db:migrate && pnpm db:seed && pnpm dev');
