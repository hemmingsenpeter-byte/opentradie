/**
 * pnpm provision:tenant — set up a real business without touching the database by hand.
 *
 *   pnpm provision:tenant --business "Kauri Electrical Ltd" --trade electrician \
 *     --owner-email owner@example.co.nz --gst-registered yes --gst-number 49-091-850 \
 *     --prices-entered exclusive --rates rates.csv [--tenant-id <uuid>] [--dry-run]
 *
 * In the Docker image: docker run --rm -it --env-file .env -v "$PWD/rates.csv:/rates.csv:ro" \
 *   <image> node dist/scripts/provision-tenant.js --rates /rates.csv ...
 *
 * The owner password is never a command-line argument (it would land in shell history and the
 * process list): it is read from OWNER_PASSWORD_FILE, or prompted for twice on a terminal.
 * This file is bundled by tsup into dist/scripts/provision-tenant.js, so it must not import the
 * development-only helpers in scripts/lib (embedded PostgreSQL).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { formatNzGstNumber, formatRatesCsv, parseRateCardCsv } from '@opentradie/core';
import {
  createDatabase,
  MIN_OWNER_PASSWORD_LENGTH,
  ProvisionError,
  provisionTenant,
  validateProvisionOptions,
  type ProvisionOptions,
} from '@opentradie/database';

const USAGE = `Usage: pnpm provision:tenant --business "<name>" --trade <trade> --owner-email <email>
  --gst-registered yes|no [--gst-number <IRD number>] --prices-entered exclusive|inclusive
  --rates <rates.csv> [--tenant-id <uuid>] [--owner-name "<name>"] [--dry-run] [--allow-alongside-demo]
Owner password: set OWNER_PASSWORD_FILE to a file holding it, or type it when prompted.
`;

const out = (text: string) => process.stdout.write(`${text}\n`);
function fail(message: string, code = 1): never {
  process.stderr.write(`provision:tenant: ${message}\n`);
  process.exit(code);
}

/** Read a line from the terminal without echoing it. */
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

async function readOwnerPassword(): Promise<string> {
  const file = process.env.OWNER_PASSWORD_FILE;
  if (file) {
    if (!existsSync(file)) fail('OWNER_PASSWORD_FILE does not exist.');
    return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  }
  if (!process.stdin.isTTY)
    fail('No terminal to prompt for the owner password. Set OWNER_PASSWORD_FILE instead.');
  const first = await promptHidden(
    `Owner password (at least ${MIN_OWNER_PASSWORD_LENGTH} characters): `,
  );
  if (first.length < MIN_OWNER_PASSWORD_LENGTH)
    fail(`The owner password must be at least ${MIN_OWNER_PASSWORD_LENGTH} characters.`);
  const second = await promptHidden('Type it again: ');
  if (first !== second) fail('The passwords did not match. Nothing was changed.');
  return first;
}

const { values } = (() => {
  try {
    return parseArgs({
      options: {
        business: { type: 'string' },
        trade: { type: 'string' },
        'owner-email': { type: 'string' },
        'owner-name': { type: 'string' },
        'gst-registered': { type: 'string' },
        'gst-number': { type: 'string' },
        'prices-entered': { type: 'string' },
        rates: { type: 'string' },
        'tenant-id': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'allow-alongside-demo': { type: 'boolean', default: false },
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
const missing = ['business', 'trade', 'owner-email', 'gst-registered', 'prices-entered', 'rates']
  .filter((name) => !values[name as keyof typeof values])
  .map((name) => `--${name}`);
if (missing.length) fail(`Missing ${missing.join(', ')}.\n${USAGE}`, 2);
if (!['yes', 'no'].includes(values['gst-registered']!))
  fail('--gst-registered must be yes or no.', 2);
if (!['exclusive', 'inclusive'].includes(values['prices-entered']!))
  fail('--prices-entered must be exclusive or inclusive.', 2);
if (!existsSync(values.rates!)) fail(`Rates file ${values.rates} not found.`);

if (existsSync('.env')) process.loadEnvFile('.env');
const gstRegistered = values['gst-registered'] === 'yes';
const pricesEntered = values['prices-entered'] as 'exclusive' | 'inclusive';
const parsed = parseRateCardCsv(readFileSync(values.rates!, 'utf8'), {
  ...(gstRegistered ? { pricesEntered } : {}),
});
if (parsed.errors.length) {
  for (const error of parsed.errors)
    process.stderr.write(`${values.rates}:${error.line ? error.line : ''} ${error.message}\n`);
  fail(`${parsed.errors.length} problem(s) in the rates file. Nothing was changed.`);
}

let tenantSource = '--tenant-id';
let tenantId = values['tenant-id'];
if (!tenantId && process.env.TENANT_ID) {
  tenantId = process.env.TENANT_ID;
  tenantSource = 'TENANT_ID in the environment';
}
if (!tenantId) {
  tenantId = randomUUID();
  tenantSource = 'generated';
}

const options: ProvisionOptions = {
  tenantId,
  businessName: values.business!,
  trade: values.trade!,
  ownerEmail: values['owner-email']!,
  ...(values['owner-name'] ? { ownerDisplayName: values['owner-name'] } : {}),
  // Placeholder satisfies validation for the dry run; the real password is read below.
  ownerPassword: 'x'.repeat(MIN_OWNER_PASSWORD_LENGTH),
  gstRegistered,
  gstNumber: values['gst-number'] ?? null,
  pricesEntered,
  rates: parsed.rates,
  allowAlongsideDemo: values['allow-alongside-demo'],
  dryRun: values['dry-run'],
};

try {
  const { gstNumber } = validateProvisionOptions(options);
  if (!values['dry-run']) options.ownerPassword = await readOwnerPassword();
  if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set (see .env.example).');
  const db = createDatabase(process.env.DATABASE_URL!, { max: 2 });
  try {
    const result = await provisionTenant(db, options);
    if (result.status === 'already_provisioned') {
      out(`Tenant ${result.tenantId} is already provisioned. Nothing was changed.`);
    } else {
      const verb = result.status === 'dry_run' ? 'Would create' : 'Created';
      out(`${verb} business "${options.businessName.trim()}" (${options.trade.trim()})`);
      out(`  tenant id: ${result.tenantId} (${tenantSource})`);
      out(
        `  GST: ${gstRegistered ? `registered, ${formatNzGstNumber(gstNumber!)}` : 'not registered'}; prices entered ${pricesEntered} of GST`,
      );
      out(`  owner: ${options.ownerEmail.trim().toLowerCase()}`);
      out(`  ${result.rateCount} owner-approved rate(s):`);
      out(
        formatRatesCsv(parsed.rates, parsed.priceColumn ?? 'price_nzd')
          .trimEnd()
          .split('\r\n')
          .map((line) => `    ${line}`)
          .join('\n'),
      );
      if (result.status === 'dry_run') out('Dry run: nothing was written.');
      if (tenantSource !== 'TENANT_ID in the environment')
        out(
          `\nSet TENANT_ID=${result.tenantId} in this installation's .env (or deployment secrets) and restart the API and worker. The API only serves the business whose id matches TENANT_ID.`,
        );
    }
  } finally {
    await db.close();
  }
} catch (error) {
  if (error instanceof ProvisionError) fail(`${error.message} Nothing was changed.`);
  throw error;
}
