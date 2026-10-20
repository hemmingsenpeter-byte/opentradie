import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AppState, InboxThreadDetail } from './types';

/**
 * Inbox component tests with a stubbed fetch: they check what the client sends and shows,
 * not that the API or any mail provider works.
 */
const THREAD = '44444444-4444-4444-8444-444444444444';
const INBOUND = '55555555-5555-4555-8555-555555555555';
const DRAFT = '66666666-6666-4666-8666-666666666666';

function state(role: 'owner' | 'viewer'): AppState {
  return {
    business: {
      id: 'b',
      name: 'Demo',
      currency: 'NZD',
      timeZone: 'Pacific/Auckland',
      taxBasisPoints: 1500,
    },
    user: { id: 'u', email: `${role}@demo.test`, role },
    customers: [],
    jobs: [],
    communications: [],
    quotes: [],
    rates: [],
    auditEvents: [],
    settings: {
      profile: 'local',
      privacyMode: 'LOCAL_ONLY',
      agentMode: 'mock',
      agentHealth: 'ok',
      demoData: true,
    },
  } as AppState;
}

const detail: InboxThreadDetail = {
  thread: {
    id: THREAD,
    subject: 'Quote for power points',
    status: 'open',
    needsReview: false,
    reviewReason: null,
    customerId: null,
    customerName: null,
    jobId: null,
    jobTitle: null,
    jobStatus: null,
    lastMessageAt: '2026-10-19T00:00:00.000Z',
    createdAt: '2026-10-19T00:00:00.000Z',
  },
  messages: [
    {
      id: INBOUND,
      direction: 'inbound',
      status: 'received',
      origin: 'webhook',
      subject: 'Quote for power points',
      text: 'Can you quote three power points?',
      fromAddress: 'kiri@customer.example.test',
      fromName: 'Kiri Walker',
      toAddresses: [],
      receivedAt: '2026-10-19T00:00:00.000Z',
      readAt: null,
      createdAt: '2026-10-19T00:00:00.000Z',
      approvedAt: null,
      sentAt: null,
      triage: {
        classification: 'new_enquiry',
        summary: 'Kiri wants three power points quoted.',
        suggestedActions: [{ type: 'draft_quote', note: 'Draft a quote from approved rates.' }],
        synthetic: true,
      },
      triageStatus: 'completed',
      sendErrorCode: null,
      sendAttempt: 0,
      attachments: [],
    },
    {
      id: DRAFT,
      direction: 'outbound',
      status: 'draft',
      origin: 'agent_draft',
      subject: 'Re: Quote for power points',
      text: 'Kia ora Kiri, thanks for getting in touch.',
      fromAddress: null,
      fromName: null,
      toAddresses: ['kiri@customer.example.test'],
      receivedAt: null,
      readAt: null,
      createdAt: '2026-10-19T00:01:00.000Z',
      approvedAt: null,
      sentAt: null,
      triage: { draftWarnings: ['contains_price'] },
      triageStatus: 'not_applicable',
      sendErrorCode: null,
      sendAttempt: 0,
      attachments: [],
    },
  ],
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(role: 'owner' | 'viewer') {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const s = state(role);
      if (url === '/api/me') return json(200, s.user);
      if (url === '/api/state') return json(200, s);
      if (url === `/api/inbox/threads/${THREAD}`) return json(200, detail);
      if (url === `/api/inbox/threads/${THREAD}/read`) return json(200, { marked: 1 });
      if (url === `/api/communications/${DRAFT}/approve-send`)
        return json(202, { id: DRAFT, status: 'approved', sendAttempt: 1 });
      if (url === '/api/inbox/paste')
        return json(201, { status: 'accepted', threadId: THREAD, communicationId: INBOUND });
      return json(404, { error: 'NOT_FOUND', message: 'Not found' });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('inbox thread', () => {
  it('shows the AI summary and draft, and approves the edited reply with an idempotency key', async () => {
    window.location.hash = `#/inbox/${THREAD}`;
    const calls = stub('owner');
    render(<App />);
    expect(await screen.findByText('Kiri wants three power points quoted.')).toBeTruthy();
    expect(screen.getByText(/mentions a price/)).toBeTruthy();
    const reply = screen.getByLabelText('Reply') as HTMLTextAreaElement;
    expect(reply.value).toBe('Kia ora Kiri, thanks for getting in touch.');
    fireEvent.change(reply, { target: { value: 'Kia ora Kiri, we can come Thursday.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve & send' }));
    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith('/approve-send'))).toBe(true),
    );
    const approve = calls.find((call) => call.url.endsWith('/approve-send'))!;
    expect(JSON.parse(String(approve.init.body))).toEqual({
      text: 'Kia ora Kiri, we can come Thursday.',
    });
    expect(new Headers(approve.init.headers).get('Idempotency-Key')).toMatch(/^[a-f0-9]{32}$/);
    expect(calls.some((call) => call.url.endsWith('/read'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Create job from this' })).toBeTruthy();
  });

  it('gives viewers no approve, edit or create actions', async () => {
    window.location.hash = `#/inbox/${THREAD}`;
    const calls = stub('viewer');
    render(<App />);
    expect(await screen.findByText('Kiri wants three power points quoted.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve & send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create job from this' })).toBeNull();
    expect((screen.getByLabelText('Reply') as HTMLTextAreaElement).disabled).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/read'))).toBe(false);
  });

  it('pastes an email and opens the new conversation', async () => {
    window.location.hash = '#/inbox/paste';
    const calls = stub('owner');
    render(<App />);
    fireEvent.change(await screen.findByLabelText(/From \(email address\)/), {
      target: { value: 'kiri@customer.example.test' },
    });
    fireEvent.change(screen.getByLabelText(/^Message/), { target: { value: 'Quote please' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to inbox' }));
    await waitFor(() => expect(window.location.hash).toBe(`#/inbox/${THREAD}`));
    const paste = calls.find((call) => call.url === '/api/inbox/paste')!;
    expect(JSON.parse(String(paste.init.body))).toEqual({
      from: 'kiri@customer.example.test',
      subject: '',
      text: 'Quote please',
    });
  });
});
