import { createHash } from 'node:crypto';
import type { ModelDestination } from '@opentradie/core';
import {
  validateTranscriptionInput,
  type SpeechToText,
  type Transcript,
  type TranscriptionInput,
  type TranscriptSegment,
} from './types.js';

export interface SpeechFixture {
  text: string;
  segments?: TranscriptSegment[];
  language?: string;
  durationMs?: number;
}

/**
 * MOCK. Returns fixture transcripts keyed by the SHA-256 of the audio bytes, or a default
 * fixture. Runs in-process (location local). Never evidence of a working speech integration.
 */
export class MockSpeechToText implements SpeechToText {
  readonly destination: ModelDestination = {
    provider: 'mock',
    location: 'local',
    attestation: 'runtime',
  };
  readonly model = 'mock-transcriber';
  readonly kind = 'mock' as const;
  readonly calls: Array<{ sha256: string; mediaType: string; languageHint: string | null }> = [];
  private readonly fixtures = new Map<string, SpeechFixture>();

  constructor(
    private readonly fallback: SpeechFixture = {
      text: 'Hi, this is a test voice note asking for a quote to fix a leaking tap.',
    },
  ) {}

  static audioKey(audio: Uint8Array): string {
    return createHash('sha256').update(audio).digest('hex');
  }

  addFixture(audio: Uint8Array, fixture: SpeechFixture): void {
    this.fixtures.set(MockSpeechToText.audioKey(audio), fixture);
  }

  async transcribe(input: TranscriptionInput): Promise<Transcript> {
    validateTranscriptionInput(input, this.destination.provider);
    const sha256 = MockSpeechToText.audioKey(input.audio);
    this.calls.push({
      sha256,
      mediaType: input.mediaType,
      languageHint: input.languageHint ?? null,
    });
    const fixture = this.fixtures.get(sha256) ?? this.fallback;
    const durationMs =
      fixture.durationMs ?? 1000 * Math.max(1, fixture.text.split(/\s+/).length / 3);
    return {
      text: fixture.text,
      segments: fixture.segments ?? [
        { startMs: 0, endMs: Math.round(durationMs), text: fixture.text, confidence: null },
      ],
      language: fixture.language ?? input.languageHint ?? 'en',
      provider: this.destination.provider,
      model: this.model,
      location: 'local',
      durationMs: Math.round(durationMs),
    };
  }
}
