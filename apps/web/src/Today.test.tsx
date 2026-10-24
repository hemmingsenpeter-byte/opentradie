import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AppState } from './types';

/**
 * Today panel against a stubbed fetch: what the client shows and sends. Not evidence the real
 * API works (tests/integration/tasks.test.ts covers that).
 */
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';

function makeState(role: 'owner' | 'viewer'): AppState {
  return {
    business: {
      id: 'b',
      name: 'Harbour Electrical · Demo',
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
    settings: { profile: 'local', privacyMode: 'LOCAL_ONLY', agentMode: 'mock', agentHealth: 'ok' },
  };
}

const task = {
  id: TASK_ID,
  kind: 'book_job',
  title: 'Book in: Power points',
  notes: null,
  dueAt: '2026-10-20T20:00:00.000Z',
  priority: 'high',
  status: 'open',
  snoozedUntil: null,
  source: 'rule',
  customerId: 'c',
  customerName: 'Mrs Johnson',
  customerPhone: '021 555 0101',
  jobId: JOB_ID,
  jobTitle: 'Power points',
  quoteId: null,
  quoteNumber: null,
  invoiceId: null,
  invoiceNumber: null,
  threadId: null,
  bucket: 'overdue',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(role: 'owner' | 'viewer') {
  let done = false;
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url === '/api/me') return json(200, makeState(role).user);
      if (url === '/api/state') return json(200, makeState(role));
      if (url === '/api/today')
        return json(200, {
          timeZone: 'Pacific/Auckland',
          date: '2026-10-24',
          counts: { overdue: done ? 0 : 1, today: 0, upcoming: 0, snoozed: 0, due: done ? 0 : 1 },
          overdue: done ? [] : [task],
          today: [],
          upcoming: [],
          snoozed: [],
          appointments: [
            {
              id: 'a',
              jobId: JOB_ID,
              jobTitle: 'Heat pump service',
              customerName: 'Bob',
              startsAt: '2026-10-23T22:00:00.000Z',
              endsAt: '2026-10-23T23:00:00.000Z',
              status: 'confirmed',
              location: null,
            },
          ],
        });
      if (url === `/api/tasks/${TASK_ID}/complete`) {
        done = true;
        return json(200, { task: { ...task, status: 'done' }, changed: true });
      }
      return json(404, { error: 'NOT_FOUND', message: 'not found' });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

describe('Today panel', () => {
  it('groups tasks, links Schedule to the job slot picker and completes in one tap', async () => {
    const calls = stub('owner');
    window.location.hash = '#/home';
    render(<App />);
    const panel = await screen.findByRole('region', { name: /Today/ });
    const card = await within(panel).findByTestId('task-card');
    expect(within(panel).getByRole('heading', { name: /Overdue/ })).toBeTruthy();
    expect(within(card).getByText('Book in: Power points')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Schedule' }).getAttribute('href')).toBe(
      `#/jobs/${JOB_ID}?schedule=1`,
    );
    expect(within(panel).getByRole('list', { name: 'Today’s appointments' })).toBeTruthy();
    expect(await screen.findByLabelText('1 tasks due')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Complete: Book in: Power points' }));
    await waitFor(() => expect(within(panel).queryByTestId('task-card')).toBeNull());
    const complete = calls.find((call) => call.url.endsWith('/complete'))!;
    expect(complete.init.method).toBe('POST');
    expect(new Headers(complete.init.headers).get('Idempotency-Key')).toBeTruthy();
  });

  it('is read only for a viewer', async () => {
    stub('viewer');
    window.location.hash = '#/home';
    render(<App />);
    const panel = await screen.findByRole('region', { name: /Today/ });
    await within(panel).findByTestId('task-card');
    expect(within(panel).queryByRole('button', { name: /Complete/ })).toBeNull();
    expect(within(panel).queryByLabelText('New task')).toBeNull();
  });
});
