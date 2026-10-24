import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PolicyDeniedError } from '@opentradie/core';
import { PermanentError, TransientError, ValidationError } from '../errors.js';
import type { MultipartFetch } from './http.js';
import { MockSpeechToText } from './mock.js';
import { FasterWhisperHttpAdapter } from './openai-compatible.js';
import { transcribeWithPolicy } from './types.js';
import { WhisperCppServerAdapter } from './whisper-cpp.js';

interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  form: FormData;
}

let server: Server;
let base: string;
const received: Received[] = [];
let reply: { status: number; body: string } = { status: 200, body: '{}' };

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      const request = new Request('http://local.test/', {
        method: 'POST',
        headers: { 'content-type': String(req.headers['content-type']) },
        body: Buffer.concat(chunks),
      });
      received.push({ path: req.url ?? '', headers: req.headers, form: await request.formData() });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const audio = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 87, 65, 86, 69]);

// Shape produced by whisper.cpp examples/server for response_format=verbose_json.
const whisperCppVerbose = {
  task: 'transcribe',
  language: 'english',
  duration: 4.5,
  text: ' Hi, my hot water cylinder is leaking. Can you come Tuesday?',
  segments: [
    {
      id: 0,
      text: ' Hi, my hot water cylinder is leaking.',
      start: 0.0,
      end: 2.4,
      tokens: [1, 2],
      words: [
        { word: ' Hi', start: 0, end: 0.3, probability: 0.9 },
        { word: ' leaking', start: 2, end: 2.4, probability: 0.7 },
      ],
      temperature: 0,
      avg_logprob: -0.2,
      no_speech_prob: 0.01,
    },
    { id: 1, text: ' Can you come Tuesday?', start: 2.4, end: 4.5, avg_logprob: -0.1053605 },
  ],
};

describe('WhisperCppServerAdapter (local fake whisper-server)', () => {
  it('posts multipart audio to /inference and maps verbose_json into milliseconds', async () => {
    received.length = 0;
    reply = { status: 200, body: JSON.stringify(whisperCppVerbose) };
    const stt = new WhisperCppServerAdapter({ baseUrl: base, model: 'ggml-base.en' });
    expect(stt.destination).toEqual({
      provider: 'whisper.cpp:ggml-base.en',
      location: 'local',
      attestation: 'endpoint',
    });
    const transcript = await stt.transcribe({ audio, mediaType: 'audio/wav', languageHint: 'en' });

    const request = received[0]!;
    expect(request.path).toBe('/inference');
    const file = request.form.get('file') as File;
    expect(file.name).toBe('audio.wav');
    expect(file.type).toBe('audio/wav');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
    expect(request.form.get('response_format')).toBe('verbose_json');
    expect(request.form.get('temperature')).toBe('0.0');
    expect(request.form.get('language')).toBe('en');

    expect(transcript).toMatchObject({
      text: 'Hi, my hot water cylinder is leaking. Can you come Tuesday?',
      provider: 'whisper.cpp:ggml-base.en',
      model: 'ggml-base.en',
      location: 'local',
      durationMs: 4500,
      language: 'english',
    });
    expect(transcript.segments).toHaveLength(2);
    expect(transcript.segments[0]).toMatchObject({
      startMs: 0,
      endMs: 2400,
      text: 'Hi, my hot water cylinder is leaking.',
    });
    expect(transcript.segments[0]!.confidence).toBeCloseTo(0.8, 10); // mean word probability
    expect(transcript.segments[1]!.confidence).toBeCloseTo(0.9, 5); // exp(avg_logprob)
  });

  it('honours a custom inference path and omits language when there is no hint', async () => {
    received.length = 0;
    reply = { status: 200, body: JSON.stringify({ text: 'ok' }) };
    const stt = new WhisperCppServerAdapter({
      baseUrl: base,
      model: 'm',
      inferencePath: '/stt/inference',
    });
    const transcript = await stt.transcribe({ audio, mediaType: 'audio/wav' });
    expect(received[0]!.path).toBe('/stt/inference');
    expect(received[0]!.form.has('language')).toBe(false);
    expect(transcript).toMatchObject({ text: 'ok', segments: [], durationMs: null });
  });

  it('normalises failures without reading error bodies', async () => {
    const stt = new WhisperCppServerAdapter({ baseUrl: base, model: 'm' });
    reply = { status: 500, body: '{"error":"secret transcript fragment"}' };
    const failed = (await stt
      .transcribe({ audio, mediaType: 'audio/wav' })
      .catch((e: unknown) => e)) as Error;
    expect(failed).toBeInstanceOf(TransientError);
    expect(failed.message).not.toContain('secret');
    reply = { status: 400, body: '{}' };
    await expect(stt.transcribe({ audio, mediaType: 'audio/wav' })).rejects.toBeInstanceOf(
      PermanentError,
    );
    reply = { status: 200, body: 'not json' };
    await expect(stt.transcribe({ audio, mediaType: 'audio/wav' })).rejects.toMatchObject({
      code: 'malformed_response',
    });
    const closed = new WhisperCppServerAdapter({ baseUrl: 'http://127.0.0.1:1', model: 'm' });
    await expect(closed.transcribe({ audio, mediaType: 'audio/wav' })).rejects.toBeInstanceOf(
      TransientError,
    );
  });

  it('validates audio before sending anything', async () => {
    received.length = 0;
    const stt = new WhisperCppServerAdapter({ baseUrl: base, model: 'm', maxAudioBytes: 8 });
    await expect(
      stt.transcribe({ audio: new Uint8Array(), mediaType: 'audio/wav' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(stt.transcribe({ audio, mediaType: 'audio/wav' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      stt.transcribe({ audio: audio.slice(0, 4), mediaType: 'video/mp4' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      stt.transcribe({ audio: audio.slice(0, 4), mediaType: 'audio/wav', languageHint: 'English' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(received).toHaveLength(0);
  });
});

describe('FasterWhisperHttpAdapter (OpenAI-compatible, local fake server)', () => {
  it('posts to /v1/audio/transcriptions with model, verbose_json and segment timestamps', async () => {
    received.length = 0;
    reply = {
      status: 200,
      body: JSON.stringify({
        text: 'Quote for a heat pump',
        language: 'en',
        duration: 1.25,
        segments: [{ start: 0, end: 1.25, text: 'Quote for a heat pump', avg_logprob: -0.05 }],
      }),
    };
    const stt = new FasterWhisperHttpAdapter({
      baseUrl: `${base}/`,
      model: 'Systran/faster-whisper-small',
    });
    const transcript = await stt.transcribe({ audio, mediaType: 'audio/webm', languageHint: 'en' });
    const request = received[0]!;
    expect(request.path).toBe('/v1/audio/transcriptions');
    expect(request.headers.authorization).toBeUndefined();
    expect(request.form.get('model')).toBe('Systran/faster-whisper-small');
    expect(request.form.get('response_format')).toBe('verbose_json');
    expect(request.form.getAll('timestamp_granularities[]')).toEqual(['segment']);
    expect((request.form.get('file') as File).name).toBe('audio.webm');
    expect(transcript).toMatchObject({
      location: 'local',
      durationMs: 1250,
      segments: [{ startMs: 0, endMs: 1250 }],
    });
  });
});

describe('speech privacy policy', () => {
  const spy = () => {
    const calls: string[] = [];
    const fetch: MultipartFetch = async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ text: 'hosted' }),
      };
    };
    return { calls, fetch };
  };

  it('LOCAL_ONLY refuses hosted and non-loopback endpoints before any audio is sent', async () => {
    for (const url of ['https://stt.example.com', 'http://192.168.1.20:8080']) {
      const { calls, fetch } = spy();
      const hosted = new FasterWhisperHttpAdapter({
        baseUrl: url,
        model: 'large-v3',
        apiKey: 'k',
        fetch,
      });
      const denied = await transcribeWithPolicy({ mode: 'LOCAL_ONLY' }, hosted, {
        audio,
        mediaType: 'audio/wav',
      }).catch((e: unknown) => e);
      expect(denied).toBeInstanceOf(PolicyDeniedError);
      expect((denied as PolicyDeniedError).code).toBe('MODEL_POLICY_DENIED');
      expect(calls).toEqual([]);
    }
  });

  it('APPROVAL_REQUIRED needs an approval; APPROVED_CLOUD sends with the API key', async () => {
    const { calls, fetch } = spy();
    const hosted = new FasterWhisperHttpAdapter({
      baseUrl: 'https://stt.example.com',
      model: 'large-v3',
      apiKey: 'k',
      fetch,
    });
    await expect(
      transcribeWithPolicy({ mode: 'APPROVAL_REQUIRED' }, hosted, {
        audio,
        mediaType: 'audio/wav',
      }),
    ).rejects.toMatchObject({ code: 'MODEL_APPROVAL_REQUIRED' });
    expect(calls).toEqual([]);
    const { transcript, decision } = await transcribeWithPolicy(
      { mode: 'APPROVED_CLOUD' },
      hosted,
      { audio, mediaType: 'audio/wav' },
    );
    expect(decision.reason).toBe('approved_cloud');
    expect(transcript.location).toBe('hosted');
    expect(calls).toEqual(['https://stt.example.com/v1/audio/transcriptions']);
  });

  it('LOCAL_ONLY allows a loopback whisper.cpp server and the mock', async () => {
    reply = { status: 200, body: JSON.stringify({ text: 'local' }) };
    const local = new WhisperCppServerAdapter({ baseUrl: base, model: 'm' });
    const result = await transcribeWithPolicy({ mode: 'LOCAL_ONLY' }, local, {
      audio,
      mediaType: 'audio/wav',
    });
    expect(result.decision.reason).toBe('local_inference');
    expect(result.transcript.text).toBe('local');
    const mock = await transcribeWithPolicy({ mode: 'LOCAL_ONLY' }, new MockSpeechToText(), {
      audio,
      mediaType: 'audio/wav',
    });
    expect(mock.transcript.provider).toBe('mock');
  });
});

describe('MockSpeechToText', () => {
  it('returns fixtures by audio hash and a labelled default otherwise', async () => {
    const mock = new MockSpeechToText();
    mock.addFixture(audio, { text: 'Fixture transcript', durationMs: 1200, language: 'en' });
    expect(mock.kind).toBe('mock');
    expect(await mock.transcribe({ audio, mediaType: 'audio/wav' })).toMatchObject({
      text: 'Fixture transcript',
      durationMs: 1200,
      location: 'local',
      segments: [{ startMs: 0, endMs: 1200 }],
    });
    const other = await mock.transcribe({
      audio: new Uint8Array([1]),
      mediaType: 'audio/ogg',
      languageHint: 'mi',
    });
    expect(other.text).toContain('test voice note');
    expect(other.language).toBe('mi');
    expect(mock.calls).toHaveLength(2);
  });
});
