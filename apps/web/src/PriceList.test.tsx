import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AppState, ManagedRate } from './types';

/** Settings › Price list with a stubbed fetch; prices go to the server as text. */
const owner = { id: 'u', email: 'owner@demo.test', role: 'owner' };
const baseState = {
  business: {
    id: 'b',
    name: 'Harbour Electrical · Demo',
    currency: 'NZD',
    timeZone: 'Pacific/Auckland',
    taxBasisPoints: 1500,
    gstRegistered: true,
    pricesEntered: 'exclusive',
  },
  user: owner,
  customers: [],
  jobs: [],
  communications: [],
  quotes: [],
  rates: [],
  auditEvents: [],
  settings: { profile: 'local', privacyMode: 'LOCAL_ONLY', agentMode: 'mock', agentHealth: 'ok' },
} as unknown as AppState;

const rate = (code: string, label: string, cents: number, active = true): ManagedRate => ({
  code,
  label,
  unit: 'each',
  unitPriceCents: cents,
  active,
  approvedAt: '2026-10-01T00:00:00.000Z',
  retiredAt: active ? null : '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

const json = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json' },
  });

function stub(user = owner) {
  const rates = [
    rate('call_out', 'Call-out fee', 9_500),
    rate('old_rate', 'Old service', 1_000, false),
  ];
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (url === '/api/me') return json(200, user);
      if (url === '/api/state') return json(200, { ...baseState, user });
      if (url === '/api/rates?includeRetired=true') return json(200, { rates });
      if (url === '/api/rates' && init.method === 'POST') {
        const created = rate(body.code, body.label, 12_345);
        rates.push(created);
        return json(201, { rate: created });
      }
      if (url === '/api/rates/call_out/retire') {
        rates[0] = { ...rates[0]!, active: false };
        return json(200, { rate: rates[0] });
      }
      if (url === '/api/rates/call_out/history')
        return json(200, {
          code: 'call_out',
          versions: [
            {
              change: 'updated',
              label: 'Call-out fee',
              unit: 'visit',
              unitPriceCents: 9_500,
              active: true,
              changedBy: 'Owner',
              effectiveFrom: '2026-10-03T00:00:00.000Z',
            },
            {
              change: 'created',
              label: 'Call-out fee',
              unit: 'visit',
              unitPriceCents: 8_000,
              active: true,
              changedBy: 'Owner',
              effectiveFrom: '2026-10-01T00:00:00.000Z',
            },
          ],
        });
      if (url === '/api/rates/import')
        return json(200, {
          mode: body.mode,
          priceColumn: 'price_excl_gst_nzd',
          errors: [],
          create: [{ code: 'new_rate', label: 'New rate', unit: 'hour', unitPriceCents: 5_000 }],
          update: [],
          unchanged: ['call_out'],
          notInFile: [],
          retiredInFile: [],
          applied: body.mode === 'apply',
        });
      return json(404, { error: 'NOT_FOUND', message: 'Not found' });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('price list', () => {
  it('lists rates with status, adds a rate sending the typed price as text, and retires', async () => {
    window.location.hash = '#/settings/rates';
    const calls = stub();
    render(<App />);
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]!.textContent).toContain('Call-out fee');
    expect(rows[1]!.textContent).toContain('Active');
    expect(rows[2]!.textContent).toContain('Retired');
    expect(screen.getByRole('button', { name: 'Reactivate Old service' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add rate' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    fireEvent.change(within(dialog).getByLabelText(/^Code/), { target: { value: 'heat_pump' } });
    fireEvent.change(within(dialog).getByLabelText('Description'), {
      target: { value: 'Heat pump service' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Price/), { target: { value: '$123.45' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add rate', hidden: true }));
    await screen.findByText('“Heat pump service” added.');
    const post = calls.find((c) => c.url === '/api/rates' && c.init.method === 'POST')!;
    expect(JSON.parse(String(post.init.body))).toEqual({
      code: 'heat_pump',
      label: 'Heat pump service',
      unit: 'each',
      price: '$123.45',
    });
    expect(new Headers(post.init.headers).get('Idempotency-Key')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retire Call-out fee' }));
    await screen.findByText('“Call-out fee” retired.');
  });

  it('shows price history and an import preview before applying', async () => {
    window.location.hash = '#/settings/rates';
    const calls = stub();
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'History of Call-out fee' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    await waitFor(() => expect(dialog.textContent).toContain('$80.00'));
    expect(dialog.textContent).toContain('Changed');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close', hidden: true }));

    const file = new File(
      ['code,description,unit,price_excl_gst_nzd\nnew_rate,New rate,hour,50\n'],
      'rates.csv',
      {
        type: 'text/csv',
      },
    );
    fireEvent.change(screen.getByLabelText('Import a CSV file'), { target: { files: [file] } });
    const preview = await screen.findByRole('region', { name: 'Preview of rates.csv' });
    expect(preview.textContent).toContain('New rates (1)');
    expect(preview.textContent).toContain('$50.00');
    expect(calls.filter((c) => c.url === '/api/rates/import')).toHaveLength(1);
    fireEvent.click(within(preview).getByRole('button', { name: 'Apply import' }));
    await screen.findByText('Imported: 1 added, 0 changed.');
    const modes = calls
      .filter((c) => c.url === '/api/rates/import')
      .map((c) => JSON.parse(String(c.init.body)).mode);
    expect(modes).toEqual(['preview', 'apply']);
  });

  it('is read-only for a viewer', async () => {
    window.location.hash = '#/settings/rates';
    stub({ id: 'v', email: 'viewer@demo.test', role: 'viewer' });
    render(<App />);
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Add rate' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Retire/ })).toBeNull();
    expect(screen.getByText('Only the business owner can change the price list.')).toBeTruthy();
  });
});
