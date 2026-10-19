import { locationFromEndpoint, type ModelDestination } from '@opentradie/core';
import { audioFile, parseVerboseJson, postMultipart, type MultipartFetch } from './http.js';
import {
  validateTranscriptionInput,
  type SpeechToText,
  type Transcript,
  type TranscriptionInput,
} from './types.js';

export interface FasterWhisperHttpOptions {
  /** Server root, e.g. http://127.0.0.1:8000; the adapter appends /v1/audio/transcriptions. */
  baseUrl: string;
  /** Model name the server expects, e.g. "Systran/faster-whisper-small". */
  model: string;
  apiKey?: string;
  fetch?: MultipartFetch;
  timeoutMs?: number;
  maxAudioBytes?: number;
}

/**
 * Generic OpenAI-compatible POST /v1/audio/transcriptions adapter, for example a faster-whisper
 * server. Only loopback endpoints count as local; anything else is hosted and LOCAL_ONLY refuses
 * it. Implemented, not integration-tested.
 */
export class FasterWhisperHttpAdapter implements SpeechToText {
  readonly destination: ModelDestination;
  readonly model: string;
  readonly kind = 'provider' as const;
  private readonly url: string;

  constructor(private readonly options: FasterWhisperHttpOptions) {
    this.model = options.model;
    this.url = `${options.baseUrl.replace(/\/$/, '')}/v1/audio/transcriptions`;
    this.destination = {
      provider: `openai-compatible-stt:${new URL(options.baseUrl).hostname}:${options.model}`,
      location: locationFromEndpoint(options.baseUrl),
      attestation: 'endpoint',
    };
  }

  async transcribe(input: TranscriptionInput, signal?: AbortSignal): Promise<Transcript> {
    validateTranscriptionInput(input, this.destination.provider, this.options.maxAudioBytes);
    const { blob, filename } = audioFile(input.audio, input.mediaType);
    const form = new FormData();
    form.set('file', blob, filename);
    form.set('model', this.model);
    form.set('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    if (input.languageHint) form.set('language', input.languageHint);
    const headers: Record<string, string> = this.options.apiKey
      ? { authorization: `Bearer ${this.options.apiKey}` }
      : {};
    const body = await postMultipart(
      this.options.fetch,
      this.url,
      headers,
      form,
      this.destination.provider,
      this.options.timeoutMs ?? 120_000,
      signal,
    );
    return {
      ...parseVerboseJson(body, this.destination.provider),
      provider: this.destination.provider,
      model: this.model,
      location: this.destination.location === 'local' ? 'local' : 'hosted',
    };
  }
}
