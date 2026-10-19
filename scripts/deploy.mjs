// node scripts/deploy.mjs <local|cloud|hybrid> [--env-file <path>] [--dry-run] [--start] [--yes]
//
// Honest scope: this validates the profile configuration and runs the steps listed
// below. It does NOT provision hosts, DNS, TLS, PostgreSQL servers, Ollama, or an
// OpenClaw Gateway, and it has not been used for a real cloud deployment.
//
//   local : validate env, check PostgreSQL TCP reachability, pnpm build, pnpm db:migrate,
//           print how to run under launchd (or run in the foreground with --start).
//   hybrid: same as local plus authority guards (loopback DB and Gateway, no cloud DB
//           settings, advisory authority lock). Cloud-side components are not deployed.
//   cloud : validate env, then `docker compose` build/up if Docker exists; else explain.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const profile = args[0];
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = flag('--dry-run');

function die(message) {
  console.error(`deploy:${profile ?? '?'}: ${message}`);
  process.exit(1);
}
function step(message) {
  console.log(`\n==> ${message}`);
}
function parseEnv(file) {
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
function run(command, commandArgs, env) {
  console.log(`$ ${command} ${commandArgs.join(' ')}`);
  if (dryRun) return;
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) die(`command failed: ${command} ${commandArgs.join(' ')}`);
}
function commandExists(command) {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}
function tcpReachable(host, port) {
  return new Promise((resolveReach) => {
    const socket = createConnection({ host, port });
    const finish = (ok) => {
      socket.destroy();
      resolveReach(ok);
    };
    socket.setTimeout(3000, () => finish(false));
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
  });
}
const PLACEHOLDER = /(change-me|replace-with|example\.com|your-|<.*>)/i;
function requireVars(env, names) {
  const problems = [];
  for (const name of names) {
    if (!env[name]) problems.push(`${name} is missing or empty`);
    else if (PLACEHOLDER.test(env[name])) problems.push(`${name} still looks like a placeholder`);
  }
  if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32)
    problems.push('SESSION_SECRET must be at least 32 characters');
  if (env.CREDENTIAL_ENCRYPTION_KEY && !/^[0-9a-f]{64}$/i.test(env.CREDENTIAL_ENCRYPTION_KEY))
    problems.push('CREDENTIAL_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  if (problems.length) die(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
}
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function loopbackUrl(value, label) {
  const url = new URL(value);
  if (!LOOPBACK.has(url.hostname))
    die(`${label} must be loopback in this profile (got ${url.hostname}).`);
  return url;
}

if (!['local', 'cloud', 'hybrid'].includes(profile ?? '')) {
  die('usage: deploy.mjs <local|cloud|hybrid> [--env-file <path>] [--dry-run] [--start]');
}

const defaultEnvFile = profile === 'cloud' ? 'deployments/cloud/.env' : '.env';
const envFile = resolve(root, option('--env-file') ?? defaultEnvFile);
if (!existsSync(envFile)) {
  die(
    profile === 'cloud'
      ? `${envFile} not found. Copy deployments/cloud/.env.example and fill it in.`
      : `${envFile} not found. Run \`pnpm setup:dev\`` +
          (profile === 'hybrid' ? ' or copy deployments/hybrid/hybrid.env.example.' : '.'),
  );
}
const env = parseEnv(envFile);
if (env.DEPLOYMENT_PROFILE !== profile)
  die(`DEPLOYMENT_PROFILE in ${envFile} is "${env.DEPLOYMENT_PROFILE}", expected "${profile}".`);
if (dryRun) console.log('(dry run: commands are printed, not executed)');

if (profile === 'local' || profile === 'hybrid') {
  step('Validate configuration');
  requireVars(env, ['DATABASE_URL', 'SESSION_SECRET', 'TENANT_ID', 'CREDENTIAL_ENCRYPTION_KEY']);
  const db = new URL(env.DATABASE_URL);
  if (profile === 'hybrid') {
    if (env.MODEL_LOCATION === 'hosted' && env.PRIVACY_MODE !== 'APPROVED_CLOUD')
      die(
        'MODEL_LOCATION=hosted requires PRIVACY_MODE=APPROVED_CLOUD; other modes deny hosted inference by design.',
      );
    if (env.PRIVACY_MODE === 'APPROVED_CLOUD')
      console.log(
        'note: PRIVACY_MODE=APPROVED_CLOUD allows policy-permitted context to reach cloud models.',
      );
    for (const key of ['CLOUD_DATABASE_URL', 'REMOTE_DATABASE_URL', 'SECONDARY_DATABASE_URL'])
      if (env[key])
        die(`${key} is set. A hybrid installation has exactly one authoritative database.`);
    loopbackUrl(env.DATABASE_URL, 'DATABASE_URL');
    if (env.AGENT_MODE === 'openclaw') loopbackUrl(env.OPENCLAW_URL ?? '', 'OPENCLAW_URL');
    if (env.AUTHORITATIVE_RUNTIME !== 'true')
      die(
        'set AUTHORITATIVE_RUNTIME=true to confirm this machine is the single authoritative runtime.',
      );
    const lockFile = resolve(root, '.data/authoritative.lock');
    if (existsSync(lockFile)) {
      const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
      if (lock.host !== hostname())
        die(
          `.data/authoritative.lock was written by host "${lock.host}". Refusing to start a second authoritative runtime here.`,
        );
    } else if (!dryRun) {
      mkdirSync(dirname(lockFile), { recursive: true });
      writeFileSync(
        lockFile,
        JSON.stringify({ host: hostname(), createdAt: new Date().toISOString() }),
        { mode: 0o600 },
      );
      console.log(
        'wrote .data/authoritative.lock (advisory, local-file only; see docs/DEPLOYMENT.md)',
      );
    }
  }
  step(`Check PostgreSQL is reachable at ${db.hostname}:${db.port || 5432}`);
  if (!dryRun && !(await tcpReachable(db.hostname, Number(db.port || 5432))))
    die('PostgreSQL is not reachable. Start it first (see docs/DEPLOYMENT.md, "Local").');

  step('Build');
  run('pnpm', ['build'], env);
  step('Apply database migrations');
  run('pnpm', ['db:migrate'], env);

  if (flag('--start')) {
    step('Start API in the foreground (Ctrl-C to stop; use launchd for restart-on-failure)');
    run('node', ['dist/api/server.js'], env);
  } else {
    console.log(
      '\nBuilt and migrated. Not started. To run with restart-on-failure on macOS, install the launchd\n' +
        'agent described in deployments/local/README.md, or re-run with --start for a foreground process.',
    );
  }
  console.log(
    '\nNot done by this script: Ollama, OpenClaw Gateway, backups, tunnels or relay. See docs/DEPLOYMENT.md.',
  );
  process.exit(0);
}

// cloud
step('Validate configuration');
requireVars(env, [
  'POSTGRES_PASSWORD',
  'SESSION_SECRET',
  'TENANT_ID',
  'CREDENTIAL_ENCRYPTION_KEY',
  'APP_ORIGIN',
]);
if (!env.APP_ORIGIN.startsWith('https://'))
  die('APP_ORIGIN must be an https:// origin for the cloud profile.');
if (env.SECURE_COOKIES !== 'true') die('SECURE_COOKIES must be true for the cloud profile.');
if (env.MODEL_LOCATION === 'hosted' && env.PRIVACY_MODE !== 'APPROVED_CLOUD')
  die(
    'MODEL_LOCATION=hosted requires PRIVACY_MODE=APPROVED_CLOUD; other modes deny hosted inference by design.',
  );

step('Docker');
if (!commandExists('docker')) {
  console.log('Docker is not installed or not on PATH, so nothing was built or started.');
  console.log(
    'Install Docker (with the compose plugin) on the target host, then re-run, or run manually:',
  );
  console.log(`  docker compose -f docker-compose.cloud.yml --env-file ${envFile} up -d --build`);
  process.exit(2);
}
const compose = ['compose', '-f', 'docker-compose.cloud.yml', '--env-file', envFile];
run('docker', [...compose, 'config', '--quiet'], {});
run('docker', [...compose, 'up', '-d', '--build'], {});
console.log(
  '\nContainers requested. Verify yourself: `docker compose ... ps` and GET /health on your HTTPS origin.',
);
console.log(
  'This script does not provision TLS, DNS or hosting, and cloud deployment is unverified in v0.1.',
);
