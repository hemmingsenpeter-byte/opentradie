import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AppState, Quote } from './types';

/**
 * Component tests with a stubbed fetch. They check the client's contract with the API
 * (what it sends, what it shows); they are not evidence that the real API works.
 */
const QUOTE_ID = '33333333-3333-4333-8333-333333333333';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

function makeState(role: 'owner' | 'viewer', quote: Partial<Quote> = {}): AppState {
  return {
    business: {
      id: 'b',
      name: 'Harbour Electrical · Demo',
      currency: 'NZD',
      timeZone: 'Pacific/Auckland',
      taxBasisPoints: 1500,
    },
    user: { id: 'u', email: `${role}@demo.test`, role },
    customers: [
      {
        id: CUSTOMER_ID,
        name: 'Mrs Johnson',
        email: 'johnson@example.test',
        phone: '+64 21 555 0101',
      },
    ],
    jobs: [
      {
        id: JOB_ID,
        customerId: CUSTOMER_ID,
        title: 'Replace requested power points',
        status: 'quoted',
        notes: null,
      },
    ],
    communications: [],
    quotes: [
      {
        id: QUOTE_ID,
        jobId: JOB_ID,
        customerId: CUSTOMER_ID,
        status: 'draft',
        version: 1,
        assumptions: ['Prices use the business-approved rate card.'],
        missingInformation: [],
        // Deliberately not 2 x 8500 + 15%: the UI must show what the server sends, not recompute.
        subtotalCents: 17000,
        taxCents: 2551,
        totalCents: 19551,
        lines: [
          {
            description: 'Replace standard power point',
            quantity: 2,
            unitPriceCents: 8500,
            lineTotalCents: 17000,
          },
        ],
        ...quote,
      },
    ],
    rates: [],
    auditEvents: [],
    settings: {
      profile: 'local',
      privacyMode: 'LOCAL_ONLY',
      agentMode: 'mock',
      agentHealth: 'ok',
      demoData: true,
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi(initial: AppState, onApprove: (init: RequestInit) => Response) {
  let state = initial;
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url === '/api/me') return json(200, state.user);
      if (url === '/api/state') return json(200, state);
      if (url === `/api/quotes/${QUOTE_ID}/approve`) {
        const response = onApprove(init);
        if (response.ok)
          state = {
            ...state,
            quotes: state.quotes.map((quote) => ({
              ...quote,
              status: 'approved',
              version: quote.version + 1,
            })),
          };
        return response;
      }
      return json(404, { error: 'NOT_FOUND', message: 'Page or endpoint not found.' });
    }),
  );
  return calls;
}

beforeAll(() => {
  // jsdom lacks the modal dialog API.
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
beforeEach(() => {
  window.location.hash = `#/quotes/${QUOTE_ID}`;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('quote approval', () => {
  it('shows server totals and lets the owner approve with an idempotent request', async () => {
    const calls = stubApi(makeState('owner'), () =>
      json(200, { id: QUOTE_ID, status: 'approved', version: 2 }),
    );
    render(<App />);

    expect(await screen.findByTestId('quote-total')).toHaveProperty('textContent', '$195.51');
    expect(
      screen.getByText('Mock agent — not a real AI', { selector: '.mock-strip *' }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Approve quote' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve this quote?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, approve' }));

    await screen.findByText('Quote approved');
    const approve = calls.find((call) => call.url.endsWith('/approve'));
    expect(approve?.init.method).toBe('POST');
    expect(JSON.parse(String(approve?.init.body))).toEqual({ version: 1 });
    const headers = new Headers(approve?.init.headers);
    expect(headers.get('Idempotency-Key')).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('disables approval for viewers and explains why', async () => {
    const calls = stubApi(makeState('viewer'), () =>
      json(403, {
        error: 'OWNER_REQUIRED',
        message: 'Only the business owner can make this change.',
      }),
    );
    render(<App />);

    const approve = await screen.findByRole('button', { name: 'Approve quote' });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/only the business owner can approve or reject quotes/i)).toBeTruthy();
    expect(calls.some((call) => call.url.endsWith('/approve'))).toBe(false);
  });

  it('surfaces a server 403 instead of pretending the approval worked', async () => {
    stubApi(makeState('owner'), () =>
      json(403, {
        error: 'OWNER_REQUIRED',
        message: 'Only the business owner can make this change.',
        requestId: 'r1',
      }),
    );
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Approve quote' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve this quote?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, approve' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('Not allowed');
    expect(alert.textContent).toContain('Only the business owner can make this change.');
    await waitFor(() => expect(screen.queryByText('Quote approved')).toBeNull());
  });
});
