// node scripts/github-bootstrap.mjs [--dry-run]
// Applies labels, milestones, milestone issues and the main-branch ruleset using the gh CLI
// (needs admin rights). Safe to re-run: existing milestones, issues and rulesets are skipped by title/name.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.env.REPO ?? 'hemmingsenpeter-byte/opentradie';
const args = process.argv.slice(2);
if (args.some((a) => a !== '--dry-run')) {
  console.error('usage: node scripts/github-bootstrap.mjs [--dry-run]');
  process.exit(2);
}
const dry = args.includes('--dry-run');
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

function ghJson(apiArgs) {
  const r = spawnSync('gh', ['api', '--paginate', ...apiArgs], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
  return JSON.parse(r.stdout || '[]');
}

const existingMilestones = new Set(
  ghJson([`repos/${repo}/milestones?state=all&per_page=100`]).map((m) => m.title),
);
const existingIssues = new Set(
  ghJson([`repos/${repo}/issues?state=all&per_page=100`]).map((i) => i.title),
);
const ruleset = JSON.parse(readFileSync(resolve(root, '.github/ruleset-main.json'), 'utf8'));
const existingRulesets = new Set(ghJson([`repos/${repo}/rulesets`]).map((r) => r.name));

for (const l of data.labels)
  gh(['label', 'create', l.name, '--color', l.color, '--repo', repo, '--force']);
for (const m of data.milestones.filter((m) => !existingMilestones.has(m.title)))
  gh([
    'api',
    `repos/${repo}/milestones`,
    '-f',
    `title=${m.title}`,
    '-f',
    `description=${m.description}`,
  ]);
for (const i of data.issues.filter((i) => !existingIssues.has(i.title)))
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
if (!existingRulesets.has(ruleset.name))
  gh([
    'api',
    `repos/${repo}/rulesets`,
    '--method',
    'POST',
    '--input',
    resolve(root, '.github/ruleset-main.json'),
  ]);
console.log(dry ? 'dry run complete' : 'done');
