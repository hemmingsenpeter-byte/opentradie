import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  FileStoreError,
  LocalFileStore,
  OllamaEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
  S3FileStore,
  type FileStore,
} from '@opentradie/platform';
import { InMemoryS3 } from '../helpers/s3-fake.js';

const stores: Array<[string, () => Promise<{ store: FileStore; s3?: InMemoryS3 }>]> = [
  [
    'LocalFileStore (real filesystem)',
    async () => ({
      store: new LocalFileStore(await mkdtemp(join(tmpdir(), 'opentradie-contract-'))),
    }),
  ],
  [
    'S3FileStore (in-memory fake; not integration-tested against a real bucket)',
    async () => {
      const s3 = new InMemoryS3('opentradie-test');
      return { store: new S3FileStore(s3, 'opentradie-test'), s3 };
    },
  ],
];

describe.each(stores)('FileStore contract: %s', (_name, make) => {
  it('round-trips bytes with size and SHA-256', async () => {
    const { store } = await make();
    const body = Buffer.from('{"quote":"synthetic"}');
    const stored = await store.put('tenants/t1/quotes/q1/v2.json', body, {
      contentType: 'application/json',
    });
    expect(stored).toEqual({
      key: 'tenants/t1/quotes/q1/v2.json',
      sizeBytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
    expect((await store.get('tenants/t1/quotes/q1/v2.json')).equals(body)).toBe(true);
    expect(await store.exists('tenants/t1/quotes/q1/v2.json')).toBe(true);
  });

  it('overwrites, deletes and reports missing files the same way', async () => {
    const { store } = await make();
    await store.put('a/b.txt', Buffer.from('one'), { contentType: 'text/plain' });
    await store.put('a/b.txt', Buffer.from('two'), { contentType: 'text/plain' });
    expect((await store.get('a/b.txt')).toString()).toBe('two');
    await store.delete('a/b.txt');
    await store.delete('a/b.txt');
    expect(await store.exists('a/b.txt')).toBe(false);
    await expect(store.get('a/b.txt')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects path traversal and malformed keys', async () => {
    const { store } = await make();
    for (const key of ['../escape', 'a/../../b', '/absolute', 'a//b', '', 'a/./b']) {
      await expect(
        store.put(key, Buffer.from('x'), { contentType: 'text/plain' }),
        key,
      ).rejects.toBeInstanceOf(FileStoreError);
    }
  });

  it('reports health', async () => {
    const { store } = await make();
    expect(await store.health()).toEqual({ status: 'ok' });
  });
});

describe('S3 adapter request details', () => {
  it('sends a SHA-256 checksum and requests server-side encryption', async () => {
    const s3 = new InMemoryS3('bucket');
    await new S3FileStore(s3, 'bucket').put('k/v.json', Buffer.from('{}'), {
      contentType: 'application/json',
    });
    expect(s3.objects.get('k/v.json')).toMatchObject({
      contentType: 'application/json',
      encryption: 'AES256',
    });
  });
});

describe('embedding adapter contracts (injected fetch; no live provider)', () => {
  const vector = new Array(768).fill(0.5);
  it('Ollama: posts to /api/embed and parses embeddings', async () => {
    const fetch = vi.fn(async (_url: string, _init: { body: string }) => ({
      ok: true,
      status: 200,
      json: async () => ({ embeddings: [vector] }),
    }));
    const provider = new OllamaEmbeddingProvider({
      url: 'http://127.0.0.1:11434',
      model: 'nomic-embed-text',
      fetch,
    });
    expect(provider.destination).toEqual({
      provider: 'ollama:nomic-embed-text',
      location: 'local',
      attestation: 'endpoint',
    });
    expect(await provider.embed(['hello'])).toEqual([vector]);
    expect(fetch.mock.calls[0]![0]).toBe('http://127.0.0.1:11434/api/embed');
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
      model: 'nomic-embed-text',
      input: ['hello'],
    });
  });

  it('OpenAI-compatible: bearer auth, /embeddings, hosted location, and errors that never echo provider bodies', async () => {
    const fetch = vi.fn(async (_url: string, _init: { headers: Record<string, string> }) => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: vector }] }),
    }));
    const provider = new OpenAICompatibleEmbeddingProvider({
      url: 'https://openrouter.ai/api/v1',
      model: 'm',
      apiKey: 'k',
      fetch,
    });
    expect(provider.destination.location).toBe('hosted');
    expect(await provider.embed(['hello'])).toEqual([vector]);
    expect(fetch.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(fetch.mock.calls[0]![1].headers.authorization).toBe('Bearer k');
    const failing = new OpenAICompatibleEmbeddingProvider({
      url: 'https://example.com/v1',
      model: 'm',
      fetch: async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'echo: private text' }),
      }),
    });
    await expect(failing.embed(['private text'])).rejects.toThrow(
      'Embedding provider returned HTTP 500.',
    );
  });
});
