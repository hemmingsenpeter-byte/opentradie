# ADR 0014: SpeechToText adapter, local whisper.cpp first

- Status: Accepted; planned for Phase 4 (not implemented). No speech code exists.
- Date: 2026-10-19

## Context

Voice notes should turn into transcripts and then owner-approved job updates. Audio of customers' homes and voices is sensitive; privacy modes fail closed ([ADR 0005](0005-privacy-modes-fail-closed.md)). Candidates: whisper.cpp v1.9.5 (MIT; C/C++; `whisper-server` HTTP `/inference`, no authentication, 16-bit WAV input, Metal and optional Core ML on Apple Silicon; upstream model memory from about 273 MB for tiny to about 3.9 GB for large) and faster-whisper v1.2.1 (MIT; Python 3.9 or later on CTranslate2; CUDA 12 and cuDNN 9 for GPU; Apple Silicon support not stated in its README; no HTTP server of its own).

## Decision

1. Define `SpeechToText` in `packages/integrations/speech`: `transcribe(audio, options) -> { text, language, segments?, model, durationMs }`, plus `health()`. A deterministic mock is used in CI.
2. **Default implementation: whisper.cpp** run by the operator as a local `whisper-server` bound to `127.0.0.1`, never exposed. The API converts uploaded audio to 16 kHz mono WAV before calling it and may send a vocabulary hint built from approved rate labels and customer names, sanitised.
3. **Optional implementation: faster-whisper** in a container behind an authenticated wrapper, for cloud and hybrid profiles only. `LOCAL_ONLY` blocks any hosted transcriber with no fallback.
4. Transcription runs as a queue task. The voice note and audio are stored first; a down or missing-model service leaves the note pending and retries.
5. Transcripts are immutable revisions. Output is untrusted text: it can only produce action proposals (see the tool gateway in [architecture-v2.md](../architecture-v2.md)), never direct mutations. Transcript text is never logged.
6. Model files are an operator install step and are not committed. Model weight licences are not reviewed here and must be recorded when a model is chosen.

## Consequences

- A local-first, no-cloud default that matches the Mac mini profile; accuracy on NZ accents and site noise is unmeasured and must be tested with consented sample audio before claims are made.
- The operator installs the binary and a model; deployment files for it stay unverified until run on hardware.
- Adding a vendor later means a new adapter implementation, not changes to business code.
