import { readFile } from 'node:fs/promises';
import { WhisperCppServerAdapter, transcribeWithPolicy } from '@opentradie/integrations/speech';

/**
 * pnpm test:speech-smoke — transcribes a public-domain sample (whisper.cpp samples/jfk.wav)
 * through the real WhisperCppServerAdapter against a REAL whisper-server, under LOCAL_ONLY.
 * Env: WHISPER_SERVER_URL (required, loopback), WHISPER_SAMPLE (path to a WAV, required),
 * WHISPER_MODEL (label, default "ggml-tiny.en"). Exits 1 on any failure. Run by CI only.
 */
const url = process.env.WHISPER_SERVER_URL;
const samplePath = process.env.WHISPER_SAMPLE;
if (!url || !samplePath) {
  process.stderr.write(
    'speech-smoke: WHISPER_SERVER_URL and WHISPER_SAMPLE (path to a WAV file) are required.\n',
  );
  process.exit(1);
}

const expected = 'ask not what your country can do for you';
const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

try {
  const adapter = new WhisperCppServerAdapter({
    baseUrl: url,
    model: process.env.WHISPER_MODEL ?? 'ggml-tiny.en',
  });
  const audio = new Uint8Array(await readFile(samplePath));
  const { transcript } = await transcribeWithPolicy({ mode: 'LOCAL_ONLY' }, adapter, {
    audio,
    mediaType: 'audio/wav',
    languageHint: 'en',
  });
  const passed = transcript.location === 'local' && normalise(transcript.text).includes(expected);
  process.stdout.write(
    `${JSON.stringify({
      check: 'speech-smoke',
      passed,
      provider: transcript.provider,
      model: transcript.model,
      durationMs: transcript.durationMs,
      segments: transcript.segments.length,
    })}\n`,
  );
  if (!passed) {
    process.stderr.write(`speech-smoke: unexpected transcript: ${transcript.text.slice(0, 200)}\n`);
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(
    `speech-smoke: FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
