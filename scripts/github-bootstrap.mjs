// node scripts/github-bootstrap.mjs [--dry-run]
// Applies labels, milestones, milestone issues and the main-branch ruleset using the gh CLI
// (needs admin rights). Run ONCE: milestones and issues are not de-duplicated.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.env.REPO ?? 'hemmingsenpeter-byte/opentradie';
const dry = process.argv.includes('--dry-run');
const data = JSON.parse(readFileSync(resolve(root, '.github/opentradie-issues.json'), 'utf8'));

function gh(args) {
  console.log(
    `+ gh ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a.slice(0, 40)) : a)).join(' ')}`,
  );
  if (dry) return;
  const r = spawnSync('gh', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) {
    console.error('gh failed; stopping.');
    process.exit(1);
  }
}

for (const l of data.labels)
  gh(['label', 'create', l.name, '--color', l.color, '--repo', repo, '--force']);
for (const m of data.milestones)
  gh([
    'api',
    `repos/${repo}/milestones`,
    '-f',
    `title=${m.title}`,
    '-f',
    `description=${m.description}`,
  ]);
for (const i of data.issues)
  gh([
    'issue',
    'create',
    '--repo',
    repo,
    '--title',
    i.title,
    '--body',
    i.body,
    '--milestone',
    i.milestone,
    '--label',
    i.labels.join(','),
  ]);
gh([
  'api',
  `repos/${repo}/rulesets`,
  '--method',
  'POST',
  '--input',
  resolve(root, '.github/ruleset-main.json'),
]);
console.log(dry ? 'dry run complete' : 'done');
