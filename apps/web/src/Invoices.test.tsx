import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AccountingStatus, AppState, Invoice } from './types';

/**
 * Invoice screen contract tests with a stubbed fetch. They check what the client sends and
 * shows; they are not evidence that the API or any accounting integration works
 * (tests/integration/invoices-accounting.test.ts covers the server).
 */
const INVOICE_ID = '55555555-5555-4555-8555-555555555555';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

function appState(role: 'owner' | 'viewer'): AppState {
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
      { id: JOB_ID, customerId: CUSTOMER_ID, title: 'Kitchen', status: 'completed', notes: null },
    ],
    communications: [],
    quotes: [],
    rates: [{ code: 'call_out', label: 'Call-out fee', unit: 'visit', unitPriceCents: 9_500 }],
    auditEvents: [],
    settings: { profile: 'local', privacyMode: 'LOCAL_ONLY', agentMode: 'mock', agentHealth: 'ok' },
  } as AppState;
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: INVOICE_ID,
    invoiceNumber: 'INV-0007',
    status: 'draft',
    version: 3,
    jobId: JOB_ID,
    jobTitle: 'Kitchen',
    customerId: CUSTOMER_ID,
    customerName: 'Mrs Johnson',
    sourceQuoteId: null,
    issueDate: '2026-10-20',
    dueDate: '2026-11-09',
    currency: 'NZD',
    gstRegistered: true,
    pricesEntered: 'exclusive',
    taxBasisPoints: 1500,
    subtotalCents: 16_500,
    taxCents: 2_475,
    totalCents: 18_975,
    notes: null,
    lines: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        rateCode: 'labour_hour',
        description: 'Electrician labour',
        unit: 'hour',
        quantity: 1.5,
        quantityMilli: 1500,
        kind: 'labour',
        taxCode: 'standard',
        priceSource: 'approved_rate',
        unitPriceCents: 11_000,
        discountBasisPoints: 0,
        lineTotalCents: 16_500,
        sourceType: 'time_entry',
      },
    ],
    createdAt: '2026-10-20T00:00:00Z',
    approvedAt: null,
    voidedAt: null,
    pdfAvailable: false,
    readiness: { tier: 'up_to_1000', missing: [], problems: [] },
    accounting: {
      provider: null,
      externalInvoiceId: null,
      providerInvoiceNumber: null,
      providerStatus: null,
      providerTotalCents: null,
      postedAt: null,
      amountPaidCents: null,
      amountDueCents: null,
      lastReconciledAt: null,
      syncError: null,
      attempts: [],
      warnings: [],
    },
    ...overrides,
  };
}

const accounting: AccountingStatus = {
  provider: 'fake',
  mock: true,
  label: 'Fake accounting (mock, not a real integration)',
  status: 'connected',
  statusReason: null,
  organisationId: 'fake-organisation-0001',
  pendingOrganisations: [],
  connectedAt: '2026-10-20T00:00:00Z',
  syncFailures: [],
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(
  role: 'owner' | 'viewer',
  handler: (url: string, init: RequestInit) => Response | null,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const state = appState(role);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url === '/api/me') return json(200, state.user);
      if (url === '/api/state') return json(200, state);
      if (url === '/api/integrations/xero/status') return json(200, accounting);
      return handler(url, init) ?? json(404, { error: 'NOT_FOUND', message: 'Not found' });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('invoice detail', () => {
  it('shows the explicit missing-information list when approval is refused', async () => {
    window.location.hash = `#/invoices/${INVOICE_ID}`;
    const calls = stub('owner', (url, init) => {
      if (url === `/api/invoices/${INVOICE_ID}`) return json(200, invoice());
      if (url.endsWith('/approve') && init.method === 'POST')
        return json(422, {
          error: 'INVOICE_INCOMPLETE',
          message: 'The invoice is missing information.',
          missing: ['supplier GST number'],
          problems: [],
        });
      return null;
    });
    render(<App />);
    expect(await screen.findByText('INV-0007')).toBeTruthy();
    expect(screen.getByText(/Mock accounting adapter/)).toBeTruthy();
    expect(screen.getByTestId('invoice-total').textContent).toContain('189.75');
    fireEvent.click(screen.getByRole('button', { name: 'Approve invoice' }));
    expect(await screen.findByText('supplier GST number')).toBeTruthy();
    const approve = calls.find((call) => call.url.endsWith('/approve'))!;
    expect(JSON.parse(String(approve.init.body))).toEqual({ version: 3 });
    expect(new Headers(approve.init.headers).get('Idempotency-Key')).toMatch(
      /^[A-Za-z0-9_-]{8,128}$/,
    );
  });

  it('edits a draft by sending quantities and rate codes only, never prices', async () => {
    window.location.hash = `#/invoices/${INVOICE_ID}`;
    const calls = stub('owner', (url, init) => {
      if (url === `/api/invoices/${INVOICE_ID}` && init.method === 'PATCH')
        return json(200, invoice({ version: 4 }));
      if (url === `/api/invoices/${INVOICE_ID}`) return json(200, invoice());
      return null;
    });
    render(<App />);
    fireEvent.change(await screen.findByLabelText(/Quantity · Electrician labour/), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('Add a line from an approved rate'), {
      target: { value: 'call_out' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((call) => call.init.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.init.method === 'PATCH')!;
    expect(JSON.parse(String(patch.init.body))).toEqual({
      version: 3,
      lines: [
        { lineId: '66666666-6666-4666-8666-666666666666', quantityMilli: 2000 },
        { source: 'approved_rate', rateCode: 'call_out', quantityMilli: 1000 },
      ],
    });
  });

  it('shows posting status, the ledger id and sync failures with a retry for the owner', async () => {
    window.location.hash = `#/invoices/${INVOICE_ID}`;
    const failed = invoice({
      status: 'sync_failed',
      approvedAt: '2026-10-20T01:00:00Z',
      pdfAvailable: true,
      accounting: {
        ...invoice().accounting,
        syncError: {
          kind: 'reauthorisation_required',
          message: 'The accounting connection has expired or was revoked.',
          issues: [],
        },
        attempts: [
          {
            attempt: 1,
            status: 'failed',
            errorKind: 'reauthorisation_required',
            startedAt: '2026-10-20T01:00:00Z',
            finishedAt: '2026-10-20T01:00:01Z',
          },
        ],
      },
    });
    const calls = stub('owner', (url, init) => {
      if (url.endsWith('/retry-sync') && init.method === 'POST')
        return json(200, { ...failed, status: 'approved', accounting: invoice().accounting });
      if (url === `/api/invoices/${INVOICE_ID}`) return json(200, failed);
      return null;
    });
    render(<App />);
    expect(await screen.findByTestId('sync-error')).toBeTruthy();
    expect(screen.getByText('Reconnect in Settings')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download PDF' }).getAttribute('href')).toBe(
      `/api/invoices/${INVOICE_ID}/pdf`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry sync' }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/retry-sync'))).toBe(true));
  });

  it('gives a viewer no approve, edit or retry controls', async () => {
    window.location.hash = `#/invoices/${INVOICE_ID}`;
    stub('viewer', (url) => (url === `/api/invoices/${INVOICE_ID}` ? json(200, invoice()) : null));
    render(<App />);
    expect(await screen.findByText('INV-0007')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve invoice' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.getByText(/Only the business owner can approve/)).toBeTruthy();
  });
});

describe('invoice payment follow-ups', () => {
  it('shows the follow-up timeline and lets the owner put follow-ups on hold with a reason', async () => {
    window.location.hash = `#/invoices/${INVOICE_ID}`;
    let held = false;
    const calls = stub('owner', (url, init) => {
      if (url === `/api/invoices/${INVOICE_ID}`)
        return json(200, invoice({ status: 'posted', pdfAvailable: true }));
      if (url === `/api/invoices/${INVOICE_ID}/follow-ups`)
        return json(200, {
          enabled: true,
          hold: held,
          holdReason: held ? 'Disputed' : null,
          next: held
            ? { stage: 'none', reason: 'on_hold', daysOverdue: 9 }
            : { stage: 'none', reason: 'already_prepared', daysOverdue: 9 },
          history: [
            {
              id: 'r1',
              stage: 'overdue_1',
              status: 'prepared',
              reason: null,
              communicationId: 'c1',
              communicationStatus: 'draft',
              threadId: 't1',
              createdAt: '2026-11-18T00:00:00Z',
            },
          ],
        });
      if (url === `/api/invoices/${INVOICE_ID}/collections-hold` && init.method === 'POST') {
        held = true;
        return json(200, { id: INVOICE_ID, hold: true, reason: 'Disputed' });
      }
      return null;
    });
    render(<App />);
    const history = await screen.findByTestId('follow-up-history');
    expect(history.textContent).toContain('First reminder');
    expect(history.textContent).toContain('draft waiting for approval');
    expect(screen.getByRole('link', { name: 'Open in Inbox' }).getAttribute('href')).toBe(
      '#/inbox/t1',
    );
    fireEvent.change(screen.getByLabelText(/Hold reason/), { target: { value: 'Disputed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Put follow-ups on hold' }));
    expect(await screen.findByRole('button', { name: 'Resume follow-ups' })).toBeTruthy();
    expect(screen.getByTestId('follow-up-next').textContent).toMatch(/On hold/);
    const hold = calls.find((call) => call.url.endsWith('/collections-hold'))!;
    expect(JSON.parse(String(hold.init.body))).toEqual({ hold: true, reason: 'Disputed' });
    expect(new Headers(hold.init.headers).get('Idempotency-Key')).toBeTruthy();
  });
});
