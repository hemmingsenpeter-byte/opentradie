/**
 * pnpm owner:reset-password --email <email> [--disable-mfa] [--tenant-id <uuid>]
 *
 * Resets a user's password without email (the sole operator's recovery path when no mail
 * connection exists). The new password is never a command-line argument: it is read from
 * NEW_PASSWORD_FILE, or prompted for twice on a terminal without echo. Every session and
 * outstanding reset/MFA token for the user is revoked. Two-factor stays on unless
 * --disable-mfa is passed (use it when the authenticator and recovery codes are lost).
 * Bundled by tsup into dist/scripts/owner-reset-password.js for the production image.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { passwordProblem } from '@opentradie/core';
import { AccountResetError, createDatabase, resetUserPassword } from '@opentradie/database';

const USAGE = `Usage: pnpm owner:reset-password --email <email> [--disable-mfa] [--tenant-id <uuid>]
New password: set NEW_PASSWORD_FILE to a file holding it, or type it when prompted.
`;
const out = (text: string) => process.stdout.write(`${text}\n`);
function fail(message: string, code = 1): never {
  process.stderr.write(`owner:reset-password: ${message}\n`);
  process.exit(code);
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          return reject(new Error('Cancelled.'));
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readNewPassword(): Promise<string> {
  const file = process.env.NEW_PASSWORD_FILE;
  if (file) {
    if (!existsSync(file)) fail('NEW_PASSWORD_FILE does not exist.');
    return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  }
  if (!process.stdin.isTTY)
    fail('No terminal to prompt for the new password. Set NEW_PASSWORD_FILE instead.');
  const first = await promptHidden('New password (at least 12 characters): ');
  const problem = passwordProblem(first);
  if (problem) fail(`${problem} Nothing was changed.`);
  const second = await promptHidden('Type it again: ');
  if (first !== second) fail('The passwords did not match. Nothing was changed.');
  return first;
}

const { values } = (() => {
  try {
    return parseArgs({
      options: {
        email: { type: 'string' },
        'tenant-id': { type: 'string' },
        'disable-mfa': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    });
  } catch (error) {
    // e.g. --password: there is no such option, on purpose.
    return fail(`${(error as Error).message}\n${USAGE}`, 2);
  }
})();
if (values.help) {
  out(USAGE);
  process.exit(0);
}
if (!values.email) fail(`Missing --email.\n${USAGE}`, 2);
if (existsSync('.env')) process.loadEnvFile('.env');
if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set (see .env.example).');
const newPassword = await readNewPassword();
const db = createDatabase(process.env.DATABASE_URL!, { max: 2 });
try {
  const tenantId = values['tenant-id'] ?? process.env.TENANT_ID;
  const result = await resetUserPassword(db, {
    email: values.email!,
    newPassword,
    disableMfa: values['disable-mfa'],
    ...(tenantId ? { tenantId } : {}),
  });
  out(`Password reset for ${values.email!.trim().toLowerCase()}.`);
  out(`  ${result.sessionsRevoked} session(s) signed out.`);
  out(
    result.mfaDisabled ? '  Two-factor sign-in was turned off.' : '  Two-factor sign-in unchanged.',
  );
} catch (error) {
  if (error instanceof AccountResetError) fail(`${error.message} Nothing was changed.`);
  throw error;
} finally {
  await db.close();
}
