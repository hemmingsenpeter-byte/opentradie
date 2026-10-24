import {
  assertModelUse,
  type DataCategory,
  type ModelDestination,
  type ModelUseApproval,
  type PolicyDecision,
  type PrivacyMode,
} from '@opentradie/core';
import { ValidationError } from '../errors.js';

export interface TranscriptionInput {
  audio: Uint8Array;
  /** e.g. "audio/wav". whisper.cpp's server reads WAV unless started with --convert (needs ffmpeg). */
  mediaType: string;
  /** ISO 639-1 code such as "en"; omitted lets the server decide. */
  languageHint?: string | null;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  /** 0..1 where the provider reports it (word probabilities or exp(avg_logprob)); otherwise null. */
  confidence: number | null;
}

export interface Transcript {
  text: string;
  segments: TranscriptSegment[];
  language: string | null;
  provider: string;
  model: string;
  location: 'local' | 'hosted';
  durationMs: number | null;
}

export interface SpeechToText {
  /** Where audio is sent. Location is derived from the endpoint URL, never from a label. */
  readonly destination: ModelDestination;
  readonly model: string;
  /** "mock" providers are never evidence of a working speech integration. */
  readonly kind: 'provider' | 'mock';
  transcribe(input: TranscriptionInput, signal?: AbortSignal): Promise<Transcript>;
}

export const SUPPORTED_AUDIO_TYPES = [
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mpeg',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
] as const;

export const DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export function validateTranscriptionInput(
  input: TranscriptionInput,
  provider: string,
  maxBytes = DEFAULT_MAX_AUDIO_BYTES,
): void {
  const issues: string[] = [];
  if (!(input.audio instanceof Uint8Array) || input.audio.byteLength === 0)
    issues.push('audio is empty.');
  else if (input.audio.byteLength > maxBytes) issues.push(`audio exceeds ${maxBytes} bytes.`);
  if (!(SUPPORTED_AUDIO_TYPES as readonly string[]).includes(input.mediaType?.toLowerCase()))
    issues.push('mediaType is not a supported audio type.');
  if (input.languageHint && !/^[a-z]{2,3}$/.test(input.languageHint))
    issues.push('languageHint must be an ISO 639 code such as "en".');
  if (issues.length)
    throw new ValidationError('Audio input is invalid.', 'audio', provider, issues);
}

/**
 * The only supported way to transcribe business audio. The privacy decision is made before any
 * byte leaves the process: LOCAL_ONLY rejects every hosted or unverified destination with
 * PolicyDeniedError and no other provider is tried.
 *
 * core's ModelPurpose has no transcription purpose yet, so this uses "enquiry_interpretation"
 * (voice notes are enquiry content). Approvals remain scoped to the speech provider's label.
 */
export async function transcribeWithPolicy(
  context: {
    mode: PrivacyMode;
    dataCategories?: readonly DataCategory[];
    approval?: ModelUseApproval | null;
  },
  provider: SpeechToText,
  input: TranscriptionInput,
  signal?: AbortSignal,
): Promise<{ transcript: Transcript; decision: PolicyDecision }> {
  const decision = assertModelUse({
    mode: context.mode,
    purpose: 'enquiry_interpretation',
    destination: provider.destination,
    dataCategories: context.dataCategories ?? ['communication_text'],
    approval: context.approval ?? null,
  });
  const transcript = await provider.transcribe(input, signal);
  return { transcript, decision };
}
