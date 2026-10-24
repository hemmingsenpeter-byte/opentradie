import {
  loadResticBackupConfig,
  ResticError,
  runResticBackup,
  runResticRestore,
} from '@opentradie/platform';

/**
 * Operational backup commands (docs/MIGRATION.md, ADR 0028). restic must be installed.
 *   pnpm backup:run
 *   pnpm backup:restore -- --snapshot <id> --target <dir> [--database-url <empty migrated db>]
 * Config: DATABASE_URL, BACKUP_RESTIC_REPOSITORY, BACKUP_RESTIC_PASSWORD_FILE,
 * BACKUP_RETENTION_DAILY/WEEKLY/MONTHLY, FILE_STORE/FILE_STORE_PATH, INSTALLATION_ID.
 * Refuses to run without a password file. Never prints the repository password or row data.
 */
const [command, ...rest] = process.argv.slice(2).filter((arg) => arg !== '--');
const flag = (name: string): string | undefined => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : undefined;
};

try {
  if (command === 'run') {
    const config = loadResticBackupConfig(process.env);
    const result = await runResticBackup(config);
    process.stdout.write(
      `${JSON.stringify({ backup: 'ok', snapshot: result.snapshotId, tags: result.tags, tables: Object.keys(result.fingerprint).length })}\n`,
    );
  } else if (command === 'restore') {
    const snapshotId = flag('snapshot');
    const target = flag('target');
    if (!snapshotId || !target)
      throw new Error('Usage: pnpm backup:restore -- --snapshot <id> --target <dir>');
    if (!process.env.BACKUP_RESTIC_REPOSITORY || !process.env.BACKUP_RESTIC_PASSWORD_FILE)
      throw new ResticError(
        'NOT_CONFIGURED',
        'BACKUP_RESTIC_REPOSITORY and BACKUP_RESTIC_PASSWORD_FILE are required.',
      );
    const result = await runResticRestore(
      {
        repository: process.env.BACKUP_RESTIC_REPOSITORY,
        passwordFile: process.env.BACKUP_RESTIC_PASSWORD_FILE,
        binary: process.env.BACKUP_RESTIC_BINARY || 'restic',
      },
      { snapshotId, target, databaseUrl: flag('database-url') },
    );
    process.stdout.write(
      `${JSON.stringify({ restore: 'ok', target, schemaVersion: result.manifest.schemaVersion, databaseRestored: result.fingerprint !== null })}\n`,
    );
  } else {
    throw new Error('Usage: tsx scripts/backup.ts run|restore');
  }
} catch (error) {
  process.stderr.write(
    `Backup ${command ?? ''} FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
