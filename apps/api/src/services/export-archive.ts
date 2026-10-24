import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  ZIP_MAX_TOTAL_BYTES,
  zipStream,
  type FileStore,
  type ZipEntry,
} from '@opentradie/platform';
import { HttpError } from '../http.js';

/** Value customer erasure writes over file_name; such files were deleted from the store. */
const ERASED_FILE_NAME = '[erased]';

interface DocumentRow {
  id: string;
  kind: string;
  storage_key: string;
  file_name: string;
  media_type: string;
  size_bytes: number | string;
  sha256: string;
  created_at?: string;
}

export interface ArchiveBundle {
  generatedAt: string;
  tables: Record<string, { columns: string[]; rows: unknown[] }>;
}

/** Keep letters (any script), digits, dot, dash, underscore and space; cap the length. */
export function sanitiseFileName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 120);
  return cleaned || 'file';
}

export class ExportIntegrityError extends Error {
  constructor(readonly documentId: string) {
    super('A stored file does not match its recorded checksum or size.');
    this.name = 'ExportIntegrityError';
  }
}

/**
 * Plan a zip export (ADR 0025 amendment): export.json (the JSON bundle, unchanged apart from
 * `files`), manifest.json (sha256 per file) and files/<document id>-<sanitised name> for every
 * document row in the bundle. Files are read from the store one at a time while streaming and
 * checked against the recorded sha256 and size; a mismatch or missing file aborts the stream so
 * the client never receives a complete-looking archive (it has no central directory).
 */
export function planExportArchive<T extends ArchiveBundle>(bundle: T, fileStore: FileStore) {
  const documents = (bundle.tables.documents?.rows ?? []) as DocumentRow[];
  const included = documents.filter((row) => row.file_name !== ERASED_FILE_NAME);
  const omitted = documents
    .filter((row) => row.file_name === ERASED_FILE_NAME)
    .map((row) => ({ documentId: row.id, reason: 'erased' }));
  const files = included.map((row) => ({
    documentId: row.id,
    path: `files/${row.id}-${sanitiseFileName(row.file_name)}`,
    kind: row.kind,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    storageKey: row.storage_key,
  }));
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (totalBytes > ZIP_MAX_TOTAL_BYTES - 64 * 1024 * 1024)
    throw new HttpError(
      413,
      'EXPORT_TOO_LARGE',
      'Files are too large for one archive; use a backup instead.',
    );
  const exportJson = Buffer.from(
    JSON.stringify(
      {
        ...bundle,
        files: {
          included: true,
          note: 'File contents are in files/ of this archive; manifest.json lists each with its sha256.',
        },
      },
      null,
      2,
    ),
  );
  const manifest = Buffer.from(
    JSON.stringify(
      {
        generatedAt: bundle.generatedAt,
        files: files.map(({ storageKey: _storageKey, ...file }) => file),
        omitted,
      },
      null,
      2,
    ),
  );
  const modified = new Date(bundle.generatedAt);
  function* entries(): Generator<ZipEntry> {
    yield { name: 'export.json', modified, read: async () => exportJson };
    yield { name: 'manifest.json', modified, read: async () => manifest };
    for (const file of files)
      yield {
        name: file.path,
        modified,
        read: async () => {
          const body = await fileStore.get(file.storageKey);
          const digest = createHash('sha256').update(body).digest('hex');
          if (digest !== file.sha256 || body.length !== file.sizeBytes)
            throw new ExportIntegrityError(file.documentId);
          return body;
        },
      };
  }
  return {
    fileCount: files.length,
    omittedCount: omitted.length,
    totalBytes,
    stream: () => Readable.from(zipStream(entries())),
  };
}
