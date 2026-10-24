import { createHash } from 'node:crypto';
import {
  AgentRuntimeError,
  runVoiceExtraction,
  type AgentRuntime,
  type VoiceExtraction,
} from '@opentradie/agent';
import {
  averageConfidence,
  checkJobTransition,
  decideModelUse,
  formatSignedCents,
  hoursToQuantityMilli,
  instantToLocal,
  LOW_CONFIDENCE_THRESHOLD,
  parseStatedAmountCents,
  parseToolCall,
  PolicyDeniedError,
  voiceReminderDueAt,
  resolveCustomer,
  type JobStatus,
  type VoiceNoteStatus,
} from '@opentradie/core';
import {
  recordAudit,
  transaction,
  type Database,
  type Queryable,
  type Transaction,
} from '@opentradie/database';
import {
  isIntegrationError,
  transcribeWithPolicy,
  type SpeechToText,
} from '@opentradie/integrations/speech';
import {
  PermanentTaskError,
  type FileStore,
  type PostgresJobQueue,
  type RuntimeConfig,
  type TaskHandler,
} from '@opentradie/platform';
import { HttpError, iso } from '../http.js';
import { createProposal, listProposalsBySource, type ProposalDto } from '../tools/proposals.js';
import { agentHealthWithTimeout } from './agent-info.js';
import { loadBusiness } from './records.js';

/**
 * Voice notes (ADR 0024): audio → transcript (speech adapter behind the privacy gate) →
 * structured extraction (agent runtime, strict schema) → server-side resolution of customer,
 * job, rates, dates and cents → pending action proposals. Nothing here executes a proposal.
 * Transcripts and audio are customer data: they are stored, never logged or audited.
 */

export const VOICE_MEDIA_TYPES = [
  'audio/m4a',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/webm',
  'audio/ogg',
] as const;
export type VoiceMediaType = (typeof VOICE_MEDIA_TYPES)[number];
/** Decoded audio limit; about 10 minutes of compressed speech. */
export const VOICE_MAX_BYTES = 10 * 1024 * 1024;
export const VOICE_BODY_LIMIT = Math.ceil(VOICE_MAX_BYTES / 3) * 4 + 8192;

const ascii = (bytes: Buffer, start: number, end: number) =>
  bytes.subarray(start, end).toString('latin1');

/** The leading bytes must match the declared audio container. */
export function audioMatchesMediaType(bytes: Buffer, mediaType: VoiceMediaType): boolean {
  switch (mediaType) {
    case 'audio/wav':
      return bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE';
    case 'audio/ogg':
      return bytes.length >= 4 && ascii(bytes, 0, 4) === 'OggS';
    case 'audio/webm':
      return (
        bytes.length >= 4 &&
        bytes[0] === 0x1a &&
        bytes[1] === 0x45 &&
        bytes[2] === 0xdf &&
        bytes[3] === 0xa3
      );
    case 'audio/mpeg':
      return (
        (bytes.length >= 3 && ascii(bytes, 0, 3) === 'ID3') ||
        (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
      );
    case 'audio/mp4':
    case 'audio/m4a':
      return bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp';
  }
}

export const VOICE_EXTENSIONS: Record<VoiceMediaType, string> = {
  'audio/m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
};

const ERROR_MESSAGES: Record<string, string> = {
  SPEECH_NOT_CONFIGURED:
    'Speech-to-text is not set up on this installation. Type what you said into the transcript instead.',
  MODEL_POLICY_DENIED:
    'Your privacy mode (Local only) blocks the configured speech or assistant service because it is hosted. Nothing was sent. Type the transcript, or change the speech service.',
  MODEL_APPROVAL_REQUIRED:
    'Sending this audio to a hosted service needs your approval first. Nothing was sent.',
  SPEECH_FAILED:
    'The speech service could not transcribe this recording. Type the transcript instead.',
  SPEECH_UNAVAILABLE: 'The speech service was unavailable. Try again later or type the transcript.',
  AUDIO_UNREADABLE: 'The stored recording could not be read.',
  AGENT_UNAVAILABLE:
    'The assistant could not read this transcript. Act on it yourself, or try again by correcting the transcript.',
  AGENT_INVALID_OUTPUT:
    'The assistant returned something invalid, so nothing was proposed. Correct the transcript to try again.',
};

export interface ClarificationCandidate {
  customerId: string;
  customerName: string;
  jobId: string;
  jobTitle: string;
  jobStatus: string;
  address: string | null;
}

export interface Clarification {
  questions: string[];
  candidates: ClarificationCandidate[];
  rateOptions: Array<{ code: string; label: string }>;
  notices: string[];
}

interface VoiceNoteRow {
  id: string;
  status: VoiceNoteStatus;
  mediaType: string;
  sizeBytes: number;
  documentId: string;
  storageKey: string;
  sha256: string;
  transcript: string | null;
  transcriptProvider: string | null;
  transcriptModel: string | null;
  transcriptLocation: 'local' | 'hosted' | null;
  transcriptLanguage: string | null;
  durationMs: number | null;
  avgConfidence: string | null;
  segments: Array<{
    startMs: number;
    endMs: number;
    text: string;
    confidence: number | null;
    lowConfidence: boolean;
  }>;
  transcribedAt: Date | null;
  correctedTranscript: string | null;
  correctedAt: Date | null;
  correctedByName: string | null;
  interpretationVersion: number;
  resolvedCustomerId: string | null;
  resolvedCustomerName: string | null;
  resolvedJobId: string | null;
  resolvedJobTitle: string | null;
  resolutionStatus: string;
  labourRateCode: string | null;
  clarification: Partial<Clarification>;
  interpretedBy: string | null;
  interpretedAt: Date | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = `v.id,v.status,v.media_type AS "mediaType",v.size_bytes AS "sizeBytes",v.document_id AS "documentId",
  d.storage_key AS "storageKey",d.sha256,v.transcript,v.transcript_provider AS "transcriptProvider",
  v.transcript_model AS "transcriptModel",v.transcript_location AS "transcriptLocation",
  v.transcript_language AS "transcriptLanguage",v.duration_ms AS "durationMs",v.avg_confidence AS "avgConfidence",
  v.segments,v.transcribed_at AS "transcribedAt",v.corrected_transcript AS "correctedTranscript",
  v.corrected_at AS "correctedAt",cu.display_name AS "correctedByName",
  v.interpretation_version AS "interpretationVersion",v.resolved_customer_id AS "resolvedCustomerId",
  c.name AS "resolvedCustomerName",v.resolved_job_id AS "resolvedJobId",j.title AS "resolvedJobTitle",
  v.resolution_status AS "resolutionStatus",v.labour_rate_code AS "labourRateCode",v.clarification,
  v.interpreted_by AS "interpretedBy",v.interpreted_at AS "interpretedAt",v.error_code AS "errorCode",
  v.created_at AS "createdAt",v.updated_at AS "updatedAt"`;
const FROM = `voice_notes v
  JOIN documents d ON d.tenant_id=v.tenant_id AND d.id=v.document_id
  LEFT JOIN users cu ON cu.tenant_id=v.tenant_id AND cu.id=v.corrected_by
  LEFT JOIN customers c ON c.tenant_id=v.tenant_id AND c.id=v.resolved_customer_id
  LEFT JOIN jobs j ON j.tenant_id=v.tenant_id AND j.id=v.resolved_job_id`;

export async function getVoiceNoteRow(
  client: Queryable,
  tenantId: string,
  id: string,
  lock = false,
): Promise<VoiceNoteRow> {
  const found = await client.query<VoiceNoteRow>(
    `SELECT ${COLUMNS} FROM ${FROM} WHERE v.tenant_id=$1 AND v.id=$2${lock ? ' FOR UPDATE OF v' : ''}`,
    [tenantId, id],
  );
  if (!found.rows[0]) throw new HttpError(404, 'VOICE_NOTE_NOT_FOUND', 'Voice note not found.');
  return found.rows[0];
}

export function voiceNoteDto(row: VoiceNoteRow, proposals?: ProposalDto[]) {
  const clarification: Clarification = {
    questions: row.clarification.questions ?? [],
    candidates: row.clarification.candidates ?? [],
    rateOptions: row.clarification.rateOptions ?? [],
    notices: row.clarification.notices ?? [],
  };
  return {
    id: row.id,
    status: row.status,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
    documentId: row.documentId,
    audioUrl: `/api/documents/${row.documentId}/content`,
    transcript: row.transcript,
    correctedTranscript: row.correctedTranscript,
    effectiveTranscript: row.correctedTranscript ?? row.transcript,
    correctedAt: iso(row.correctedAt),
    correctedByName: row.correctedByName,
    provenance: row.transcriptProvider
      ? {
          provider: row.transcriptProvider,
          model: row.transcriptModel,
          location: row.transcriptLocation,
          language: row.transcriptLanguage,
          durationMs: row.durationMs,
          averageConfidence: row.avgConfidence === null ? null : Number(row.avgConfidence),
          transcribedAt: iso(row.transcribedAt),
          /** The mock transcriber is never evidence of a working speech integration. */
          synthetic: row.transcriptProvider === 'mock',
        }
      : null,
    segments: row.segments,
    interpretationVersion: row.interpretationVersion,
    resolution: {
      status: row.resolutionStatus,
      customerId: row.resolvedCustomerId,
      customerName: row.resolvedCustomerName,
      jobId: row.resolvedJobId,
      jobTitle: row.resolvedJobTitle,
      labourRateCode: row.labourRateCode,
    },
    clarification,
    interpretedBy: row.interpretedBy,
    interpretedAt: iso(row.interpretedAt),
    error: row.errorCode
      ? {
          code: row.errorCode,
          message:
            ERROR_MESSAGES[row.errorCode] ?? 'Processing failed. Type the transcript instead.',
        }
      : null,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
    ...(proposals ? { proposals } : {}),
  };
}
export type VoiceNoteDto = ReturnType<typeof voiceNoteDto>;

export async function listVoiceNotes(
  client: Queryable,
  tenantId: string,
  filter: { jobId?: string | undefined; limit: number },
): Promise<VoiceNoteDto[]> {
  const result = await client.query<VoiceNoteRow>(
    `SELECT ${COLUMNS} FROM ${FROM} WHERE v.tenant_id=$1 AND ($2::uuid IS NULL OR v.resolved_job_id=$2)
     ORDER BY v.created_at DESC LIMIT $3`,
    [tenantId, filter.jobId ?? null, filter.limit],
  );
  return result.rows.map((row) => voiceNoteDto(row));
}

export async function voiceNoteWithProposals(client: Queryable, tenantId: string, id: string) {
  const row = await getVoiceNoteRow(client, tenantId, id);
  return voiceNoteDto(row, await listProposalsBySource(client, tenantId, 'voice', id));
}

/** Enqueue (or re-use) the interpretation task for one transcript version. */
export function enqueueInterpretation(
  queue: PostgresJobQueue,
  client: Queryable,
  tenantId: string,
  id: string,
  version: number,
) {
  return queue.enqueue(
    {
      tenantId,
      kind: 'voice.interpret',
      payload: { voiceNoteId: id, version },
      idempotencyKey: `voice:${id}:v${version}`,
      maxAttempts: 3,
    },
    client,
  );
}

/** Pending (or failed) proposals from an older version of this note can no longer be approved. */
export async function supersedeVoiceProposals(
  client: Transaction,
  input: {
    tenantId: string;
    voiceNoteId: string;
    userId: string;
    requestId: string;
    reason: string;
  },
): Promise<number> {
  const updated = await client.query<{ id: string }>(
    `UPDATE action_proposals SET status='superseded',decided_by_type='user',decided_by=$3,decided_at=now(),
       decision_reason=$4,updated_at=now()
     WHERE tenant_id=$1 AND source='voice' AND source_ref=$2 AND status IN ('pending','failed') RETURNING id`,
    [input.tenantId, input.voiceNoteId, input.userId, input.reason],
  );
  if (updated.rowCount)
    await recordAudit(client, {
      tenantId: input.tenantId,
      actorType: 'user',
      actorId: input.userId,
      action: 'voice_note.proposals_superseded',
      entityType: 'voice_note',
      entityId: input.voiceNoteId,
      requestId: input.requestId,
      metadata: { proposalIds: updated.rows.map((row) => row.id) },
    });
  return updated.rowCount ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------------------------

export interface VoiceDependencies {
  db: Database;
  runtime: AgentRuntime;
  config: RuntimeConfig;
  fileStore: FileStore;
  /** Null when SPEECH_PROVIDER=none: transcription fails visibly, the owner can type instead. */
  speech: SpeechToText | null;
  queue: PostgresJobQueue;
}

async function failVoiceNote(
  client: Queryable,
  tenantId: string,
  id: string,
  code: string,
  requestId: string,
  version?: number,
): Promise<void> {
  const updated = await client.query(
    `UPDATE voice_notes SET status='failed',error_code=$3,updated_at=now()
     WHERE tenant_id=$1 AND id=$2 AND ($4::integer IS NULL OR interpretation_version=$4)`,
    [tenantId, id, code, version ?? null],
  );
  if (updated.rowCount)
    await recordAudit(client, {
      tenantId,
      actorType: 'system',
      actorId: null,
      action: 'voice_note.failed',
      entityType: 'voice_note',
      entityId: id,
      requestId,
      metadata: { code },
    });
}

export async function transcribeVoiceNote(
  deps: VoiceDependencies,
  tenantId: string,
  id: string,
  requestId: string,
  finalAttempt = true,
): Promise<'transcribed' | 'skipped' | 'failed'> {
  const { db, config, fileStore, speech, queue } = deps;
  const note = await getVoiceNoteRow(db.pool, tenantId, id).catch((error: unknown) => {
    if (error instanceof HttpError)
      throw new PermanentTaskError('Voice note not found for this tenant.');
    throw error;
  });
  if (note.status !== 'uploaded' && note.status !== 'transcribing') return 'skipped';
  if (!speech) {
    await failVoiceNote(db.pool, tenantId, id, 'SPEECH_NOT_CONFIGURED', requestId);
    return 'failed';
  }
  await db.pool.query(
    "UPDATE voice_notes SET status='transcribing',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('uploaded','transcribing')",
    [tenantId, id],
  );
  const audio = await fileStore.get(note.storageKey);
  if (createHash('sha256').update(audio).digest('hex') !== note.sha256) {
    await failVoiceNote(db.pool, tenantId, id, 'AUDIO_UNREADABLE', requestId);
    return 'failed';
  }
  let transcript;
  try {
    // The privacy decision is made inside transcribeWithPolicy before any byte is sent. A denial
    // is final: no other provider is tried.
    ({ transcript } = await transcribeWithPolicy(
      { mode: config.privacyMode, dataCategories: ['communication_text'] },
      speech,
      { audio: new Uint8Array(audio), mediaType: note.mediaType },
    ));
  } catch (error) {
    if (error instanceof PolicyDeniedError) {
      await transaction(db, async (client) => {
        await failVoiceNote(client, tenantId, id, error.code, requestId);
        await recordAudit(client, {
          tenantId,
          actorType: 'system',
          actorId: null,
          action: 'model.policy_denied',
          entityType: 'voice_note',
          entityId: id,
          requestId,
          metadata: {
            purpose: 'speech_transcription',
            reason: error.decision.reason,
            provider: error.decision.destination.provider,
            mode: error.decision.mode,
          },
        });
      });
      return 'failed';
    }
    if (isIntegrationError(error)) {
      if (error.retryable && !finalAttempt)
        throw new Error('Speech service temporarily unavailable.', { cause: error });
      await failVoiceNote(
        db.pool,
        tenantId,
        id,
        error.retryable ? 'SPEECH_UNAVAILABLE' : 'SPEECH_FAILED',
        requestId,
      );
      return 'failed';
    }
    throw error;
  }
  const segments = transcript.segments.slice(0, 500).map((segment) => ({
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text.slice(0, 2000),
    confidence: segment.confidence,
    lowConfidence: segment.confidence !== null && segment.confidence < LOW_CONFIDENCE_THRESHOLD,
  }));
  return transaction(db, async (client) => {
    const locked = await getVoiceNoteRow(client, tenantId, id, true);
    if (locked.status !== 'transcribing') return 'skipped';
    await client.query(
      `UPDATE voice_notes SET status='transcribed',transcript=$3,transcript_provider=$4,transcript_model=$5,
         transcript_location=$6,transcript_language=$7,duration_ms=$8,avg_confidence=$9,segments=$10,
         transcribed_at=now(),error_code=NULL,updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [
        tenantId,
        id,
        transcript.text.slice(0, 20_000),
        transcript.provider.slice(0, 200),
        transcript.model.slice(0, 200),
        transcript.location,
        transcript.language?.slice(0, 16) ?? null,
        transcript.durationMs,
        averageConfidence(segments),
        JSON.stringify(segments),
      ],
    );
    await enqueueInterpretation(queue, client, tenantId, id, locked.interpretationVersion);
    await recordAudit(client, {
      tenantId,
      actorType: 'system',
      actorId: null,
      action: 'voice_note.transcribed',
      entityType: 'voice_note',
      entityId: id,
      requestId,
      // Provenance only; never transcript text.
      metadata: {
        provider: transcript.provider,
        location: transcript.location,
        durationMs: transcript.durationMs,
        segments: segments.length,
        lowConfidenceSegments: segments.filter((segment) => segment.lowConfidence).length,
      },
    });
    return 'transcribed';
  });
}

// ---------------------------------------------------------------------------------------------
// Interpretation: extraction labels → server-resolved, validated proposals
// ---------------------------------------------------------------------------------------------

interface ResolvedJob {
  id: string;
  title: string;
  status: JobStatus;
  customerId: string;
  customerName: string;
}

const candidateColumns = `c.id AS "customerId",c.name AS "customerName",j.id AS "jobId",j.title AS "jobTitle",
  j.status AS "jobStatus",coalesce(nullif(btrim(j.site_address),''),concat_ws(', ',p.address_line1,p.suburb,p.city)) AS address`;
const candidateFrom = `jobs j JOIN customers c ON c.tenant_id=j.tenant_id AND c.id=j.customer_id
  LEFT JOIN properties p ON p.tenant_id=j.tenant_id AND p.id=j.property_id`;
const OPEN = "j.status NOT IN ('completed','cancelled')";

async function openJobCandidates(
  client: Queryable,
  tenantId: string,
  customerIds: string[] | null,
): Promise<ClarificationCandidate[]> {
  const result = await client.query<ClarificationCandidate>(
    `SELECT ${candidateColumns} FROM ${candidateFrom}
     WHERE j.tenant_id=$1 AND ${OPEN} AND ($2::uuid[] IS NULL OR j.customer_id = ANY($2::uuid[]))
     ORDER BY j.updated_at DESC LIMIT 20`,
    [tenantId, customerIds],
  );
  return result.rows.map((row) => ({ ...row, address: row.address || null }));
}

async function jobById(client: Queryable, tenantId: string, jobId: string): Promise<ResolvedJob> {
  const found = await client.query<ResolvedJob>(
    `SELECT j.id,j.title,j.status,j.customer_id AS "customerId",c.name AS "customerName"
     FROM jobs j JOIN customers c ON c.tenant_id=j.tenant_id AND c.id=j.customer_id WHERE j.tenant_id=$1 AND j.id=$2`,
    [tenantId, jobId],
  );
  if (!found.rows[0]) throw new HttpError(404, 'JOB_NOT_FOUND', 'Job not found.');
  return found.rows[0];
}

const quoted = (value: string) => `“${value.slice(0, 80)}”`;

type Resolution =
  | { kind: 'job'; job: ResolvedJob; status: 'job_hint' | 'owner_selected' | 'matched' }
  | {
      kind: 'clarify';
      status: 'ambiguous' | 'not_found';
      question: string;
      candidates: ClarificationCandidate[];
    };

/** Customer and job come from records only; ambiguity is never guessed away. */
async function resolveJob(
  client: Queryable,
  tenantId: string,
  note: VoiceNoteRow,
  extraction: VoiceExtraction,
): Promise<Resolution> {
  if (
    note.resolvedJobId &&
    (note.resolutionStatus === 'job_hint' || note.resolutionStatus === 'owner_selected')
  )
    return {
      kind: 'job',
      job: await jobById(client, tenantId, note.resolvedJobId),
      status: note.resolutionStatus,
    };
  const name = extraction.customer.name;
  if (!name)
    return {
      kind: 'clarify',
      status: 'not_found',
      question: 'Which customer and job is this voice note about?',
      candidates: await openJobCandidates(client, tenantId, null),
    };
  const customers = await client.query<{ id: string; name: string; preferredName: string | null }>(
    'SELECT id,name,preferred_name AS "preferredName" FROM customers WHERE tenant_id=$1 AND archived_at IS NULL',
    [tenantId],
  );
  const match = resolveCustomer(name, customers.rows);
  if (match.kind === 'none')
    return {
      kind: 'clarify',
      status: 'not_found',
      question: `No customer matches ${quoted(name)}. Which job is this about?`,
      candidates: await openJobCandidates(client, tenantId, null),
    };
  if (match.kind === 'ambiguous')
    return {
      kind: 'clarify',
      status: 'ambiguous',
      question: `${match.matches.length} customers match ${quoted(name)} (${match.matches
        .slice(0, 5)
        .map((customer) => customer.name)
        .join(', ')}). Which job is this about?`,
      candidates: await openJobCandidates(
        client,
        tenantId,
        match.matches.map((customer) => customer.id),
      ),
    };
  let jobs = await openJobCandidates(client, tenantId, [match.customer.id]);
  const words = (extraction.customer.addressWords ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
  if (words.length && jobs.length > 1) {
    const byAddress = jobs.filter((job) =>
      words.every((word) => (job.address ?? '').toLowerCase().includes(word)),
    );
    if (byAddress.length) jobs = byAddress;
  }
  if (jobs.length === 1)
    return { kind: 'job', job: await jobById(client, tenantId, jobs[0]!.jobId), status: 'matched' };
  return {
    kind: 'clarify',
    status: jobs.length ? 'ambiguous' : 'not_found',
    question: jobs.length
      ? `${match.customer.name} has ${jobs.length} open jobs. Which one is this about?`
      : `${match.customer.name} has no open jobs. Which job is this about?`,
    candidates: jobs.length ? jobs : await openJobCandidates(client, tenantId, null),
  };
}

interface PlannedCall {
  name: string;
  args: Record<string, unknown>;
}

type Plan =
  | {
      kind: 'clarify';
      resolution: Resolution & { kind: 'clarify' };
      job: null;
      clarification: Clarification;
    }
  | {
      kind: 'rate';
      job: ResolvedJob;
      resolutionStatus: string;
      clarification: Clarification;
    }
  | {
      kind: 'propose';
      job: ResolvedJob;
      resolutionStatus: string;
      calls: PlannedCall[];
      clarification: Clarification;
    };

/** Pure planning from records + extraction labels. Exported for tests. */
export async function planVoiceProposals(
  client: Queryable,
  tenantId: string,
  note: VoiceNoteRow,
  extraction: VoiceExtraction,
  transcript: string,
): Promise<Plan> {
  const empty: Clarification = { questions: [], candidates: [], rateOptions: [], notices: [] };
  const resolution = await resolveJob(client, tenantId, note, extraction);
  if (resolution.kind === 'clarify')
    return {
      kind: 'clarify',
      resolution,
      job: null,
      clarification: {
        ...empty,
        questions: [resolution.question],
        candidates: resolution.candidates,
      },
    };
  const { job } = resolution;
  const notices: string[] = [];
  const business = await loadBusiness(client, tenantId);
  const timeZone = business.timeZone;
  const recordedAt = note.createdAt.getTime();

  // Labour: an approved, active hourly rate. Several candidates are never guessed between.
  let rateCode: string | null = null;
  if (extraction.labour.length) {
    const hourly = (
      await client.query<{ code: string; label: string }>(
        "SELECT code,label FROM approved_rates WHERE tenant_id=$1 AND active=true AND unit='hour' ORDER BY code",
        [tenantId],
      )
    ).rows;
    const hints = extraction.labour
      .map((item) => item.rateHint?.toLowerCase().trim())
      .filter((hint): hint is string => Boolean(hint));
    const hinted = hints.length
      ? hourly.filter((rate) =>
          hints.every((hint) =>
            hint
              .split(/[^a-z0-9]+/)
              .filter(Boolean)
              .every((word) => `${rate.code} ${rate.label}`.toLowerCase().includes(word)),
          ),
        )
      : [];
    if (note.labourRateCode && hourly.some((rate) => rate.code === note.labourRateCode))
      rateCode = note.labourRateCode;
    else if (hinted.length === 1) rateCode = hinted[0]!.code;
    else if (hourly.length === 1 && !hints.length) rateCode = hourly[0]!.code;
    else if (hourly.length === 0)
      notices.push(
        'Time was mentioned, but there is no approved hourly rate. Add one in Settings, then record the time on the job.',
      );
    else
      return {
        kind: 'rate',
        job,
        resolutionStatus: resolution.status,
        clarification: {
          ...empty,
          questions: [
            hints.length
              ? `Which labour rate did you mean by ${quoted(hints.join(', '))}?`
              : 'Which labour rate should this time use?',
          ],
          rateOptions: hourly,
        },
      };
  }

  const calls: PlannedCall[] = [];
  calls.push({
    name: 'job.add_note',
    args: { jobId: job.id, text: `Voice note: ${transcript}`.slice(0, 4000) },
  });

  if (extraction.jobCompleted) {
    const check = checkJobTransition(job.status, 'completed');
    if (check.allowed)
      calls.push({ name: 'job.update_status', args: { jobId: job.id, status: 'completed' } });
    else
      notices.push(
        job.status === 'completed'
          ? 'The job is already completed.'
          : `The job is ${job.status.replace('_', ' ')}, so it cannot be marked complete directly. Update its status on the job card.`,
      );
  }

  const workDate = instantToLocal(recordedAt, timeZone).date;
  for (const item of extraction.labour) {
    const quantityMilli = hoursToQuantityMilli(item.hours);
    if (quantityMilli === null) {
      notices.push('A time entry could not be read as hours; record it on the job card.');
      continue;
    }
    if (rateCode)
      calls.push({
        name: 'job.record_time',
        args: {
          jobId: job.id,
          rateCode,
          quantityMilli,
          workDate,
          description: (item.description ?? 'Labour (from voice note)').slice(0, 500),
        },
      });
  }

  for (const item of extraction.materials) {
    const cents = parseStatedAmountCents(item.statedAmount);
    const quantity = item.quantity ?? 1;
    const clarifications: string[] = [];
    let reportedUnitCostCents: number | undefined;
    if (cents !== null && quantity === 1) {
      reportedUnitCostCents = cents;
      if (item.statedAs !== 'cost')
        clarifications.push(
          `${formatSignedCents(cents)} is recorded as the supplier cost (what you paid), not a sell price. The sell price comes from your markup.`,
        );
      if (business.defaultMaterialMarkupBasisPoints <= 0)
        clarifications.push('No default material markup is set. Choose the markup when approving.');
    } else if (item.statedAmount) {
      clarifications.push(
        cents === null
          ? `The amount ${quoted(item.statedAmount)} could not be read. Edit the proposal to enter the supplier cost.`
          : `${formatSignedCents(cents)} covers ${quantity} units. Edit the proposal to enter the cost per unit.`,
      );
    }
    calls.push({
      name: 'job.add_material',
      args: {
        jobId: job.id,
        description: item.description,
        unit: 'each',
        quantityMilli: quantity * 1000,
        ...(item.supplier ? { supplier: item.supplier } : {}),
        ...(reportedUnitCostCents !== undefined ? { reportedUnitCostCents } : {}),
        ...(clarifications.length ? { clarifications: clarifications.slice(0, 5) } : {}),
      },
    });
  }

  for (const action of extraction.actions) {
    if (action.type === 'prepare_invoice') {
      calls.push({ name: 'invoice.prepare', args: { jobId: job.id } });
      continue;
    }
    let dueAt: Date;
    try {
      dueAt = voiceReminderDueAt(recordedAt, timeZone, action.due);
    } catch {
      notices.push('A reminder date could not be worked out; add the reminder yourself.');
      continue;
    }
    // "Remind me to ..." is an owner to-do (ADR 0032): a task.create proposal, due at 9:00 am
    // business time on the date the server worked out (never a model-computed date).
    calls.push({
      name: 'task.create',
      args: {
        kind: /^(?:call|ring|phone)\b/i.test(action.text) ? 'call' : 'custom',
        title: action.text.slice(0, 200),
        jobId: job.id,
        dueAt: dueAt.toISOString(),
      },
    });
  }
  return {
    kind: 'propose',
    job,
    resolutionStatus: resolution.status,
    calls,
    clarification: { ...empty, notices },
  };
}

export async function interpretVoiceNote(
  deps: Pick<VoiceDependencies, 'db' | 'runtime' | 'config'>,
  tenantId: string,
  id: string,
  version: number,
  requestId: string,
  finalAttempt = true,
): Promise<'proposed' | 'needs_clarification' | 'stale' | 'skipped' | 'failed'> {
  const { db, runtime, config } = deps;
  const note = await getVoiceNoteRow(db.pool, tenantId, id).catch((error: unknown) => {
    if (error instanceof HttpError)
      throw new PermanentTaskError('Voice note not found for this tenant.');
    throw error;
  });
  if (note.interpretationVersion !== version) return 'stale';
  const transcript = (note.correctedTranscript ?? note.transcript)?.trim();
  if (!transcript || note.status === 'uploaded' || note.status === 'transcribing') return 'skipped';

  const health = await agentHealthWithTimeout(runtime, 10_000);
  if (!health || health.status !== 'ok') {
    if (!finalAttempt) throw new Error('Agent runtime unavailable.');
    await failVoiceNote(db.pool, tenantId, id, 'AGENT_UNAVAILABLE', requestId, version);
    return 'failed';
  }
  const decision = decideModelUse({
    mode: config.privacyMode,
    purpose: 'enquiry_interpretation',
    destination: {
      provider: health.provider,
      location: health.inferenceLocation,
      attestation: health.attestation,
    },
    dataCategories: ['job_notes', 'customer_names'],
  });
  if (!decision.allowed) {
    await transaction(db, async (client) => {
      await failVoiceNote(
        client,
        tenantId,
        id,
        new PolicyDeniedError(decision).code,
        requestId,
        version,
      );
      await recordAudit(client, {
        tenantId,
        actorType: 'system',
        actorId: null,
        action: 'model.policy_denied',
        entityType: 'voice_note',
        entityId: id,
        requestId,
        metadata: {
          purpose: 'enquiry_interpretation',
          reason: decision.reason,
          provider: decision.destination.provider,
          mode: decision.mode,
        },
      });
    });
    return 'failed';
  }
  await db.pool.query(
    "UPDATE voice_notes SET status='interpreting',error_code=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND interpretation_version=$3",
    [tenantId, id, version],
  );

  let extraction: VoiceExtraction;
  let synthetic: boolean;
  let runtimeName: string;
  try {
    ({
      extraction,
      synthetic,
      runtime: runtimeName,
    } = await runVoiceExtraction(runtime, {
      requestId: `voice-${id}-v${version}`,
      transcript: transcript.slice(0, 10_000),
    }));
  } catch (error) {
    if (error instanceof AgentRuntimeError) {
      await failVoiceNote(
        db.pool,
        tenantId,
        id,
        error.code === 'INVALID_OUTPUT' ? 'AGENT_INVALID_OUTPUT' : 'AGENT_UNAVAILABLE',
        requestId,
        version,
      );
      return 'failed';
    }
    throw error;
  }

  return transaction(db, async (client) => {
    const locked = await getVoiceNoteRow(client, tenantId, id, true);
    if (locked.interpretationVersion !== version) return 'stale';
    const plan = await planVoiceProposals(client, tenantId, locked, extraction, transcript);
    const update = (
      status: VoiceNoteStatus,
      resolutionStatus: string,
      jobId: string | null,
      customerId: string | null,
      clarification: Clarification,
    ) =>
      client.query(
        `UPDATE voice_notes SET status=$3,resolution_status=$4,resolved_job_id=$5,resolved_customer_id=$6,
           clarification=$7,interpreted_by=$8,interpreted_at=now(),error_code=NULL,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          tenantId,
          id,
          status,
          resolutionStatus,
          jobId,
          customerId,
          JSON.stringify(clarification),
          runtimeName,
        ],
      );
    if (plan.kind !== 'propose') {
      await update(
        'needs_clarification',
        plan.kind === 'clarify' ? plan.resolution.status : plan.resolutionStatus,
        plan.job?.id ?? null,
        plan.job?.customerId ?? null,
        plan.clarification,
      );
      await recordAudit(client, {
        tenantId,
        actorType: 'system',
        actorId: null,
        action: 'voice_note.needs_clarification',
        entityType: 'voice_note',
        entityId: id,
        requestId,
        metadata: {
          version,
          reason: plan.kind === 'clarify' ? plan.resolution.status : 'labour_rate',
          candidates: plan.clarification.candidates.length,
          synthetic,
        },
      });
      return 'needs_clarification';
    }
    const created: string[] = [];
    const refused: Array<{ tool: string; code: string }> = [];
    for (const [index, call] of plan.calls.slice(0, 20).entries()) {
      const parsed = parseToolCall(call.name, {
        ...call.args,
        idempotencyKey: `voice-${id}-v${version}-${index}-${call.name.replace('.', '_')}`,
      });
      if (!parsed.ok || parsed.tool.risk !== 'propose') {
        refused.push({ tool: call.name, code: parsed.ok ? 'NOT_A_PROPOSE_TOOL' : parsed.code });
        continue;
      }
      try {
        const { proposal } = await createProposal(client, {
          tenantId,
          requestId,
          tool: parsed.tool,
          payload: parsed.input,
          meta: parsed.meta,
          origin: { source: 'voice', sourceRef: id, createdByType: 'agent' },
          // Voice proposals always wait for the owner, even where notes may be auto-approved.
          allowAutoExecute: false,
        });
        created.push(proposal.id);
      } catch (error) {
        // describeProposal refuses before writing anything, so the transaction stays usable.
        if (!(error instanceof HttpError)) throw error;
        refused.push({ tool: call.name, code: error.code });
      }
    }
    const clarification = {
      ...plan.clarification,
      notices: [
        ...plan.clarification.notices,
        ...refused.map((item) => `A ${item.tool} proposal could not be created (${item.code}).`),
      ].slice(0, 10),
    };
    await update(
      'proposed',
      plan.resolutionStatus,
      plan.job.id,
      plan.job.customerId,
      clarification,
    );
    await recordAudit(client, {
      tenantId,
      actorType: 'system',
      actorId: null,
      action: 'voice_note.interpreted',
      entityType: 'voice_note',
      entityId: id,
      requestId,
      metadata: { version, proposals: created, refused, jobId: plan.job.id, synthetic },
    });
    return 'proposed';
  });
}

export function createVoiceTaskHandlers(deps: VoiceDependencies): Record<string, TaskHandler> {
  const idOf = (payload: Record<string, unknown>) => {
    const id = typeof payload.voiceNoteId === 'string' ? payload.voiceNoteId : '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PermanentTaskError('Invalid voice note id.');
    return id;
  };
  return {
    'voice.transcribe': async (task) => {
      await transcribeVoiceNote(
        deps,
        task.tenantId,
        idOf(task.payload),
        `task:${task.id}`,
        task.attempts >= task.maxAttempts,
      );
    },
    'voice.interpret': async (task) => {
      const version = Number(task.payload.version);
      if (!Number.isInteger(version) || version < 1)
        throw new PermanentTaskError('Invalid voice note version.');
      await interpretVoiceNote(
        deps,
        task.tenantId,
        idOf(task.payload),
        version,
        `task:${task.id}`,
        task.attempts >= task.maxAttempts,
      );
    },
  };
}
