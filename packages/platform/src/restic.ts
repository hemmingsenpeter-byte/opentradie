import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { createLogicalBackup, restoreLogicalBackup, type DatabaseFingerprint } from './backup.js';

/**
 * Thin wrapper over the external restic binary (BSD-2-Clause, not vendored; ADR 0028).
 * Arguments are always passed as an array (never a shell string). The repository and password
 * reach restic only through the child's environment, which is built from scratch so no other
 * process secrets leak into it. Neither is ever logged or included in an error message.
 */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (
  command: string,
  args: string[],
  options: { env: Record<string, string>; cwd?: string },
) => Promise<CommandResult>;

export const spawnRunner: CommandRunner = (command, args, options) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
  });

export interface RetentionPolicy {
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}
export const DEFAULT_RETENTION: RetentionPolicy = { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 };

export interface ResticOptions {
  repository: string;
  /** Preferred: a file only the backup user can read. */
  passwordFile?: string;
  /** Tests and drills only; operational commands use passwordFile. */
  password?: string;
  binary?: string;
  runner?: CommandRunner;
  /** Optional restic cache directory (defaults to restic's own). */
  cacheDir?: string;
}

export interface ResticSnapshot {
  id: string;
  short_id: string;
  time: string;
  paths: string[];
  tags?: string[];
  hostname: string;
}

export class ResticError extends Error {
  constructor(
    readonly code:
      'NOT_CONFIGURED' | 'WRONG_PASSWORD' | 'REPOSITORY_MISSING' | 'COMMAND_FAILED' | 'BAD_OUTPUT',
    message: string,
    readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = 'ResticError';
  }
}

const TAG = /^[A-Za-z0-9._:-]{1,128}$/;
const SNAPSHOT = /^([0-9a-f]{8,64}|latest)$/;

export class Restic {
  private readonly binary: string;
  private readonly runner: CommandRunner;
  constructor(private readonly options: ResticOptions) {
    if (!options.repository) throw new ResticError('NOT_CONFIGURED', 'Restic repository not set.');
    if (!options.passwordFile && !options.password)
      throw new ResticError(
        'NOT_CONFIGURED',
        'Restic password not configured; refusing to run (no unencrypted fallback).',
      );
    this.binary = options.binary ?? 'restic';
    this.runner = options.runner ?? spawnRunner;
  }

  /** Minimal child environment: never inherits the parent's secrets. */
  private env(): Record<string, string> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? tmpdir(),
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      RESTIC_REPOSITORY: this.options.repository,
      RESTIC_PROGRESS_FPS: '0.1',
    };
    if (this.options.passwordFile) env.RESTIC_PASSWORD_FILE = this.options.passwordFile;
    else env.RESTIC_PASSWORD = this.options.password!;
    if (this.options.cacheDir) env.RESTIC_CACHE_DIR = this.options.cacheDir;
    return env;
  }

  private async run(
    args: string[],
    options: { cwd?: string; allow?: number[] } = {},
  ): Promise<CommandResult> {
    const result = await this.runner(this.binary, args, { env: this.env(), cwd: options.cwd });
    if (result.code === 0 || options.allow?.includes(result.code)) return result;
    // restic exit codes: 10 = repository does not exist, 12 = wrong password.
    if (result.code === 12)
      throw new ResticError('WRONG_PASSWORD', 'Restic rejected the repository password.', 12);
    if (result.code === 10)
      throw new ResticError('REPOSITORY_MISSING', 'Restic repository does not exist.', 10);
    throw new ResticError(
      'COMMAND_FAILED',
      `restic ${args[0]} failed with exit code ${result.code}.`,
      result.code,
    );
  }

  private static jsonLines(stdout: string): Record<string, unknown>[] {
    const lines: Record<string, unknown>[] = [];
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        lines.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        /* progress noise */
      }
    }
    return lines;
  }

  /** Idempotent: an existing repository (readable with this password) is left untouched. */
  async init(): Promise<{ created: boolean }> {
    const probe = await this.run(['cat', 'config', '--json'], { allow: [10] });
    if (probe.code === 0) return { created: false };
    await this.run(['init', '--json']);
    return { created: true };
  }

  /** Back up paths relative to cwd, so a restore lays them out under the target directory. */
  async backup(
    paths: string[],
    options: { cwd: string; tags: string[]; host?: string },
  ): Promise<{ snapshotId: string; filesNew: number; bytesProcessed: number }> {
    for (const tag of options.tags)
      if (!TAG.test(tag)) throw new ResticError('NOT_CONFIGURED', 'Invalid restic tag.');
    if (paths.length === 0 || paths.some((path) => path.startsWith('-')))
      throw new ResticError('NOT_CONFIGURED', 'Invalid backup paths.');
    const args = ['backup', '--json'];
    for (const tag of options.tags) args.push('--tag', tag);
    if (options.host) args.push('--host', options.host);
    args.push('--', ...paths);
    const result = await this.run(args, { cwd: options.cwd });
    const summary = Restic.jsonLines(result.stdout).find((line) => line.message_type === 'summary');
    if (!summary || typeof summary.snapshot_id !== 'string')
      throw new ResticError('BAD_OUTPUT', 'restic backup produced no snapshot summary.');
    return {
      snapshotId: summary.snapshot_id,
      filesNew: Number(summary.files_new ?? 0),
      bytesProcessed: Number(summary.total_bytes_processed ?? 0),
    };
  }

  async snapshots(options: { tags?: string[] } = {}): Promise<ResticSnapshot[]> {
    const args = ['snapshots', '--json'];
    for (const tag of options.tags ?? []) args.push('--tag', tag);
    const result = await this.run(args);
    try {
      const parsed = JSON.parse(result.stdout.trim() || '[]') as unknown;
      if (!Array.isArray(parsed)) throw new Error('not an array');
      return parsed as ResticSnapshot[];
    } catch {
      throw new ResticError('BAD_OUTPUT', 'restic snapshots returned unparseable output.');
    }
  }

  async restore(snapshotId: string, target: string): Promise<void> {
    if (!SNAPSHOT.test(snapshotId)) throw new ResticError('NOT_CONFIGURED', 'Invalid snapshot id.');
    await this.run(['restore', snapshotId, '--target', resolve(target), '--json']);
  }

  /** Structural check; readData additionally verifies every pack (slower). */
  async check(options: { readData?: boolean } = {}): Promise<void> {
    await this.run(options.readData ? ['check', '--read-data'] : ['check']);
  }

  async forget(policy: RetentionPolicy, options: { prune?: boolean } = {}): Promise<void> {
    for (const value of Object.values(policy))
      if (!Number.isInteger(value) || value < 0)
        throw new ResticError('NOT_CONFIGURED', 'Retention values must be non-negative integers.');
    const args = [
      'forget',
      '--json',
      '--keep-daily',
      String(policy.keepDaily),
      '--keep-weekly',
      String(policy.keepWeekly),
      '--keep-monthly',
      String(policy.keepMonthly),
    ];
    if (options.prune !== false) args.push('--prune');
    await this.run(args);
  }
}

export interface ResticBackupConfig {
  restic: ResticOptions;
  retention: RetentionPolicy;
  databaseUrl: string;
  /** Local-FS profile file store directory; null when files live in S3 (backed up separately). */
  fileStorePath: string | null;
  installationId: string;
}

const retentionValue = (raw: string | undefined, fallback: number, name: string) => {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,4}$/.test(raw))
    throw new ResticError('NOT_CONFIGURED', `${name} must be an integer.`);
  return Number(raw);
};

/** Reads BACKUP_* settings. Fails closed: no password file means no backup, never plaintext. */
export function loadResticBackupConfig(env: NodeJS.ProcessEnv): ResticBackupConfig {
  const missing = [
    'DATABASE_URL',
    'BACKUP_RESTIC_REPOSITORY',
    'BACKUP_RESTIC_PASSWORD_FILE',
  ].filter((name) => !env[name]);
  if (missing.length)
    throw new ResticError(
      'NOT_CONFIGURED',
      `Missing ${missing.join(', ')}; refusing to back up (no unencrypted fallback).`,
    );
  return {
    restic: {
      repository: env.BACKUP_RESTIC_REPOSITORY!,
      passwordFile: env.BACKUP_RESTIC_PASSWORD_FILE!,
      binary: env.BACKUP_RESTIC_BINARY || 'restic',
    },
    retention: {
      keepDaily: retentionValue(env.BACKUP_RETENTION_DAILY, 7, 'BACKUP_RETENTION_DAILY'),
      keepWeekly: retentionValue(env.BACKUP_RETENTION_WEEKLY, 4, 'BACKUP_RETENTION_WEEKLY'),
      keepMonthly: retentionValue(env.BACKUP_RETENTION_MONTHLY, 12, 'BACKUP_RETENTION_MONTHLY'),
    },
    databaseUrl: env.DATABASE_URL!,
    fileStorePath:
      (env.FILE_STORE ?? 'local') === 'local' ? (env.FILE_STORE_PATH ?? '.data/files') : null,
    installationId:
      env.INSTALLATION_ID ?? (env.TENANT_ID ? `install-${env.TENANT_ID.slice(0, 8)}` : 'unknown'),
  };
}

async function schemaVersion(databaseUrl: string): Promise<string> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1',
    );
    return result.rows[0]?.name.replace(/\.sql$/, '') ?? 'none';
  } finally {
    await client.end();
  }
}

const tagSafe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100);

export interface ResticBackupResult {
  snapshotId: string;
  schemaVersion: string;
  databaseSha256: string;
  fingerprint: DatabaseFingerprint;
  tags: string[];
}

/**
 * One backup run: logical DB backup + file store, staged in a private temp dir and handed to
 * restic (which encrypts). The staging dir is removed afterwards, success or failure.
 * Layout inside the snapshot: database/opentradie.otbk, files/<store contents>, manifest.json.
 */
export async function runResticBackup(
  config: ResticBackupConfig,
  options: { applyRetention?: boolean; stagingParent?: string } = {},
): Promise<ResticBackupResult> {
  const restic = new Restic(config.restic);
  await restic.init();
  const stage = await mkdtemp(join(options.stagingParent ?? tmpdir(), 'opentradie-restic-stage-'));
  try {
    await mkdir(join(stage, 'database'), { mode: 0o700 });
    const { fingerprint, sha256 } = await createLogicalBackup(
      config.databaseUrl,
      join(stage, 'database', 'opentradie.otbk'),
    );
    const paths = ['database', 'manifest.json'];
    if (config.fileStorePath) {
      await mkdir(join(stage, 'files'), { mode: 0o700 });
      const exists = await stat(config.fileStorePath).then(
        (entry) => entry.isDirectory(),
        () => false,
      );
      if (exists) await cp(config.fileStorePath, join(stage, 'files'), { recursive: true });
      paths.push('files');
    }
    const version = await schemaVersion(config.databaseUrl);
    await writeFile(
      join(stage, 'manifest.json'),
      JSON.stringify({
        format: 'opentradie-restic-v1',
        schemaVersion: version,
        databaseSha256: sha256,
        includesFiles: config.fileStorePath !== null,
      }),
      { mode: 0o600 },
    );
    const tags = [
      'opentradie',
      `installation:${tagSafe(config.installationId)}`,
      `schema:${tagSafe(version)}`,
    ];
    const { snapshotId } = await restic.backup(paths, { cwd: stage, tags });
    if (options.applyRetention !== false) await restic.forget(config.retention);
    return { snapshotId, schemaVersion: version, databaseSha256: sha256, fingerprint, tags };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/**
 * Restore a snapshot into `target`. When `databaseUrl` is given, the logical backup is applied to
 * that EMPTY, already-migrated database (restoreLogicalBackup verifies every table's checksum).
 */
export async function runResticRestore(
  restic: ResticOptions,
  options: { snapshotId: string; target: string; databaseUrl?: string },
): Promise<{ manifest: Record<string, unknown>; fingerprint: DatabaseFingerprint | null }> {
  const client = new Restic(restic);
  await client.restore(options.snapshotId, options.target);
  const manifest = JSON.parse(
    await readFile(join(options.target, 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
  const artefact = join(options.target, 'database', 'opentradie.otbk');
  const digest = createHash('sha256')
    .update(await readFile(artefact))
    .digest('hex');
  if (digest !== manifest.databaseSha256)
    throw new ResticError('BAD_OUTPUT', 'Restored database artefact does not match its manifest.');
  const fingerprint = options.databaseUrl
    ? await restoreLogicalBackup(options.databaseUrl, artefact)
    : null;
  return { manifest, fingerprint };
}
