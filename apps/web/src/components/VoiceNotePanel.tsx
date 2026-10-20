import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { newIdempotencyKey } from '../api';
import { href } from '../router';
import {
  clarifyVoiceNote,
  correctVoiceTranscript,
  getVoiceNote,
  listVoiceNotes,
  uploadVoiceNote,
  VOICE_MAX_BYTES,
  VOICE_WORKING,
  voiceMediaType,
  type VoiceNote,
} from '../voice-api';
import { useWorkspace } from '../workspace';
import { Icon } from './Icons';
import {
  Button,
  ErrorNotice,
  Notice,
  Pill,
  Section,
  SelectField,
  TextArea,
  ViewOnlyNote,
} from './ui';
import type { Tone } from './ui';

const STATUS_LABEL: Record<VoiceNote['status'], string> = {
  uploaded: 'Uploaded',
  transcribing: 'Transcribing…',
  transcribed: 'Transcribed',
  interpreting: 'Reading the note…',
  proposed: 'Proposals ready',
  needs_clarification: 'Needs your answer',
  failed: 'Needs attention',
};
const STATUS_TONE: Record<VoiceNote['status'], Tone> = {
  uploaded: 'info',
  transcribing: 'info',
  transcribed: 'info',
  interpreting: 'info',
  proposed: 'approved',
  needs_clarification: 'draft',
  failed: 'rejected',
};

function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(new Error('The recording could not be read.'));
    reader.readAsDataURL(blob);
  });
}

function canRecord(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder === 'function' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

/**
 * Record or upload a voice update. The server transcribes it, reads it with the assistant and
 * proposes job updates for the owner to approve; nothing changes until they are approved.
 */
export function VoiceNotePanel({
  jobId,
  title = 'Voice update',
  onChanged,
}: {
  jobId?: string;
  title?: string;
  onChanged?: () => void | Promise<void>;
}) {
  const { isOwner } = useWorkspace();
  const [notes, setNotes] = useState<VoiceNote[]>([]);
  const [current, setCurrent] = useState<VoiceNote | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  const refreshList = useCallback(async () => {
    try {
      setNotes((await listVoiceNotes(jobId)).voiceNotes);
    } catch {
      // The list is a convenience; the current note still shows.
    }
  }, [jobId]);
  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // Poll while the server is working on the current note.
  const currentId = current?.id;
  const working = current ? VOICE_WORKING.includes(current.status) : false;
  useEffect(() => {
    if (!currentId || !working) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void getVoiceNote(currentId)
        .then((note) => {
          if (cancelled) return;
          setCurrent(note);
          if (!VOICE_WORKING.includes(note.status)) {
            void refreshList();
            void onChanged?.();
          }
        })
        .catch(() => undefined);
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [currentId, working, refreshList, onChanged]);

  async function send(blob: Blob, fileName: string) {
    setError(null);
    const mediaType = voiceMediaType(blob.type, fileName);
    if (!mediaType) {
      setError(new Error('Choose an M4A, MP3, WAV, WebM or Ogg recording.'));
      return;
    }
    if (blob.size > VOICE_MAX_BYTES) {
      setError(new Error('Recordings can be up to 10 MB (about 10 minutes).'));
      return;
    }
    setBusy(true);
    try {
      const note = await uploadVoiceNote(
        {
          mediaType,
          dataBase64: await readBase64(blob),
          fileName: fileName.slice(0, 200) || 'voice-note',
          ...(jobId ? { jobId } : {}),
        },
        newIdempotencyKey(),
      );
      setCurrent(note);
      void refreshList();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file) await send(file, file.name);
    input.value = '';
  }

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const media = new MediaRecorder(stream);
      chunks.current = [];
      media.ondataavailable = (event) => {
        if (event.data.size) chunks.current.push(event.data);
      };
      media.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks.current, { type: media.mimeType || 'audio/webm' });
        void send(blob, `voice-note.${blob.type.includes('mp4') ? 'm4a' : 'webm'}`);
      };
      recorder.current = media;
      media.start();
      setRecording(true);
    } catch {
      setError(
        new Error(
          'The microphone is not available. Allow microphone access or upload a recording.',
        ),
      );
    }
  }

  function stopRecording() {
    recorder.current?.stop();
    recorder.current = null;
    setRecording(false);
  }

  const replace = (note: VoiceNote) => {
    setCurrent(note);
    void refreshList();
  };
  const shown = current ?? notes[0] ?? null;
  const earlier = notes.filter((note) => note.id !== shown?.id);

  return (
    <Section title={title}>
      <div className="grid gap-4" data-testid="voice-panel">
        <p className="row-sub">
          Say what you did: hours, materials and what to do next. The assistant proposes the
          updates; nothing changes until you approve them.
        </p>
        {error !== null && <ErrorNotice title="Voice note not added" error={error} />}
        {isOwner ? (
          <div className="flex flex-wrap gap-3">
            {canRecord() &&
              (recording ? (
                <Button variant="stop" icon="mic" onClick={stopRecording}>
                  Stop and send
                </Button>
              ) : (
                <Button
                  variant="primary"
                  icon="mic"
                  busy={busy}
                  disabled={busy}
                  onClick={() => void startRecording()}
                >
                  Record update
                </Button>
              ))}
            <label className={`btn btn-secondary upload ${busy ? 'is-busy' : ''}`}>
              {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="plus" />}
              <span>{busy ? 'Uploading…' : 'Upload a recording'}</span>
              <input
                type="file"
                className="sr-only"
                accept="audio/*"
                capture
                disabled={busy || recording}
                onChange={(event) => void onFile(event)}
                data-testid="voice-input"
              />
            </label>
          </div>
        ) : (
          <ViewOnlyNote />
        )}
        {shown && <VoiceNoteCard note={shown} onUpdated={replace} isOwner={isOwner} />}
        {earlier.length > 0 && (
          <details>
            <summary className="text-link">Earlier voice notes ({earlier.length})</summary>
            <ul className="rows mt-2">
              {earlier.map((note) => (
                <li key={note.id}>
                  <button
                    type="button"
                    className="text-link text-left"
                    onClick={() => void getVoiceNote(note.id).then(setCurrent)}
                  >
                    {new Date(note.createdAt).toLocaleString()} · {STATUS_LABEL[note.status]}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Section>
  );
}

function Transcript({ note }: { note: VoiceNote }) {
  if (note.correctedTranscript)
    return (
      <p className="note-text" data-testid="voice-transcript">
        {note.correctedTranscript}
        <span className="row-sub block">
          Corrected{note.correctedByName ? ` by ${note.correctedByName}` : ''}
        </span>
      </p>
    );
  if (!note.transcript) return null;
  if (!note.segments.length)
    return (
      <p className="note-text" data-testid="voice-transcript">
        {note.transcript}
      </p>
    );
  return (
    <p className="note-text" data-testid="voice-transcript">
      {note.segments.map((segment, index) => (
        <span key={`${segment.startMs}-${index}`}>
          {index > 0 && ' '}
          {segment.lowConfidence ? (
            <mark
              className="rounded bg-amber-200 px-0.5 text-inherit"
              title="The speech service was unsure about these words. Check them."
              data-testid="low-confidence"
            >
              {segment.text}
            </mark>
          ) : (
            segment.text
          )}
        </span>
      ))}
    </p>
  );
}

function VoiceNoteCard({
  note,
  onUpdated,
  isOwner,
}: {
  note: VoiceNote;
  onUpdated: (note: VoiceNote) => void;
  isOwner: boolean;
}) {
  const [full, setFull] = useState<VoiceNote>(note);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [jobChoice, setJobChoice] = useState('');
  const [rateChoice, setRateChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // List entries carry no proposals; fetch the full note when needed.
  useEffect(() => {
    if (note.proposals) setFull(note);
    else
      void getVoiceNote(note.id)
        .then(setFull)
        .catch(() => setFull(note));
  }, [note]);

  async function run(action: () => Promise<VoiceNote>) {
    setBusy(true);
    setError(null);
    try {
      const updated = await action();
      setEditing(false);
      onUpdated(updated);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const proposals = full.proposals ?? [];
  const pending = proposals.filter((proposal) => proposal.status === 'pending');
  const lowConfidence = full.segments.some((segment) => segment.lowConfidence);
  const { clarification } = full;
  return (
    <article className="grid gap-3" aria-label="Voice note" data-testid="voice-note">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={STATUS_TONE[full.status]}>
          <span data-testid="voice-status">{STATUS_LABEL[full.status]}</span>
        </Pill>
        {full.provenance?.synthetic && (
          <span className="pill pill-mock" title="Fixed demo transcript, not real speech-to-text.">
            Mock transcriber
          </span>
        )}
        {full.provenance && (
          <span className="row-sub">
            {full.provenance.location === 'local' ? 'Transcribed on this installation' : 'Hosted'}
          </span>
        )}
        <a className="text-link" href={full.audioUrl}>
          Recording
        </a>
      </div>
      {error !== null && <ErrorNotice error={error} />}
      {full.error && (
        <Notice tone="warning" title="Couldn’t finish this voice note">
          {full.error.message}
        </Notice>
      )}

      {editing ? (
        <div className="grid gap-2">
          <TextArea
            label="Transcript"
            rows={5}
            value={draft}
            maxLength={10_000}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              busy={busy}
              disabled={busy || !draft.trim()}
              onClick={() => void run(() => correctVoiceTranscript(full.id, draft.trim()))}
            >
              Save and re-read
            </Button>
            <Button variant="quiet" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
          <p className="hint">
            Saving replaces any proposals from this note that you haven’t approved.
          </p>
        </div>
      ) : (
        <>
          <Transcript note={full} />
          {lowConfidence && !full.correctedTranscript && (
            <p className="row-sub">Highlighted words were hard to hear. Check them.</p>
          )}
          {isOwner && !VOICE_WORKING.slice(0, 2).includes(full.status) && (
            <div>
              <Button
                icon="edit"
                onClick={() => {
                  setDraft(full.effectiveTranscript ?? '');
                  setEditing(true);
                }}
              >
                {full.effectiveTranscript ? 'Edit transcript' : 'Type transcript'}
              </Button>
            </div>
          )}
        </>
      )}

      {full.status === 'needs_clarification' && (
        <Notice tone="info" title={clarification.questions[0] ?? 'Which job is this about?'}>
          {isOwner && clarification.candidates.length > 0 && (
            <div className="grid gap-2">
              <SelectField
                label="Job"
                value={jobChoice}
                onChange={(event) => setJobChoice(event.target.value)}
                data-testid="voice-job-choice"
              >
                <option value="">Choose a job…</option>
                {clarification.candidates.map((candidate) => (
                  <option key={candidate.jobId} value={candidate.jobId}>
                    {candidate.customerName} · {candidate.jobTitle}
                    {candidate.address ? ` · ${candidate.address}` : ''}
                  </option>
                ))}
              </SelectField>
              <div>
                <Button
                  variant="primary"
                  busy={busy}
                  disabled={busy || !jobChoice}
                  onClick={() => void run(() => clarifyVoiceNote(full.id, { jobId: jobChoice }))}
                >
                  Use this job
                </Button>
              </div>
            </div>
          )}
          {isOwner && clarification.rateOptions.length > 0 && (
            <div className="grid gap-2">
              <SelectField
                label="Labour rate"
                value={rateChoice}
                onChange={(event) => setRateChoice(event.target.value)}
              >
                <option value="">Choose a rate…</option>
                {clarification.rateOptions.map((rate) => (
                  <option key={rate.code} value={rate.code}>
                    {rate.label}
                  </option>
                ))}
              </SelectField>
              <div>
                <Button
                  variant="primary"
                  busy={busy}
                  disabled={busy || !rateChoice}
                  onClick={() =>
                    void run(() => clarifyVoiceNote(full.id, { rateCode: rateChoice }))
                  }
                >
                  Use this rate
                </Button>
              </div>
            </div>
          )}
          {clarification.candidates.length === 0 && clarification.rateOptions.length === 0 && (
            <p>Open the job card and record the update there.</p>
          )}
        </Notice>
      )}

      {clarification.notices.length > 0 && (
        <ul className="row-sub list-disc pl-5">
          {clarification.notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      )}

      {proposals.length > 0 && (
        <div className="grid gap-2">
          <p className="row-title">
            {full.resolution.jobTitle ? `Proposed for “${full.resolution.jobTitle}”` : 'Proposed'}
          </p>
          <ul className="rows" aria-label="Proposals from this voice note">
            {proposals.map((proposal) => (
              <li key={proposal.id} className="grid gap-1" data-testid="voice-proposal">
                <span className="row-title">{proposal.summary}</span>
                <span className="row-sub">
                  {proposal.toolTitle} · {proposal.status}
                  {proposal.clarifications.length > 0 && ` · ${proposal.clarifications[0]}`}
                </span>
              </li>
            ))}
          </ul>
          {pending.length > 0 && (
            <a className="btn btn-go" href={href('approvals')} data-testid="voice-approvals-link">
              <Icon name="check" />
              <span>Review {pending.length} in the Approval inbox</span>
            </a>
          )}
        </div>
      )}
    </article>
  );
}
