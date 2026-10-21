/**
 * Minimal streaming ZIP writer (ADR 0025 amendment): STORE only (no compression), UTF-8 names
 * (general-purpose flag bit 11), DOS timestamps, no ZIP64. Entries are read one at a time so
 * memory holds at most one file; the archive is refused once it would exceed `maxTotalBytes`
 * (default and hard ceiling 2 GiB, well inside the 32-bit offsets of classic ZIP).
 */

export const ZIP_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 0xffff;

export class ZipError extends Error {
  constructor(
    readonly code: 'TOO_LARGE' | 'INVALID_NAME' | 'TOO_MANY_ENTRIES',
    message: string,
  ) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  /** Forward-slash relative path. No leading slash, `..`, backslashes or control characters. */
  name: string;
  modified?: Date;
  /** Read the entry's bytes. Throwing here (for example on a checksum mismatch) aborts the archive. */
  read(): Promise<Buffer>;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time (UTC components; DOS has no zone). Years before 1980 clamp to 1980-01-01. */
export function dosDateTime(date: Date): { time: number; date: number } {
  if (date.getUTCFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date:
      ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function validateName(name: string): Buffer {
  const bytes = Buffer.from(name, 'utf8');
  if (
    !name ||
    bytes.length > 0xffff ||
    name.startsWith('/') ||
    name.includes('\\') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(name) ||
    name.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new ZipError('INVALID_NAME', 'Invalid archive entry name.');
  return bytes;
}

const UTF8_FLAG = 0x0800;
const VERSION = 20;

/** Yield the archive as chunks. Errors (from the writer or an entry's read) end the iterator. */
export async function* zipStream(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
  options: { maxTotalBytes?: number } = {},
): AsyncGenerator<Buffer> {
  const cap = Math.min(options.maxTotalBytes ?? ZIP_MAX_TOTAL_BYTES, ZIP_MAX_TOTAL_BYTES);
  const central: Buffer[] = [];
  const names = new Set<string>();
  let offset = 0;
  let centralSize = 0;
  for await (const entry of entries) {
    const name = validateName(entry.name);
    if (names.has(entry.name)) throw new ZipError('INVALID_NAME', 'Duplicate archive entry name.');
    names.add(entry.name);
    if (central.length >= MAX_ENTRIES)
      throw new ZipError('TOO_MANY_ENTRIES', 'Too many files for one archive.');
    const data = await entry.read();
    const projected = offset + 30 + name.length + data.length + centralSize + 46 + name.length + 22;
    if (projected > cap) throw new ZipError('TOO_LARGE', 'Archive would exceed the size limit.');
    const crc = crc32(data);
    const { time, date } = dosDateTime(entry.modified ?? new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | VERSION, 4); // made by: Unix
    header.writeUInt16LE(VERSION, 6);
    header.writeUInt16LE(UTF8_FLAG, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    // extra, comment, disk start, internal attributes: 0
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    centralSize += 46 + name.length;

    yield Buffer.concat([local, name]);
    if (data.length) yield data;
    offset += 30 + name.length + data.length;
  }
  for (const part of central) yield part;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  yield end;
}
