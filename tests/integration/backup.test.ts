import { describe, expect, inject, it } from 'vitest';
import { runBackupCheck } from '../../scripts/lib/backup-check.js';

describe('backup and restore', () => {
  it('restores a populated database with identical row counts and checksums', async () => {
    const lines: string[] = [];
    const result = await runBackupCheck(inject('adminDatabaseUrl'), (line) => lines.push(line));
    expect(result.logical.verified).toBe(true);
    expect(result.rows).toBeGreaterThan(30);
    // pg_dump runs only where matching client binaries exist; `pnpm test:backup` with
    // REQUIRE_PG_DUMP=true makes it mandatory (the CI backup job).
    if (!result.pgDump.verified) expect(result.pgDump.skippedReason).toBeTruthy();
  });
});
