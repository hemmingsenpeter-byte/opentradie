import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  basisPointsToText,
  centsToText,
  formatGstNumber,
  milliToText,
  parseCents,
  parsePercentBasisPoints,
  parseQuantityMilli,
} from './format';
import { acceptanceTokenFromPath, PublicQuoteScreen } from './screens/PublicQuote';
import type { PublicQuote } from './types';

/**
 * Client contract tests with a stubbed fetch; not evidence that the real API works
 * (tests/integration/quotes-acceptance.test.ts covers the server).
 */
describe('exact decimal input parsing', () => {
  it('parses quantities, money and percentages without floating point', () => {
    expect(parseQuantityMilli('1.5')).toBe(1500);
    expect(parseQuantityMilli('0.125')).toBe(125);
    expect(parseQuantityMilli('1.2345')).toBeNull();
    expect(parseCents('$1,234.5')).toBe(123_450);
    expect(parseCents('0.29')).toBe(29);
    expect(parseCents('-1')).toBeNull();
    expect(parseCents('abc')).toBeNull();
    expect(parsePercentBasisPoints('12.5')).toBe(1250);
    expect(milliToText(1500)).toBe('1.5');
    expect(centsToText(1250)).toBe('12.50');
    expect(basisPointsToText(2500)).toBe('25');
    expect(formatGstNumber('136410132')).toBe('136-410-132');
  });

  it('recognises only well-formed acceptance paths', () => {
    const token = 'a'.repeat(43);
    expect(acceptanceTokenFromPath(`/q/${token}`)).toBe(token);
    expect(acceptanceTokenFromPath('/q/short')).toBeNull();
    expect(acceptanceTokenFromPath('/')).toBeNull();
  });
});

const TOKEN = 'T'.repeat(43);
const VIEW: PublicQuote = {
  status: 'sent',
  title: 'Quote',
  quoteNumber: 'Q-0007',
  revision: 1,
  business: { name: 'Harbour Electrical · Demo', gstNumberLabel: 'GST No. 49-091-850' },
  customerName: 'Mrs Johnson',
  siteLabel: null,
  dates: [{ label: 'Valid until', value: '18 November 2026' }],
  validUntil: '18 November 2026',
  amountColumnLabel: 'Amount (excl. GST)',
  lines: [
    { description: 'Labour', quantity: '1.5', unit: 'h', unitPrice: '$110.00', amount: '$165.00' },
  ],
  totals: [
    { label: 'Subtotal (excl. GST)', value: '$165.00', emphasis: false },
    { label: 'GST 15%', value: '$24.75', emphasis: false },
    { label: 'Total (incl. GST)', value: '$189.75', emphasis: true },
  ],
  notes: ['This quote is valid until 18 November 2026.'],
  totalCents: 18_975,
  decision: null,
};

afterEach(cleanup);

describe('public acceptance page', () => {
  it('shows server totals and posts the typed name to the accept route', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const body =
          init?.method === 'POST'
            ? {
                ...VIEW,
                status: 'accepted',
                decision: {
                  decision: 'accepted',
                  signerName: 'Margaret Johnson',
                  decidedAt: '2026-10-19T00:00:00Z',
                },
              }
            : VIEW;
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    render(<PublicQuoteScreen token={TOKEN} />);
    expect(await screen.findByText('$189.75')).toBeTruthy();
    expect(screen.getByText('GST No. 49-091-850')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept quote' }));
    expect(await screen.findByText(/Type your full name/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Your full name/), {
      target: { value: 'Margaret Johnson' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Accept quote' }));
    await waitFor(() => expect(screen.getByText('Quote accepted')).toBeTruthy());
    const post = calls.find((call) => call.init?.method === 'POST')!;
    expect(post.url).toBe(`/api/public/quotes/${TOKEN}/accept`);
    expect(JSON.parse(String(post.init!.body))).toEqual({ name: 'Margaret Johnson' });
    vi.unstubAllGlobals();
  });

  it('explains an expired link', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: 'QUOTE_EXPIRED', message: 'expired', requestId: 'r' }),
            { status: 410 },
          ),
      ),
    );
    render(<PublicQuoteScreen token={TOKEN} />);
    expect(await screen.findByText('This quote has expired')).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
