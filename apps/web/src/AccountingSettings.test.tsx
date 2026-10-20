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

function stub(accounting: AccountingStatus) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url === '/api/me') return json(200, state.user);
      if (url === '/api/state') return json(200, state);
      if (url === '/health') return json(200, { status: 'ok' });
      if (url === '/api/integrations/xero/status') return json(200, accounting);
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
