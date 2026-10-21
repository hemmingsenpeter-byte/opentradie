import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AppState } from './types';
import { voiceMediaType } from './voice-api';

/**
 * Voice note UI against a stubbed fetch. These check what the client sends and shows; they are
 * not evidence that the real API works (see tests/integration/voice-notes.test.ts).
 */
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_JOB = '33333333-3333-4333-8333-333333333333';
const NOTE_ID = '44444444-4444-4444-8444-444444444444';

const state = (role: 'owner' | 'viewer'): AppState => ({
  business: {
    id: 'b',
    name: 'Harbour Electrical · Demo',
    currency: 'NZD',
    timeZone: 'Pacific/Auckland',
    taxBasisPoints: 1500,
  },
  user: { id: 'u', email: `${role}@demo.test`, role },
  customers: [{ id: CUSTOMER_ID, name: 'John Smith' }],
  jobs: [{ id: JOB_ID, customerId: CUSTOMER_ID, title: 'Kitchen mixer', status: 'in_progress' }],
  communications: [],
  quotes: [],
  rates: [],
  auditEvents: [],
  settings: { profile: 'local', privacyMode: 'LOCAL_ONLY', agentMode: 'mock', agentHealth: 'ok' },
});

const base = {
  id: NOTE_ID,
  mediaType: 'audio/wav',
  sizeBytes: 20,
  audioUrl: '/api/documents/d/content',
  transcript: "Finished the job at Smith's house. $185 mixer from Reece.",
  correctedTranscript: null,
  effectiveTranscript: "Finished the job at Smith's house. $185 mixer from Reece.",
  correctedAt: null,
  correctedByName: null,
  provenance: {
    provider: 'mock',
    model: 'mock-transcriber',
    location: 'local',
    durationMs: 4000,
    averageConfidence: 0.7,
    synthetic: true,
  },
  segments: [
    {
      startMs: 0,
      endMs: 2000,
      text: "Finished the job at Smith's house.",
      confidence: 0.9,
      lowConfidence: false,
    },
    {
      startMs: 2000,
      endMs: 4000,
      text: '$185 mixer from Reece.',
      confidence: 0.4,
      lowConfidence: true,
    },
  ],
  interpretationVersion: 1,
  resolution: {
    status: 'ambiguous',
    customerId: null,
    customerName: null,
    jobId: null,
    jobTitle: null,
  },
  clarification: {
    questions: ['2 customers match “Smith” (John Smith, Mary Smith). Which job is this about?'],
    candidates: [
      {
        customerId: CUSTOMER_ID,
        customerName: 'John Smith',
        jobId: JOB_ID,
        jobTitle: 'Kitchen mixer',
        jobStatus: 'in_progress',
        address: '12 Kauri Road',
      },
      {
        customerId: 'c2',
        customerName: 'Mary Smith',
        jobId: OTHER_JOB,
        jobTitle: 'Bathroom heater',
        jobStatus: 'in_progress',
        address: null,
      },
    ],
    rateOptions: [],
    notices: [],
  },
  error: null,
  createdAt: '2026-10-20T01:00:00.000Z',
  updatedAt: '2026-10-20T01:00:00.000Z',
};

const proposed = {
  ...base,
  status: 'proposed',
  resolution: {
    ...base.resolution,
    status: 'owner_selected',
    jobId: JOB_ID,
    jobTitle: 'Kitchen mixer',
  },
  clarification: { ...base.clarification, questions: [], candidates: [] },
  proposals: [
    {
      id: 'p1',
      tool: 'job.add_material',
      toolTitle: 'Propose material',
      source: 'voice',
      status: 'pending',
      summary:
        'Add 1 each of "mixer" to job "Kitchen mixer" (reported supplier cost $185.00 per unit)',
      payload: {},
      clarifications: [
        '$185.00 is recorded as the supplier cost (what you paid), not a sell price.',
      ],
    },
  ],
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi(role: 'owner' | 'viewer') {
  const calls: { url: string; init: RequestInit }[] = [];
  let current: Record<string, unknown> = { ...base, status: 'needs_clarification', proposals: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const method = init.method ?? 'GET';
      if (url === '/api/me') return json(200, state(role).user);
      if (url === '/api/state') return json(200, state(role));
      if (url.startsWith('/api/voice-notes?')) return json(200, { voiceNotes: [] });
      if (url === '/api/voice-notes' && method === 'POST') return json(201, current);
      if (url === `/api/voice-notes/${NOTE_ID}/clarify`) {
        current = proposed;
        return json(200, proposed);
      }
      if (url === `/api/voice-notes/${NOTE_ID}`) return json(200, current);
      return json(404, { error: 'NOT_FOUND', message: 'Page or endpoint not found.' });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('voice notes in the PWA', () => {
  it('normalises recorder and file types to the server allowlist', () => {
    expect(voiceMediaType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(voiceMediaType('audio/x-m4a')).toBe('audio/m4a');
    expect(voiceMediaType('', 'memo.M4A')).toBe('audio/m4a');
    expect(voiceMediaType('video/quicktime', 'clip.mov')).toBe('');
  });

  it('uploads a recording from Home, highlights unsure words and resolves which Smith', async () => {
    window.location.hash = '#/home';
    const calls = stubApi('owner');
    render(<App />);
    const input = await screen.findByTestId('voice-input');
    const file = new File([new Uint8Array([82, 73, 70, 70])], 'note.wav', { type: 'audio/wav' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText(/2 customers match “Smith”/)).toBeTruthy();
    const post = calls.find((call) => call.url === '/api/voice-notes');
    const body = JSON.parse(String(post!.init.body));
    expect(body).toMatchObject({ mediaType: 'audio/wav', dataBase64: 'UklGRg==' });
    expect(body.jobId).toBeUndefined();
    expect(new Headers(post!.init.headers).get('Idempotency-Key')).toMatch(
      /^[A-Za-z0-9_-]{8,128}$/,
    );
    expect((await screen.findByTestId('low-confidence')).textContent).toBe(
      '$185 mixer from Reece.',
    );
    expect(screen.getByTestId('voice-status').getAttribute('role')).toBe('status');
    expect(screen.getByText('Mock transcriber')).toBeTruthy();

    fireEvent.change(screen.getByTestId('voice-job-choice'), { target: { value: JOB_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this job' }));
    const list = await screen.findByRole('list', { name: 'Proposals from this voice note' });
    expect(within(list).getByText(/reported supplier cost \$185\.00/)).toBeTruthy();
    const clarify = calls.find((call) => call.url.endsWith('/clarify'));
    expect(JSON.parse(String(clarify!.init.body))).toEqual({ jobId: JOB_ID });
    const link = screen.getByTestId('voice-approvals-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#/approvals');
  });

  it('shows viewers a view-only note instead of recording controls', async () => {
    window.location.hash = '#/home';
    stubApi('viewer');
    render(<App />);
    const panel = await screen.findByTestId('voice-panel');
    await waitFor(() => expect(within(panel).queryByTestId('voice-input')).toBeNull());
    expect(within(panel).getByText(/view-only access/)).toBeTruthy();
  });
});
