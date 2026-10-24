import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AppState, CollectionsSettings } from './types';

/** Settings › Payment follow-ups with a stubbed fetch; the server validates and enforces policy. */
const state = {
  business: {
    id: 'b',
    name: 'Harbour Electrical · Demo',
    currency: 'NZD',
    timeZone: 'Pacific/Auckland',
    taxBasisPoints: 1500,
    paymentTermsDays: 20,
  },
  user: { id: 'u', email: 'owner@demo.test', role: 'owner' },
  customers: [],
  jobs: [],
  communications: [],
  quotes: [],
  rates: [],
  auditEvents: [],
  settings: { profile: 'local', privacyMode: 'LOCAL_ONLY', agentMode: 'mock', agentHealth: 'ok' },
} as unknown as AppState;

const defaults: CollectionsSettings = {
  enabled: false,
  preDueCourtesyEnabled: false,
  preDueDays: 3,
  overdue1Days: 7,
  overdue2Days: 14,
  overdueFinalDays: 30,
  escalateDays: 45,
  autoSend: { pre_due_courtesy: false, overdue_1: false, overdue_2: false, overdue_final: false },
};

const json = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json' },
  });

function stub() {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url === '/api/me') return json(200, state.user);
      if (url === '/api/state') return json(200, state);
      if (url === '/health') return json(200, { status: 'ok' });
      if (url === '/api/settings/collections' && init.method === 'PATCH')
        return json(200, { ...defaults, ...JSON.parse(String(init.body)) });
      if (url === '/api/settings/collections') return json(200, defaults);
      if (url === '/api/collections/scan') return json(202, { queued: true });
      return json(404, { error: 'NOT_FOUND', message: 'Not found' });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('payment follow-up settings', () => {
  it('defaults to approval for every stage and warns before auto-send is saved', async () => {
    window.location.hash = '#/settings';
    const calls = stub();
    render(<App />);
    const section = await screen.findByTestId('follow-up-settings');
    expect(section.textContent).toContain('Every follow-up needs your approval');
    expect(
      (screen.getByRole('button', { name: 'Run follow-up check now' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByLabelText('Prepare payment follow-ups'));
    fireEvent.click(screen.getByLabelText('Auto-send first reminder without my approval'));
    expect(screen.getByText('Auto-send is on')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Second reminder (days overdue)'), {
      target: { value: '21' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save follow-up settings' }));
    expect(await screen.findByText('Follow-up settings saved.')).toBeTruthy();
    const patch = calls.find((call) => call.init.method === 'PATCH')!;
    const body = JSON.parse(String(patch.init.body)) as CollectionsSettings;
    expect(body.enabled).toBe(true);
    expect(body.overdue2Days).toBe(21);
    expect(body.autoSend.overdue_1).toBe(true);
    expect(body.autoSend.overdue_2).toBe(false);
    expect(new Headers(patch.init.headers).get('Idempotency-Key')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Run follow-up check now' }));
    expect(await screen.findByText(/Follow-up check queued/)).toBeTruthy();
    await waitFor(() =>
      expect(calls.some((call) => call.url === '/api/collections/scan')).toBe(true),
    );
  });

  it('rejects an out-of-range day offset before calling the server', async () => {
    window.location.hash = '#/settings';
    const calls = stub();
    render(<App />);
    await screen.findByTestId('follow-up-settings');
    fireEvent.change(screen.getByLabelText('First reminder (days overdue)'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save follow-up settings' }));
    expect(await screen.findByText('Each stage must be 1 to 365 days.')).toBeTruthy();
    expect(calls.some((call) => call.init.method === 'PATCH')).toBe(false);
  });
});

describe('calendar feed settings', () => {
  it('shows the feed URL once after creating it and offers revoke', async () => {
    window.location.hash = '#/settings';
    let active = false;
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push(`${init.method ?? 'GET'} ${url}`);
        if (url === '/api/me') return json(200, state.user);
        if (url === '/api/state') return json(200, state);
        if (url === '/api/settings/collections') return json(200, defaults);
        if (url === '/api/calendar/feed-token' && init.method === 'POST') {
          active = true;
          return json(201, {
            url: 'http://localhost/calendar/feed/abc.ics',
            createdAt: '2026-10-20T00:00:00Z',
          });
        }
        if (url === '/api/calendar/feed-token' && init.method === 'DELETE') {
          active = false;
          return json(200, { revoked: true });
        }
        if (url === '/api/calendar/feed-token')
          return json(200, { active, createdAt: null, lastUsedAt: null });
        return json(404, { error: 'NOT_FOUND', message: 'Not found' });
      }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create feed link' }));
    expect((await screen.findByTestId('calendar-feed-url')).textContent).toBe(
      'http://localhost/calendar/feed/abc.ics',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Revoke link' }));
    await waitFor(() => expect(screen.queryByTestId('calendar-feed-url')).toBeNull());
    expect(await screen.findByRole('button', { name: 'Create feed link' })).toBeTruthy();
    expect(calls).toContain('DELETE /api/calendar/feed-token');
  });
});

describe('business data export', () => {
  it('offers the JSON export and the archive with files to the owner', async () => {
    window.location.hash = '#/settings';
    stub();
    render(<App />);
    const zip = await screen.findByRole('link', { name: 'Download with files (.zip)' });
    expect(zip.getAttribute('href')).toBe('/api/export?format=zip');
    expect(screen.getByRole('link', { name: 'Export business data' }).getAttribute('href')).toBe(
      '/api/export',
    );
  });
});
