import {
  locationFromEndpoint,
  type EmbeddingProvider,
  type ModelDestination,
} from '@opentradie/core';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export class EmbeddingProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingProviderError';
  }
}

const DIMENSIONS = 768;

/**
 * Ollama /api/embed adapter. Its location is derived from the endpoint URL, never from a label:
 * an Ollama server reached over the internet counts as hosted. Not integration-tested against a
 * live Ollama in CI; contract-tested with an injected fetch.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly destination: ModelDestination;
  readonly dimensions = DIMENSIONS;
  constructor(
    private readonly options: { url: string; model: string; fetch?: FetchLike; timeoutMs?: number },
  ) {
    this.destination = {
      provider: `ollama:${options.model}`,
      location: locationFromEndpoint(options.url),
      attestation: 'endpoint',
    };
  }
  async embed(texts: readonly string[]): Promise<number[][]> {
    const body = await post(
      this.options.fetch,
      new URL('/api/embed', this.options.url).toString(),
      {},
      { model: this.options.model, input: texts },
      this.options.timeoutMs,
    );
    const embeddings = (body as { embeddings?: unknown }).embeddings;
    if (!Array.isArray(embeddings))
      throw new EmbeddingProviderError('Embedding response was malformed.');
    return embeddings as number[][];
  }
}

/** OpenAI-compatible /embeddings adapter (e.g. OpenRouter or a self-hosted server). Contract-tested only. */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly destination: ModelDestination;
  readonly dimensions = DIMENSIONS;
  constructor(
    private readonly options: {
      url: string;
      model: string;
      apiKey?: string;
      fetch?: FetchLike;
      timeoutMs?: number;
    },
  ) {
    this.destination = {
      provider: `openai-compatible:${new URL(options.url).hostname}:${options.model}`,
      location: locationFromEndpoint(options.url),
      attestation: 'endpoint',
    };
  }
  async embed(texts: readonly string[]): Promise<number[][]> {
    const url = `${this.options.url.replace(/\/$/, '')}/embeddings`;
    const headers: Record<string, string> = this.options.apiKey
      ? { authorization: `Bearer ${this.options.apiKey}` }
      : {};
    const body = await post(
      this.options.fetch,
      url,
      headers,
      { model: this.options.model, input: texts, dimensions: DIMENSIONS },
      this.options.timeoutMs,
    );
    const data = (body as { data?: Array<{ embedding?: unknown }> }).data;
    if (!Array.isArray(data)) throw new EmbeddingProviderError('Embedding response was malformed.');
    return data.map((item) => item.embedding as number[]);
  }
}

async function post(
  fetchImpl: FetchLike | undefined,
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs = 30_000,
): Promise<unknown> {
  const doFetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // Provider error bodies may echo content; they are never read into errors or logs.
    if (!response.ok)
      throw new EmbeddingProviderError(`Embedding provider returned HTTP ${response.status}.`);
    return await response.json();
  } catch (error) {
    if (error instanceof EmbeddingProviderError) throw error;
    throw new EmbeddingProviderError('Embedding provider unavailable.');
  } finally {
    clearTimeout(timer);
  }
}

export function createEmbeddingProvider(
  config:
    | { provider: 'none' }
    | { provider: 'ollama' | 'openai_compatible'; url: string; model: string; apiKey?: string },
): EmbeddingProvider | null {
  if (config.provider === 'none') return null;
  if (config.provider === 'ollama')
    return new OllamaEmbeddingProvider({ url: config.url, model: config.model });
  return new OpenAICompatibleEmbeddingProvider({
    url: config.url,
    model: config.model,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  });
}
