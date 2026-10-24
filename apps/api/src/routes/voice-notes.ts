import { createHash, randomUUID } from 'node:crypto';
import { recordAudit } from '@opentradie/database';
import type { FileStore, PostgresJobQueue } from '@opentradie/platform';
import { z } from 'zod';
import { HttpError, type RouteRegistry } from '../http.js';
import { errorResponse, idParams } from '../schemas.js';
import { getJob } from '../services/records.js';
import {
  audioMatchesMediaType,
  enqueueInterpretation,
  getVoiceNoteRow,
  listVoiceNotes,
  supersedeVoiceProposals,
  VOICE_BODY_LIMIT,
  VOICE_EXTENSIONS,
  VOICE_MAX_BYTES,
  VOICE_MEDIA_TYPES,
  voiceNoteWithProposals,
} from '../services/voice-notes.js';

const uploadBody = z
  .object({
    fileName: z.string().trim().min(1).max(200).optional(),
    /** Container type without codec parameters (send "audio/webm", not "audio/webm;codecs=opus"). */
    mediaType: z.enum(VOICE_MEDIA_TYPES),
    /** Audio content, standard base64 without a data: prefix. */
    dataBase64: z
      .string()
      .min(4)
      .max(Math.ceil(VOICE_MAX_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Expected base64 content.'),
    /** Recorded from a job card: the job is known and no customer matching is needed. */
    jobId: z.string().uuid().optional(),
  })
  .strict();

const listQuery = z
  .object({
    jobId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

const correctionBody = z.object({ transcript: z.string().trim().min(1).max(10_000) }).strict();

const clarifyBody = z
  .object({
    jobId: z.string().uuid().optional(),
    /** An approved, active hourly rate when several labour rates could apply. */
    rateCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,63}$/)
      .optional(),
  })
  .strict()
  .refine((value) => value.jobId || value.rateCode, 'Choose a job or a labour rate.');

const voiceNoteResponse = z.object({
  id: z.string(),
  status: z.string(),
  transcript: z.string().nullable(),
  correctedTranscript: z.string().nullable(),
  effectiveTranscript: z.string().nullable(),
  proposals: z.array(z.record(z.string(), z.unknown())).optional(),
});

const BUSY = new Set(['uploaded', 'transcribing']);

/** Voice notes: upload audio, read transcripts, correct them and resolve clarifications. */
export function registerVoiceNoteRoutes(
  api: RouteRegistry,
  deps: { fileStore: FileStore; queue: PostgresJobQueue },
) {
  const { fileStore, queue } = deps;

  api.route(
    {
      method: 'POST',
      url: '/api/voice-notes',
      summary:
        'Upload a voice note (JSON with base64 audio: M4A/MP4, MP3, WAV, WebM or Ogg up to 10 MiB). It is transcribed and turned into pending proposals in the background; nothing is executed.',
      tags: ['voice'],
      auth: 'owner',
      idempotent: true,
      bodyLimit: VOICE_BODY_LIMIT,
      body: uploadBody,
      responses: {
        201: { description: 'Stored; transcription queued', schema: voiceNoteResponse },
        404: { description: 'JOB_NOT_FOUND', schema: errorResponse },
        413: { description: 'FILE_TOO_LARGE', schema: errorResponse },
        415: { description: 'UNSUPPORTED_MEDIA', schema: errorResponse },
      },
    },
    async ({ user, body, request, idempotent }) =>
      idempotent(async (client) => {
        const job = body.jobId ? await getJob(client, user.tenantId, body.jobId) : null;
        const bytes = Buffer.from(body.dataBase64, 'base64');
        if (bytes.length === 0)
          throw new HttpError(400, 'VALIDATION_ERROR', 'The recording is empty.');
        if (bytes.length > VOICE_MAX_BYTES)
          throw new HttpError(413, 'FILE_TOO_LARGE', 'Recordings can be up to 10 MiB.');
        if (!audioMatchesMediaType(bytes, body.mediaType))
          throw new HttpError(
            415,
            'UNSUPPORTED_MEDIA',
            'The file is not the audio type it claims to be. Record again or upload M4A, MP3, WAV, WebM or Ogg audio.',
          );
        const id = randomUUID();
        const documentId = randomUUID();
        const extension = VOICE_EXTENSIONS[body.mediaType];
        const key = `tenants/${user.tenantId}/voice-notes/${id}.${extension}`;
        const stored = await fileStore.put(key, bytes, { contentType: body.mediaType });
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (stored.sha256 !== sha256) throw new Error('Stored audio checksum mismatch.');
        // job_id stays NULL: the recording is not job evidence; the voice note links the job.
        await client.query(
          "INSERT INTO documents(id,tenant_id,customer_id,kind,storage_key,file_name,media_type,size_bytes,sha256) VALUES($1,$2,$3,'other',$4,$5,$6,$7,$8)",
          [
            documentId,
            user.tenantId,
            job?.customerId ?? null,
            key,
            `voice-note-${id.slice(0, 8)}.${extension}`,
            body.mediaType,
            bytes.length,
            sha256,
          ],
        );
        await client.query(
          `INSERT INTO voice_notes(id,tenant_id,uploaded_by,document_id,media_type,size_bytes,resolved_job_id,resolved_customer_id,resolution_status)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            user.tenantId,
            user.id,
            documentId,
            body.mediaType,
            bytes.length,
            job?.id ?? null,
            job?.customerId ?? null,
            job ? 'job_hint' : 'unresolved',
          ],
        );
        await queue.enqueue(
          {
            tenantId: user.tenantId,
            kind: 'voice.transcribe',
            payload: { voiceNoteId: id },
            idempotencyKey: `voice:${id}`,
            maxAttempts: 3,
          },
          client,
        );
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'voice_note.uploaded',
          entityType: 'voice_note',
          entityId: id,
          requestId: request.id,
          metadata: {
            documentId,
            mediaType: body.mediaType,
            sizeBytes: bytes.length,
            sha256,
            jobId: job?.id ?? null,
          },
        });
        return {
          status: 201,
          body: await voiceNoteWithProposals(client, user.tenantId, id),
        };
      }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/voice-notes',
      summary: 'Recent voice notes (optionally for one job)',
      tags: ['voice'],
      auth: 'user',
      query: listQuery,
      responses: { 200: { description: 'Voice notes, newest first' } },
    },
    async ({ user, query }) => ({
      body: { voiceNotes: await listVoiceNotes(api.pool, user.tenantId, query) },
    }),
  );

  api.route(
    {
      method: 'GET',
      url: '/api/voice-notes/:id',
      summary: 'One voice note with its transcript, provenance, clarifications and proposals',
      tags: ['voice'],
      auth: 'user',
      params: idParams,
      responses: {
        200: { description: 'Voice note', schema: voiceNoteResponse },
        404: { description: 'Not found (including other tenants)', schema: errorResponse },
      },
    },
    async ({ user, params }) => ({
      body: await voiceNoteWithProposals(api.pool, user.tenantId, params.id),
    }),
  );

  api.route(
    {
      method: 'PATCH',
      url: '/api/voice-notes/:id/transcript',
      summary:
        'Owner corrects the transcript. Pending proposals from this note are superseded and it is interpreted again.',
      tags: ['voice'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: correctionBody,
      responses: {
        200: { description: 'Corrected; interpretation queued', schema: voiceNoteResponse },
        404: { description: 'Not found', schema: errorResponse },
        409: { description: 'VOICE_NOTE_BUSY: still transcribing', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const note = await getVoiceNoteRow(client, user.tenantId, params.id, true);
        if (BUSY.has(note.status) && !note.errorCode)
          throw new HttpError(
            409,
            'VOICE_NOTE_BUSY',
            'This recording is still being transcribed. Try again in a moment.',
          );
        const version = note.interpretationVersion + 1;
        await client.query(
          `UPDATE voice_notes SET corrected_transcript=$3,corrected_by=$4,corrected_at=now(),interpretation_version=$5,
             status='interpreting',error_code=NULL,clarification='{}',updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [user.tenantId, note.id, body.transcript, user.id, version],
        );
        const superseded = await supersedeVoiceProposals(client, {
          tenantId: user.tenantId,
          voiceNoteId: note.id,
          userId: user.id,
          requestId: request.id,
          reason: 'Transcript corrected',
        });
        await enqueueInterpretation(queue, client, user.tenantId, note.id, version);
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'voice_note.transcript_corrected',
          entityType: 'voice_note',
          entityId: note.id,
          requestId: request.id,
          // Lengths only; never the transcript.
          metadata: { version, superseded, length: body.transcript.length },
        });
        return { body: await voiceNoteWithProposals(client, user.tenantId, note.id) };
      }),
  );

  api.route(
    {
      method: 'POST',
      url: '/api/voice-notes/:id/clarify',
      summary:
        'Owner answers a clarification (which job, which labour rate). Pending proposals are superseded and the note is interpreted again.',
      tags: ['voice'],
      auth: 'owner',
      idempotent: true,
      params: idParams,
      body: clarifyBody,
      responses: {
        200: { description: 'Clarified; interpretation queued', schema: voiceNoteResponse },
        404: { description: 'Voice note or job not found', schema: errorResponse },
        409: { description: 'VOICE_NOTE_BUSY', schema: errorResponse },
        422: { description: 'RATE_NOT_APPROVED', schema: errorResponse },
      },
    },
    async ({ user, params, body, request, idempotent }) =>
      idempotent(async (client) => {
        const note = await getVoiceNoteRow(client, user.tenantId, params.id, true);
        if (BUSY.has(note.status) || !(note.correctedTranscript ?? note.transcript))
          throw new HttpError(
            409,
            'VOICE_NOTE_BUSY',
            'There is no transcript to act on yet. Wait for it, or type it in.',
          );
        const job = body.jobId ? await getJob(client, user.tenantId, body.jobId) : null;
        if (body.rateCode) {
          const rate = await client.query(
            "SELECT 1 FROM approved_rates WHERE tenant_id=$1 AND code=$2 AND active=true AND unit='hour'",
            [user.tenantId, body.rateCode],
          );
          if (!rate.rowCount)
            throw new HttpError(
              422,
              'RATE_NOT_APPROVED',
              'Choose an approved, active hourly rate.',
            );
        }
        const version = note.interpretationVersion + 1;
        await client.query(
          `UPDATE voice_notes SET interpretation_version=$3,status='interpreting',error_code=NULL,clarification='{}',
             resolved_job_id=coalesce($4,resolved_job_id),resolved_customer_id=coalesce($5,resolved_customer_id),
             resolution_status=CASE WHEN $4::uuid IS NULL THEN resolution_status ELSE 'owner_selected' END,
             labour_rate_code=coalesce($6,labour_rate_code),updated_at=now()
           WHERE tenant_id=$1 AND id=$2`,
          [
            user.tenantId,
            note.id,
            version,
            job?.id ?? null,
            job?.customerId ?? null,
            body.rateCode ?? null,
          ],
        );
        // A job picked for a rate-only answer was already resolved by the server; keep it fixed.
        if (!job && note.resolvedJobId)
          await client.query(
            "UPDATE voice_notes SET resolution_status='owner_selected' WHERE tenant_id=$1 AND id=$2",
            [user.tenantId, note.id],
          );
        const superseded = await supersedeVoiceProposals(client, {
          tenantId: user.tenantId,
          voiceNoteId: note.id,
          userId: user.id,
          requestId: request.id,
          reason: 'Voice note clarified',
        });
        await enqueueInterpretation(queue, client, user.tenantId, note.id, version);
        await recordAudit(client, {
          tenantId: user.tenantId,
          actorType: 'user',
          actorId: user.id,
          action: 'voice_note.clarified',
          entityType: 'voice_note',
          entityId: note.id,
          requestId: request.id,
          metadata: {
            version,
            superseded,
            jobId: job?.id ?? null,
            rateCode: body.rateCode ?? null,
          },
        });
        return { body: await voiceNoteWithProposals(client, user.tenantId, note.id) };
      }),
  );
}
