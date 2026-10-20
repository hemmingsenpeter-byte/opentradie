import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETENTION,
  loadResticBackupConfig,
  Restic,
  ResticError,
  type CommandRunner,
} from './restic.js';

type Call = { command: string; args: string[]; env: Record<string, string>; cwd?: string };

function fakeRunner(responses: Record<string, { code: number; stdout?: string }>) {
  const calls: Call[] = [];
  const runner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, ...options });
    const response = responses[args[0]!] ?? { code: 0 };
    return { code: response.code, stdout: response.stdout ?? '', stderr: 'restic noise' };
  };
  return { calls, runner };
}

describe('Restic wrapper', () => {
  it('refuses to run without a password (no unencrypted fallback)', () => {
    expect(() => new Restic({ repository: '/r' })).toThrow(/password not configured/);
    expect(() =>
      loadResticBackupConfig({ DATABASE_URL: 'postgres://x', BACKUP_RESTIC_REPOSITORY: '/r' }),
    ).toThrow(/BACKUP_RESTIC_PASSWORD_FILE/);
  });

  it('passes secrets only via a minimal child env and arguments as an array', async () => {
    process.env.SESSION_SECRET_FOR_TEST = 'must-not-leak';
    const { calls, runner } = fakeRunner({});
    await new Restic({ repository: '/repo', password: 's3cret', binary: 'restic', runner }).check();
    delete process.env.SESSION_SECRET_FOR_TEST;
    expect(calls[0]!.args).toEqual(['check']);
    expect(calls[0]!.env.RESTIC_REPOSITORY).toBe('/repo');
    expect(calls[0]!.env.RESTIC_PASSWORD).toBe('s3cret');
    expect(calls[0]!.env.SESSION_SECRET_FOR_TEST).toBeUndefined();
    expect(calls[0]!.args.join(' ')).not.toContain('s3cret');
  });

  it('prefers a password file and never puts the password in errors', async () => {
    const { calls, runner } = fakeRunner({ snapshots: { code: 12 } });
    const restic = new Restic({ repository: '/repo', passwordFile: '/pw', runner });
    const error = await restic.snapshots().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResticError);
    expect((error as ResticError).code).toBe('WRONG_PASSWORD');
    expect(calls[0]!.env.RESTIC_PASSWORD_FILE).toBe('/pw');
    expect(calls[0]!.env.RESTIC_PASSWORD).toBeUndefined();
  });

  it('init is idempotent: existing repository is not re-initialised', async () => {
    const existing = fakeRunner({ cat: { code: 0 } });
    expect(
      await new Restic({ repository: '/r', password: 'p', runner: existing.runner }).init(),
    ).toEqual({ created: false });
    expect(existing.calls.map((call) => call.args[0])).toEqual(['cat']);
    const missing = fakeRunner({ cat: { code: 10 } });
    expect(
      await new Restic({ repository: '/r', password: 'p', runner: missing.runner }).init(),
    ).toEqual({ created: true });
    expect(missing.calls.map((call) => call.args[0])).toEqual(['cat', 'init']);
  });

  it('parses the backup JSON summary and passes tags and cwd', async () => {
    const stdout = [
      '{"message_type":"status","percent_done":0.5}',
      '{"message_type":"summary","files_new":2,"total_bytes_processed":9,"snapshot_id":"abc123"}',
    ].join('\n');
    const { calls, runner } = fakeRunner({ backup: { code: 0, stdout } });
    const result = await new Restic({ repository: '/r', password: 'p', runner }).backup(
      ['database', 'files'],
      {
        cwd: '/stage',
        tags: ['installation:x', 'schema:0015_y'],
      },
    );
    expect(result).toEqual({ snapshotId: 'abc123', filesNew: 2, bytesProcessed: 9 });
    expect(calls[0]!.cwd).toBe('/stage');
    expect(calls[0]!.args).toEqual([
      'backup',
      '--json',
      '--tag',
      'installation:x',
      '--tag',
      'schema:0015_y',
      '--',
      'database',
      'files',
    ]);
  });

  it('rejects unsafe tags, snapshot ids and option-like paths', async () => {
    const { runner } = fakeRunner({});
    const restic = new Restic({ repository: '/r', password: 'p', runner });
    await expect(restic.backup(['x'], { cwd: '/', tags: ['bad tag'] })).rejects.toThrow(/tag/);
    await expect(restic.backup(['--exclude=x'], { cwd: '/', tags: [] })).rejects.toThrow(/paths/);
    await expect(restic.restore('--target=/', '/t')).rejects.toThrow(/snapshot/);
  });

  it('applies the retention policy with prune', async () => {
    const { calls, runner } = fakeRunner({});
    await new Restic({ repository: '/r', password: 'p', runner }).forget(DEFAULT_RETENTION);
    expect(calls[0]!.args).toEqual([
      'forget',
      '--json',
      '--keep-daily',
      '7',
      '--keep-weekly',
      '4',
      '--keep-monthly',
      '12',
      '--prune',
    ]);
  });

  it('reads configurable retention and rejects non-integers', () => {
    const base = {
      DATABASE_URL: 'postgres://x',
      BACKUP_RESTIC_REPOSITORY: '/r',
      BACKUP_RESTIC_PASSWORD_FILE: '/pw',
    };
    expect(loadResticBackupConfig({ ...base, BACKUP_RETENTION_DAILY: '14' }).retention).toEqual({
      keepDaily: 14,
      keepWeekly: 4,
      keepMonthly: 12,
    });
    expect(loadResticBackupConfig({ ...base, FILE_STORE: 's3' }).fileStorePath).toBeNull();
    expect(() => loadResticBackupConfig({ ...base, BACKUP_RETENTION_WEEKLY: 'lots' })).toThrow(
      /integer/,
    );
  });

  it('maps a missing repository to REPOSITORY_MISSING', async () => {
    const { runner } = fakeRunner({ snapshots: { code: 10 } });
    await expect(
      new Restic({ repository: '/r', password: 'p', runner }).snapshots(),
    ).rejects.toMatchObject({ code: 'REPOSITORY_MISSING' });
  });
});
