// pnpm dev: runs the API (tsx watch) and the web dev server (vite) together.
// No extra dependencies. Run via `node --env-file=.env scripts/dev.mjs` (see package.json).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(resolve(root, 'node_modules'))) {
  console.error('dev: dependencies are not installed. Run `pnpm install` first.');
  process.exit(1);
}

const children = [];
let shuttingDown = false;

function run(name, command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const prefix = (stream, out) =>
    stream.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) if (line) out.write(`[${name}] ${line}\n`);
    });
  prefix(child.stdout, process.stdout);
  prefix(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev] ${name} exited (${signal ?? code}); stopping the other process.`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref?.();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('api', 'pnpm', ['exec', 'tsx', 'watch', 'apps/api/src/server.ts'], root);
run('web', 'pnpm', ['--filter', '@opentradie/web', 'dev'], root);
console.log('[dev] API on http://127.0.0.1:3000, web on http://127.0.0.1:5173. Ctrl-C stops both.');
