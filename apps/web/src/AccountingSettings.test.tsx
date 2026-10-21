import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AccountingStatus, AppState } from './types';

/** Settings › Accounting with a stubbed fetch; not evidence that Xero or the API works. */
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

const status = (overrides: Partial<AccountingStatus>): AccountingStatus => ({
  provider: 'fake',
  mock: true,
  label: 'Fake accounting (mock, not a real integration)',
  status: 'disconnected',
  statusReason: null,
  organisationId: null,
  pendingOrganisations: [],
  connectedAt: null,
  syncFailures: [],
  ...overrides,
});

const json = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json' },
  });

function stub(accounting: AccountingStatus, mail?: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url === '/api/me') return json(200, state.user);
      if (url === '/api/state') return json(200, state);
      if (url === '/health') return json(200, { status: 'ok' });
      if (url === '/api/integrations/xero/status') return json(200, accounting);
      if (url === '/api/integrations/mail/status' && mail) return json(200, mail);
      if (url === '/api/integrations/mail/fake/disconnect')
        return json(200, { status: 'disconnected' });
      if (url === '/api/integrations/mail/sync')
        return json(200, {
          outcome: 'synced',
          errorCode: null,
          imported: 2,
          duplicates: 0,
          skippedOwn: 0,
          rejected: 0,
          more: false,
          lastSyncedAt: '2026-10-21T00:05:00.000Z',
        });
      if (url === '/api/integrations/xero/disconnect') return json(200, { status: 'disconnected' });
      return json(404, { error: 'NOT_FOUND', message: 'Not found' });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('mail settings', () => {
  it('labels the mock mailbox, shows reauthorisation needed and offers reconnect', async () => {
    window.location.hash = '#/settings';
    stub(status({}), {
      provider: 'fake',
      mock: true,
      label: 'Fake mailbox (mock, not a real integration)',
      status: 'error',
      statusReason: 'reauthorisation_required',
      connectedAt: null,
    });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Reconnect mock mailbox' })).toBeTruthy();
    expect(screen.getAllByText(/Mock mailbox/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('mail-status').textContent).toBe('error');
    expect(screen.getByText(/mailbox connection expired or was revoked/)).toBeTruthy();
  });

  it('lets the owner disconnect a connected mailbox', async () => {
    window.location.hash = '#/settings';
    const calls = stub(status({}), {
      provider: 'fake',
      mock: true,
      label: 'Fake mailbox (mock, not a real integration)',
      status: 'connected',
      statusReason: null,
      connectedAt: '2026-10-20T00:00:00.000Z',
    });
    render(<App />);
    const buttons = await screen.findAllByRole('button', { name: 'Disconnect' });
    fireEvent.click(buttons[0]!);
    await waitFor(() =>
      expect(calls.some((call) => call.url === '/api/integrations/mail/fake/disconnect')).toBe(
        true,
      ),
    );
  });

  it('shows the last mailbox check and lets the owner sync now', async () => {
    window.location.hash = '#/settings';
    const calls = stub(status({}), {
      provider: 'fake',
      mock: true,
      label: 'Fake mailbox (mock, not a real integration)',
      status: 'connected',
      statusReason: null,
      connectedAt: '2026-10-20T00:00:00.000Z',
      lastSyncedAt: null,
    });
    render(<App />);
    expect((await screen.findByTestId('mail-last-synced')).textContent).toBe('Not yet');
    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('Mailbox checked: 2 new messages.')).toBeTruthy();
    const sync = calls.find((call) => call.url === '/api/integrations/mail/sync');
    expect(sync?.init.method).toBe('POST');
  });
});

describe('accounting settings', () => {
  it('labels the mock adapter, offers connect and lists failed syncs', async () => {
    window.location.hash = '#/settings?accounting=invalid_state';
    stub(
      status({
        syncFailures: [
          { invoiceId: 'i1', invoiceNumber: 'INV-0003', kind: 'validation', message: 'Rejected.' },
        ],
      }),
    );
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Connect mock accounting' })).toBeTruthy();
    expect(screen.getAllByText(/Mock accounting adapter/).length).toBeGreaterThan(0);
    expect(screen.getByText(/expired or was already used/)).toBeTruthy();
    expect(screen.getByText('INV-0003')).toBeTruthy();
  });

  it('shows reauthorisation needed and lets the owner disconnect when connected', async () => {
    window.location.hash = '#/settings';
    const calls = stub(status({ status: 'connected', organisationId: 'org' }));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(calls.some((call) => call.url === '/api/integrations/xero/disconnect')).toBe(true),
    );
  });
});
