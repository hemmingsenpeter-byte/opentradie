import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AppState } from './types';

/**
 * Customer tags, duplicates and insights against a stubbed fetch (ADR 0034). Not evidence the
 * real API works (tests/integration/crm.test.ts covers that).
 */
const A = '11111111-1111-4111-8111-11111111111a';
const B = '11111111-1111-4111-8111-11111111111b';
const VIP = { id: '99999999-9999-4999-8999-999999999999', name: 'vip', colour: 'green' };

function makeState(role: 'owner' | 'viewer'): AppState {
  return {
    business: {
      id: 'b',
      name: 'Demo',
      currency: 'NZD',
      timeZone: 'Pacific/Auckland',
      taxBasisPoints: 1500,
    },
    user: { id: 'u', email: `${role}@demo.test`, role },
    customers: [
      { id: A, name: 'Kiri Walker', phone: '021 555 0101', tags: [VIP] },
      { id: B, name: 'K Walker', phone: '+64 21 555 0101', tags: [] },
    ],
    jobs: [],
    communications: [],
    quotes: [],
    rates: [],
    auditEvents: [],
    settings: { profile: 'local', privacyMode: 'LOCAL_ONLY', agentMode: 'mock', agentHealth: 'ok' },
  };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const report = {
  range: { from: '2026-04-01', to: '2027-03-31' },
  rows: [
    {
      customerId: A,
      name: 'Kiri Walker',
      jobs: 2,
      quotesSent: 2,
      quotesAccepted: 1,
      winRateBp: 5000,
      invoicedExclCents: 100_000,
      invoicedGstCents: 15_000,
      invoicedInclCents: 115_000,
      paidCents: 15_000,
      outstandingCents: 100_000,
      firstJobDate: '2026-05-01',
      lastJobDate: '2026-06-01',
      repeat: true,
    },
  ],
  summary: {
    customers: 1,
    newCustomers: 1,
    repeatCustomers: 1,
    quotesSent: 2,
    quotesAccepted: 1,
    winRateBp: 5000,
    invoicedExclCents: 100_000,
    invoicedGstCents: 15_000,
    invoicedInclCents: 115_000,
    paidCents: 15_000,
    outstandingCents: 100_000,
    averageDaysToPay: 9,
    topCustomers: [{ customerId: A, name: 'Kiri Walker', invoicedInclCents: 115_000 }],
  },
};

function stub(role: 'owner' | 'viewer') {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url === '/api/me') return json(200, makeState(role).user);
      if (url === '/api/state') return json(200, makeState(role));
      if (url === '/api/tags')
        return json(200, { tags: [{ ...VIP, customerCount: 1, createdAt: 'x' }] });
      if (url.startsWith('/api/reports/customers')) return json(200, report);
      if (url === '/api/customers/duplicates')
        return json(200, {
          pairs: [
            {
              score: 50,
              reasons: ['phone'],
              customers: [
                {
                  id: A,
                  name: 'Kiri Walker',
                  email: null,
                  phone: '021 555 0101',
                  address: null,
                  jobCount: 1,
                  createdAt: 'x',
                },
                {
                  id: B,
                  name: 'K Walker',
                  email: null,
                  phone: '+64 21 555 0101',
                  address: null,
                  jobCount: 2,
                  createdAt: 'x',
                },
              ],
            },
          ],
        });
      if (url.includes('/merge-preview'))
        return json(200, {
          source: { id: B, name: 'K Walker' },
          into: { id: A, name: 'Kiri Walker' },
          alreadyMerged: false,
          moves: { jobs: 2 },
          duplicatePropertiesArchived: 0,
          warnings: [
            {
              code: 'ACCOUNTING_CONTACT_NOT_MERGED',
              message: 'Merge the contact in Xero yourself.',
            },
          ],
        });
      if (url.endsWith('/merge'))
        return json(200, { merged: true, alreadyMerged: false, moves: { jobs: 2 } });
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

describe('customer tags, duplicates and insights', () => {
  it('shows tag chips and filters the list by tag', async () => {
    stub('viewer');
    window.location.hash = '#/customers';
    render(<App />);
    expect(await screen.findByRole('list', { name: 'Tags for Kiri Walker' })).toBeTruthy();
    expect(screen.getByText('K Walker')).toBeTruthy();
    fireEvent.change(await screen.findByLabelText('Filter by tag'), { target: { value: VIP.id } });
    await waitFor(() => expect(screen.queryByText('K Walker')).toBeNull());
    expect(screen.getByText('Kiri Walker')).toBeTruthy();
  });

  it('reviews a duplicate pair, shows the accounting warning and merges after typing the name', async () => {
    const calls = stub('owner');
    window.location.hash = '#/customers/duplicates';
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Review/ }));
    expect(await screen.findByText('Merge the contact in Xero yourself.')).toBeTruthy();
    const merge = screen.getByRole('button', {
      name: 'Merge into Kiri Walker',
    }) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type "Kiri Walker" to confirm the merge'), {
      target: { value: 'kiri walker' },
    });
    expect(merge.disabled).toBe(false);
    fireEvent.click(merge);
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/merge'))).toBe(true));
    const sent = calls.find((call) => call.url.endsWith('/merge'))!;
    expect(sent.url).toBe(`/api/customers/${B}/merge`);
    expect(JSON.parse(String(sent.init.body))).toEqual({ intoId: A, confirm: 'kiri walker' });
  });

  it('shows report tiles and a sortable table with a CSV link', async () => {
    stub('viewer');
    window.location.hash = '#/customers/insights';
    render(<App />);
    const tiles = await screen.findByRole('list', { name: 'Summary' });
    expect(within(tiles).getByText('50.00%')).toBeTruthy();
    expect(within(tiles).getAllByText(/\$1,150\.00/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Download CSV' }).getAttribute('href')).toContain(
      'format=csv',
    );
    const header = screen.getByRole('columnheader', { name: 'Invoiced (incl. GST)' });
    expect(header.getAttribute('aria-sort')).toBe('descending');
    fireEvent.click(within(header).getByRole('button'));
    expect(header.getAttribute('aria-sort')).toBe('ascending');
  });
});
