/**
 * Evidence files are untrusted input. The declared media type must be on the allowlist and the
 * leading bytes must match it, so a script or HTML file cannot be stored as a "photo".
 */
export type EvidenceMediaType =
  'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'application/pdf';

const ascii = (bytes: Buffer, start: number, end: number) =>
  bytes.subarray(start, end).toString('latin1');

export function contentMatchesMediaType(bytes: Buffer, mediaType: EvidenceMediaType): boolean {
  switch (mediaType) {
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return bytes.length >= 8 && ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n';
    case 'image/webp':
      return bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP';
    case 'image/heic':
      return (
        bytes.length >= 12 &&
        ascii(bytes, 4, 8) === 'ftyp' &&
        ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(
          ascii(bytes, 8, 12),
        )
      );
    case 'application/pdf':
      return bytes.length >= 5 && ascii(bytes, 0, 5) === '%PDF-';
  }
}

const EXTENSIONS: Record<EvidenceMediaType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

export function extensionFor(mediaType: EvidenceMediaType): string {
  return EXTENSIONS[mediaType];
}

/** Keep a display name only: no paths, control characters or quotes. */
export function safeFileName(name: string, mediaType: EvidenceMediaType): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .split('')
    .filter((char) => char.charCodeAt(0) > 0x1f && char.charCodeAt(0) !== 0x7f)
    .join('')
    .replace(/["<>|*?:]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return cleaned && cleaned !== '.' && cleaned !== '..'
    ? cleaned
    : `evidence.${extensionFor(mediaType)}`;
}

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 filename*. */
export function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
