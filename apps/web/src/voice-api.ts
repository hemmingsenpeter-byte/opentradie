/**
 * Voice note calls and types (Feature 1, ADR 0024). Kept beside api.ts so the shared module stays
 * small; it reuses the same request() rules (cookie session, Idempotency-Key, error shape).
 */
import { request } from './api';
import type { ActionProposal } from './types';

export type VoiceNoteStatus =
  | 'uploaded'
  | 'transcribing'
  | 'transcribed'
  | 'interpreting'
  | 'proposed'
  | 'needs_clarification'
  | 'failed';

export interface VoiceSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
  lowConfidence: boolean;
}

export interface VoiceCandidate {
  customerId: string;
  customerName: string;
  jobId: string;
  jobTitle: string;
  jobStatus: string;
  address: string | null;
}

export interface VoiceNote {
  id: string;
  status: VoiceNoteStatus;
  mediaType: string;
  sizeBytes: number;
  audioUrl: string;
  transcript: string | null;
  correctedTranscript: string | null;
  effectiveTranscript: string | null;
  correctedAt: string | null;
  correctedByName: string | null;
  provenance: {
    provider: string;
    model: string | null;
    location: 'local' | 'hosted' | null;
    durationMs: number | null;
    averageConfidence: number | null;
    synthetic: boolean;
  } | null;
  segments: VoiceSegment[];
  interpretationVersion: number;
  resolution: {
    status: string;
    customerId: string | null;
    customerName: string | null;
    jobId: string | null;
    jobTitle: string | null;
  };
  clarification: {
    questions: string[];
    candidates: VoiceCandidate[];
    rateOptions: Array<{ code: string; label: string }>;
    notices: string[];
  };
  error: { code: string; message: string } | null;
  createdAt: string;
  proposals?: ActionProposal[];
}

/** Statuses where the server is still working and the screen should poll. */
export const VOICE_WORKING: readonly VoiceNoteStatus[] = [
  'uploaded',
  'transcribing',
  'transcribed',
  'interpreting',
];

export const VOICE_MEDIA_TYPES = [
  'audio/m4a',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/webm',
  'audio/ogg',
] as const;
export const VOICE_MAX_BYTES = 10 * 1024 * 1024;

const ALIASES: Record<string, string> = {
  'audio/x-m4a': 'audio/m4a',
  'audio/aac': 'audio/m4a',
  'audio/mp3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'video/webm': 'audio/webm',
  'video/mp4': 'audio/mp4',
};
const EXTENSIONS: Record<string, string> = {
  m4a: 'audio/m4a',
  mp4: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
};

/** Container type without codec parameters, or '' when it is not a supported audio type. */
export function voiceMediaType(type: string, fileName = ''): string {
  const base = type.split(';')[0]!.trim().toLowerCase();
  const normalised = ALIASES[base] ?? base;
  if ((VOICE_MEDIA_TYPES as readonly string[]).includes(normalised)) return normalised;
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSIONS[extension] ?? '';
}

export const uploadVoiceNote = (
  input: { mediaType: string; dataBase64: string; fileName?: string; jobId?: string },
  idempotencyKey: string,
) => request<VoiceNote>('/api/voice-notes', { method: 'POST', body: input, idempotencyKey });

export const getVoiceNote = (id: string) =>
  request<VoiceNote>(`/api/voice-notes/${encodeURIComponent(id)}`);

export const listVoiceNotes = (jobId?: string) =>
  request<{ voiceNotes: VoiceNote[] }>(
    `/api/voice-notes?limit=5${jobId ? `&jobId=${encodeURIComponent(jobId)}` : ''}`,
  );

export const correctVoiceTranscript = (id: string, transcript: string) =>
  request<VoiceNote>(`/api/voice-notes/${encodeURIComponent(id)}/transcript`, {
    method: 'PATCH',
    body: { transcript },
  });

export const clarifyVoiceNote = (id: string, answer: { jobId?: string; rateCode?: string }) =>
  request<VoiceNote>(`/api/voice-notes/${encodeURIComponent(id)}/clarify`, {
    method: 'POST',
    body: answer,
  });
