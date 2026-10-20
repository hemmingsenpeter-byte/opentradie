# Speech-to-text integration

Code: `packages/integrations/src/speech` (`@opentradie/integrations`).

## Status

| Component                                                                                                                              | Status                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `SpeechToText` contract and `transcribeWithPolicy` privacy gate                                                                        | Implemented and tested                                                                                                                      |
| `WhisperCppServerAdapter` (whisper.cpp `whisper-server`)                                                                               | **Implemented, not integration-tested.** Tested against a local fake HTTP server that implements the documented request and response shapes |
| `FasterWhisperHttpAdapter` (OpenAI-compatible `/v1/audio/transcriptions`)                                                              | **Implemented, not integration-tested**                                                                                                     |
| `MockSpeechToText`                                                                                                                     | Mock (fixtures). Never evidence of a real integration                                                                                       |
| Voice note upload route, `voice.transcribe`/`voice.interpret` tasks, PWA capture ([ADR 0024](../adr/0024-voice-notes-to-proposals.md)) | Implemented and tested with `MockSpeechToText` only                                                                                         |
| iOS Shortcuts, voice channel                                                                                                           | Planned                                                                                                                                     |

## Contract

`transcribe({ audio: Uint8Array, mediaType, languageHint? })` returns:

```text
{ text, segments: [{ startMs, endMs, text, confidence|null }], language|null,
  provider, model, location: 'local' | 'hosted', durationMs|null }
```

- Timings are integer milliseconds, converted from the seconds the servers report.
- `confidence` is the mean word probability when the server returns words, otherwise `exp(avg_logprob)`, otherwise `null`.
- Input is validated before any request is sent: the audio must not be empty and is limited to 25 MB by default, `mediaType` must be on the supported audio list, and `languageHint` must be an ISO 639 code.
- Failures use the shared taxonomy. Network failures, 5xx and 408 raise `TransientError`, 429 raises `RateLimitedError`, other 4xx and malformed responses raise `PermanentError`, and bad input raises `ValidationError`. Error bodies are never read, because they can echo transcript text.

## Privacy (fail closed)

All business audio must go through `transcribeWithPolicy`, which calls `assertModelUse` from `@opentradie/core` before any byte is sent:

- An adapter's location comes from its endpoint URL (`locationFromEndpoint`). Only loopback (`localhost`, `127.0.0.1`, `::1`) counts as local, and configuration labels cannot override this. A whisper.cpp server elsewhere on the LAN (e.g. `192.168.x.x`) counts as hosted.
- `LOCAL_ONLY`: any hosted destination raises `PolicyDeniedError` (`MODEL_POLICY_DENIED`). No other provider is tried as a fallback.
- `APPROVAL_REQUIRED`: a hosted destination needs a matching, unexpired, single-use approval.
- `APPROVED_CLOUD`: hosted destinations are allowed.
- Core's `ModelPurpose` has no transcription value yet, so the gate uses `enquiry_interpretation` with data category `communication_text` by default. Approvals stay scoped to the speech provider's label (e.g. `whisper.cpp:ggml-base.en`). Adding a dedicated `speech_transcription` purpose to `packages/core` is a follow-up.
- Audio, transcripts and provider responses are never logged.

## Configuration (voice notes)

- `SPEECH_PROVIDER=none` (default): voice notes are stored and fail visibly with `SPEECH_NOT_CONFIGURED`; the owner can type the transcript.
- `SPEECH_PROVIDER=whisper_cpp` or `openai_compatible` with `SPEECH_BASE_URL` and `SPEECH_MODEL` (and `SPEECH_API_KEY` for the latter). Loopback URLs are local; anything else is hosted and `LOCAL_ONLY` refuses it with `MODEL_POLICY_DENIED`, with no fallback.
- `SPEECH_PROVIDER=mock`: a fixed synthetic transcript for development, tests and demos. Start-up refuses it with `NODE_ENV=production` or the cloud profile.
- Uploads accept `audio/m4a`, `audio/mp4`, `audio/mpeg`, `audio/wav`, `audio/webm` and `audio/ogg` up to 10 MiB; leading bytes must match the type. Transient speech errors retry up to 3 attempts, then the note fails with `SPEECH_UNAVAILABLE`.
- Audit rows record provider, location, duration and segment counts, never transcript text.

## whisper.cpp server

Source checked: whisper.cpp `examples/server/README.md` and `server.cpp` (ggml-org/whisper.cpp, master).

- Start it on loopback: `whisper-server -m models/ggml-base.en.bin --host 127.0.0.1 --port 8080`. The default host and port are `127.0.0.1:8080`.
- Request: multipart `POST /inference`, overridable with `--inference-path` (a `--request-path` prefix must be included in the adapter's `inferencePath`). Fields sent: `file`, `response_format=verbose_json`, `temperature=0.0` and `language` when a hint is given.
- Response (`verbose_json`): `task`, `language`, `duration` (seconds), `text`, and `segments[]` with `id`, `text`, `start`, `end` (seconds), `avg_logprob`, `no_speech_prob`, and `words[]` with `probability` when token timestamps are on.
- whisper-server decodes WAV only unless it is started with `--convert`, which needs ffmpeg. Convert browser recordings (WebM/Opus, M4A) to 16 kHz mono WAV before sending them, or run the server with `--convert`.
- The server does not report its model, so the adapter's `model` option is an operator label.

## OpenAI-compatible servers (e.g. faster-whisper)

- Request: multipart `POST {baseUrl}/v1/audio/transcriptions` with `file`, `model`, `response_format=verbose_json`, `timestamp_granularities[]=segment` and `language`. Sends `Authorization: Bearer` when `apiKey` is set.
- Response: OpenAI `verbose_json` (`text`, `language`, `duration`, `segments[]` with `start`, `end` and `avg_logprob`).
- A hosted endpoint, such as a cloud speech-to-text API, is hosted by definition, and `LOCAL_ONLY` refuses it.

## Live verification (not yet performed)

1. Build whisper.cpp, download `ggml-base.en.bin`, and start `whisper-server` on `127.0.0.1:8080`.
2. Transcribe a short 16 kHz WAV recording with `WhisperCppServerAdapter` through `transcribeWithPolicy({ mode: 'LOCAL_ONLY' }, ...)`. Check the text, segment timings and duration.
3. Repeat with a faster-whisper OpenAI-compatible server on loopback.
4. Record the commands, versions and results before changing either status label.
