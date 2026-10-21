import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { crc32, dosDateTime, ZipError, zipStream, type ZipEntry } from './zip.js';

const dir = mkdtempSync(join(tmpdir(), 'opentradie-zip-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function build(entries: ZipEntry[], maxTotalBytes?: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of zipStream(entries, { maxTotalBytes })) chunks.push(chunk);
  return Buffer.concat(chunks);
}
const entry = (name: string, body: string | Buffer): ZipEntry => ({
  name,
  modified: new Date('2026-10-21T09:30:44Z'),
  read: async () => (Buffer.isBuffer(body) ? body : Buffer.from(body)),
});
/** Python's zipfile (isolated mode) checks every CRC and returns names, sizes and contents. */
function pythonRead(path: string) {
  const script =
    'import zipfile,sys,json\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\n' +
    'print(json.dumps([[i.filename,i.file_size,i.compress_type,i.flag_bits,list(i.date_time),z.read(i).hex()] for i in z.infolist()]))';
  return JSON.parse(execFileSync('python3', ['-I', '-c', script, path], { encoding: 'utf8' }));
}

describe('streaming STORE zip writer', () => {
  it('computes the standard CRC-32 and DOS timestamps', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
    expect(dosDateTime(new Date('1970-01-01T00:00:00Z'))).toEqual({ time: 0, date: 33 });
  });

  it('produces an archive unzip and Python both accept, with UTF-8 names and correct CRCs', async () => {
    const binary = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256));
    const archive = await build([
      entry('export.json', '{"ok":true}'),
      entry('files/1-Māori café ✓.txt', 'kia ora'),
      entry('files/2-empty.bin', Buffer.alloc(0)),
      entry('files/3-photo.bin', binary),
    ]);
    const path = join(dir, 'a.zip');
    writeFileSync(path, archive);
    expect(execFileSync('unzip', ['-t', path], { encoding: 'utf8' })).toMatch(/No errors detected/);
    const listed = pythonRead(path);
    expect(listed.map((row: unknown[]) => row[0])).toEqual([
      'export.json',
      'files/1-Māori café ✓.txt',
      'files/2-empty.bin',
      'files/3-photo.bin',
    ]);
    for (const row of listed) {
      expect(row[2]).toBe(0); // stored
      expect(row[3] & 0x0800).toBe(0x0800); // UTF-8 names
      expect(row[4]).toEqual([2026, 10, 21, 9, 30, 44]);
    }
    expect(Buffer.from(listed[1][5], 'hex').toString()).toBe('kia ora');
    expect(Buffer.from(listed[3][5], 'hex').equals(binary)).toBe(true);
  });

  it('writes a valid empty archive', async () => {
    const archive = await build([]);
    expect(archive).toHaveLength(22);
    const path = join(dir, 'empty.zip');
    writeFileSync(path, archive);
    expect(pythonRead(path)).toEqual([]);
  });

  it('refuses archives over the cap, unsafe or duplicate names, and propagates read errors', async () => {
    await expect(build([entry('a.bin', Buffer.alloc(1000))], 500)).rejects.toMatchObject({
      code: 'TOO_LARGE',
    });
    for (const name of ['/abs', '../up', 'a/../b', 'a\\b', '', 'a//b', 'bad\nname'])
      await expect(build([entry(name, 'x')])).rejects.toBeInstanceOf(ZipError);
    await expect(build([entry('a', 'x'), entry('a', 'y')])).rejects.toMatchObject({
      code: 'INVALID_NAME',
    });
    await expect(
      build([
        {
          name: 'bad',
          read: async () => {
            throw new Error('checksum mismatch');
          },
        },
      ]),
    ).rejects.toThrow('checksum mismatch');
  });
});
