import { PermanentError, RateLimitedError, TransientError } from '../errors.js';
import type { TranscriptSegment } from './types.js';

export type MultipartFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: FormData; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

const EXTENSIONS: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
};

export function audioFile(audio: Uint8Array, mediaType: string): { blob: Blob; filename: string } {
  const type = mediaType.toLowerCase();
  return {
    blob: new Blob([new Uint8Array(audio)], { type }),
    filename: `audio.${EXTENSIONS[type] ?? 'bin'}`,
  };
}

/** POSTs multipart form data. Error bodies may echo audio-derived text and are never read. */
export async function postMultipart(
  fetchImpl: MultipartFetch | undefined,
  url: string,
  headers: Record<string, string>,
  form: FormData,
  provider: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const doFetch = fetchImpl ?? (globalThis.fetch as unknown as MultipartFetch);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let response: Awaited<ReturnType<MultipartFetch>>;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers,
      body: form,
      signal: controller.signal,
    });
  } catch {
    throw new TransientError('Speech service could not be reached.', 'network', provider);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  if (!response.ok) {
    if (response.status === 429) {
      const retry = Number(response.headers.get('retry-after'));
      throw new RateLimitedError(
        'Speech service rate limit reached.',
        'rate_limit',
        provider,
        Number.isFinite(retry) && retry >= 0 ? retry : 30,
      );
    }
    if (response.status >= 500 || response.status === 408)
      throw new TransientError(
        `Speech service returned HTTP ${response.status}.`,
        `http_${response.status}`,
        provider,
      );
    throw new PermanentError(
      `Speech service returned HTTP ${response.status}.`,
      `http_${response.status}`,
      provider,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new PermanentError(
      'Speech service returned a malformed response.',
      'malformed_response',
      provider,
    );
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Parses whisper-style verbose_json (whisper.cpp server and OpenAI-compatible servers share the
 * shape): seconds as floats are converted to integer milliseconds. These are timings, not money.
 */
export function parseVerboseJson(
  body: unknown,
  provider: string,
): {
  text: string;
  segments: TranscriptSegment[];
  language: string | null;
  durationMs: number | null;
} {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  if (!record || typeof record.text !== 'string')
    throw new PermanentError(
      'Speech service returned a malformed response.',
      'malformed_response',
      provider,
    );
  const segments: TranscriptSegment[] = [];
  for (const raw of Array.isArray(record.segments) ? record.segments : []) {
    const segment = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const start = num(segment.start);
    const end = num(segment.end);
    if (start === null || end === null || typeof segment.text !== 'string') continue;
    const words = Array.isArray(segment.words) ? segment.words : [];
    const probabilities = words
      .map((word) => num((word as Record<string, unknown>)?.probability))
      .filter((p): p is number => p !== null);
    const avgLogprob = num(segment.avg_logprob);
    const confidence = probabilities.length
      ? clamp01(probabilities.reduce((a, b) => a + b, 0) / probabilities.length)
      : avgLogprob !== null
        ? clamp01(Math.exp(avgLogprob))
        : null;
    segments.push({
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000),
      text: segment.text.trim(),
      confidence,
    });
  }
  const duration = num(record.duration);
  const last = segments.at(-1);
  return {
    text: record.text.trim(),
    segments,
    language: typeof record.language === 'string' ? record.language : null,
    durationMs: duration !== null ? Math.round(duration * 1000) : last ? last.endMs : null,
  };
}
