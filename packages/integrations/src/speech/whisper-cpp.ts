import { locationFromEndpoint, type ModelDestination } from '@opentradie/core';
import { audioFile, parseVerboseJson, postMultipart, type MultipartFetch } from './http.js';
import {
  validateTranscriptionInput,
  type SpeechToText,
  type Transcript,
  type TranscriptionInput,
} from './types.js';

export interface WhisperCppServerOptions {
  /** e.g. http://127.0.0.1:8080 (whisper-server's default host and port). */
  baseUrl: string;
  /** Label for the model the server was started with (-m); the server does not report it. */
  model: string;
  /** whisper-server --inference-path (default "/inference"); include any --request-path prefix. */
  inferencePath?: string;
  fetch?: MultipartFetch;
  timeoutMs?: number;
  maxAudioBytes?: number;
}

/**
 * whisper.cpp `whisper-server` adapter (examples/server): multipart POST to /inference with
 * `file`, `response_format=verbose_json`, `temperature` and optional `language`.
 * Implemented, not integration-tested: verified against a local fake HTTP server only.
 */
export class WhisperCppServerAdapter implements SpeechToText {
  readonly destination: ModelDestination;
  readonly model: string;
  readonly kind = 'provider' as const;
  private readonly url: string;

  constructor(private readonly options: WhisperCppServerOptions) {
    this.model = options.model;
    this.url = new URL(options.inferencePath ?? '/inference', options.baseUrl).toString();
    this.destination = {
      provider: `whisper.cpp:${options.model}`,
      location: locationFromEndpoint(options.baseUrl),
      attestation: 'endpoint',
    };
  }

  async transcribe(input: TranscriptionInput, signal?: AbortSignal): Promise<Transcript> {
    validateTranscriptionInput(input, this.destination.provider, this.options.maxAudioBytes);
    const { blob, filename } = audioFile(input.audio, input.mediaType);
    const form = new FormData();
    form.set('file', blob, filename);
    form.set('response_format', 'verbose_json');
    form.set('temperature', '0.0');
    if (input.languageHint) form.set('language', input.languageHint);
    const body = await postMultipart(
      this.options.fetch,
      this.url,
      {},
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
