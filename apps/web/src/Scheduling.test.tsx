import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AppState } from './types';

/**
 * Scheduling UI against a stubbed fetch. These check what the client sends and shows; they are
 * not evidence that the real API works (see tests/integration/scheduling.test.ts).
 */
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const APPOINTMENT_ID = '88888888-8888-4888-8888-888888888888';

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
    customers: [{ id: CUSTOMER_ID, name: 'Mrs Johnson' }],
    jobs: [
      { id: JOB_ID, customerId: CUSTOMER_ID, title: 'Replace lounge power points', status: 'new' },
    ],
    communications: [],
    quotes: [],
    rates: [],
    auditEvents: [],
    settings: { profile: 'local', privacyMode: 'LOCAL_ONLY', agentMode: 'mock', agentHealth: 'ok' },
  };
}

const detail = {
  job: { id: JOB_ID, customerId: CUSTOMER_ID, title: 'Replace lounge power points', status: 'new' },
  customer: { id: CUSTOMER_ID, name: 'Mrs Johnson' },
  property: null,
  nextStatuses: [],
  notes: [],
  documents: [],
  timeline: [],
};

const SLOTS = [
  {
    startsAt: '2026-10-27T20:00:00.000Z',
    endsAt: '2026-10-27T21:00:00.000Z',
    localDate: '2026-10-28',
  },
  {
    startsAt: '2026-10-27T21:00:00.000Z',
    endsAt: '2026-10-27T22:00:00.000Z',
    localDate: '2026-10-28',
  },
];

function appointment(startsAt: string, endsAt: string) {
  return {
    id: APPOINTMENT_ID,
    jobId: JOB_ID,
    jobTitle: 'Replace lounge power points',
    jobStatus: 'scheduled',
    customerId: CUSTOMER_ID,
    customerName: 'Mrs Johnson',
    location: '14 Kauri Street',
    startsAt,
    endsAt,
    status: 'confirmed',
    title: 'Replace lounge power points',
    notes: null,
    version: 1,
    conflictAcknowledged: false,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi(
  role: 'owner' | 'viewer',
  options: { conflict?: boolean; appointments?: unknown[] } = {},
) {
  const state = makeState(role);
  const booked: unknown[] = [...(options.appointments ?? [])];
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const method = init.method ?? 'GET';
      if (url === '/api/me') return json(200, state.user);
      if (url === '/api/state') return json(200, state);
      if (url === `/api/jobs/${JOB_ID}`) return json(200, detail);
      if (url === `/api/jobs/${JOB_ID}/appointments`) return json(200, { appointments: booked });
      if (url.startsWith('/api/scheduling/availability'))
        return json(200, {
          timeZone: 'Pacific/Auckland',
          durationMinutes: 60,
          bufferMinutes: 15,
          fromDate: '2026-10-28',
          days: 14,
          slots: SLOTS,
        });
      if (url === '/api/scheduling/settings')
        return json(200, {
          timeZone: 'Pacific/Auckland',
          bufferMinutes: 15,
          reminderLeadMinutes: 1440,
          workingHours: [{ weekday: 1, startMinute: 420, endMinute: 1020 }],
          usingDefaultHours: true,
        });
      if (url.startsWith('/api/appointments?')) return json(200, { appointments: booked });
      if (url === '/api/appointments' && method === 'POST') {
        if (options.conflict)
          return json(409, {
            error: 'APPOINTMENT_CONFLICT',
            message: 'That time overlaps another appointment (including travel buffer).',
            conflicts: [{ id: APPOINTMENT_ID }],
          });
        const body = JSON.parse(String(init.body));
        const created = { ...appointment(body.startsAt, body.endsAt), reminders: [{ id: 'r' }] };
        booked.push(created);
        return json(201, {
          appointment: created,
          warnings: [],
          jobStatusChange: { from: 'new', to: 'scheduled' },
        });
      }
      return json(404, { error: 'NOT_FOUND', message: 'Page or endpoint not found.' });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('scheduling from the job card', () => {
  it('suggests free times and books one with an idempotency key', async () => {
    window.location.hash = `#/jobs/${JOB_ID}`;
    const calls = stubApi('owner');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule' }));
    const group = await screen.findByRole('group', { name: 'Suggested times' });
    const options = within(group).getAllByRole('button');
    expect(options).toHaveLength(2);
    // Shown in the business time zone (NZDT): 9:00 am on Wednesday 28 October.
    expect(options[0]!.textContent).toMatch(/Wed.*28 Oct.*9:00/);
    const availability = calls.find((call) => call.url.startsWith('/api/scheduling/availability'));
    expect(availability!.url).toContain('durationMinutes=60');
    expect(availability!.url).toContain('days=14');

    fireEvent.click(options[0]!);
    expect(await screen.findByText(/Booked .* The job is now scheduled\./)).toBeTruthy();
    const post = calls.find((call) => call.url === '/api/appointments');
    expect(JSON.parse(String(post!.init.body))).toEqual({
      jobId: JOB_ID,
      startsAt: SLOTS[0]!.startsAt,
      endsAt: SLOTS[0]!.endsAt,
    });
    expect(new Headers(post!.init.headers).get('Idempotency-Key')).toMatch(
      /^[A-Za-z0-9_-]{8,128}$/,
    );
    const list = await screen.findByRole('list', { name: 'Appointments' });
    expect(within(list).getByText(/28 Oct/)).toBeTruthy();
  });

  it('explains a clash and refreshes the suggestions', async () => {
    window.location.hash = `#/jobs/${JOB_ID}`;
    const calls = stubApi('owner', { conflict: true });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule' }));
    const group = await screen.findByRole('group', { name: 'Suggested times' });
    fireEvent.click(within(group).getAllByRole('button')[0]!);
    expect(await screen.findByText(/overlaps another appointment/)).toBeTruthy();
    await waitFor(() =>
      expect(
        calls.filter((call) => call.url.startsWith('/api/scheduling/availability')),
      ).toHaveLength(2),
    );
  });

  it('gives viewers the appointment list without booking controls', async () => {
    window.location.hash = `#/jobs/${JOB_ID}`;
    stubApi('viewer');
    render(<App />);
    expect(await screen.findByText('No appointments booked.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Schedule' })).toBeNull();
  });
});

describe('calendar screen', () => {
  it('has a nav entry and lists this week’s appointments', async () => {
    const start = new Date(Date.now() + 60 * 60_000);
    const end = new Date(start.getTime() + 60 * 60_000);
    window.location.hash = '#/calendar';
    const calls = stubApi('owner', {
      appointments: [appointment(start.toISOString(), end.toISOString())],
    });
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Calendar' }).getAttribute('aria-current')).toBe(
      'page',
    );
    const host = await screen.findByTestId('calendar');
    expect(await within(host).findByText(/Replace lounge power points · Mrs Johnson/)).toBeTruthy();
    const range = calls.find((call) => call.url.startsWith('/api/appointments?'));
    expect(range!.url).toMatch(/from=.*&to=/);
  });
});
