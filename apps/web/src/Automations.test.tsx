import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AppState } from './types';

/** Settings › Automations with a stubbed fetch; the server validates, summarises and runs. */
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

const definition = {
  name: 'Thank-you and review request',
  trigger: {
    event: 'job.completed',
    filter: { field: 'job.title', op: 'not_contains', value: 'warranty' },
  },
  delay: { days: 1, at: '09:00' },
  actions: [{ tool: 'communication.draft', channel: 'email', text: 'Hi {{customer.firstName}}' }],
};
const SUMMARY =
  'When a job is completed and the job title does not contain "warranty", 1 day later at 09:00: draft an email message.';
const catalogue = {
  templates: [
    {
      key: 'review_request',
      title: 'Thank-you and review request',
      description: 'd',
      definition,
      summary: SUMMARY,
    },
  ],
  events: [{ name: 'job.completed', title: 'a job is completed', entity: 'job' }],
  facts: [{ name: 'job.title', type: 'text', label: 'job title' }],
  placeholders: [{ name: 'customer.firstName', label: 'Customer first name' }],
};
const json = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json' },
  });

function stub() {
  const calls: { url: string; init: RequestInit }[] = [];
  let automations: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url === '/api/me') return json(200, state.user);
      if (url === '/api/state') return json(200, state);
      if (url === '/health') return json(200, { status: 'ok' });
      if (url === '/api/automations/templates') return json(200, catalogue);
      if (url === '/api/automations' && init.method === 'POST') {
        automations = [
          {
            id: 'a1',
            name: definition.name,
            definition,
            summary: SUMMARY,
            trigger: 'job.completed',
            version: 1,
            enabled: true,
            source: 'manual',
            lastRun: null,
          },
        ];
        return json(201, { automation: automations[0] });
      }
      if (url === '/api/automations')
        return json(200, {
          automations,
          builtIn: [
            {
              key: 'payment_follow_ups',
              name: 'Payment follow-ups',
              summary: 'Overdue reminders.',
              configure: { label: 'Settings › Payment follow-ups', href: '#/settings' },
            },
          ],
        });
      if (url === '/api/automations/validate') return json(200, { ok: true, summary: SUMMARY });
      if (url.startsWith('/api/automations/events')) return json(200, { events: [] });
      if (url === '/api/automations/a1/runs')
        return json(200, {
          runs: [
            {
              id: 'r',
              event: 'job.completed',
              status: 'skipped',
              outcomeCode: 'condition_cleared',
              scheduledFor: '2026-11-02T20:00:00Z',
              proposalIds: [],
              createdAt: '2026-11-02T02:00:00Z',
            },
          ],
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

describe('automations settings', () => {
  it('enables a template, shows the server summary, built-ins and run history', async () => {
    window.location.hash = '#/settings';
    const calls = stub();
    render(<App />);
    const section = await screen.findByTestId('automations');
    expect(section.textContent).toContain('No automations yet');
    expect(section.textContent).toContain('Payment follow-ups');
    fireEvent.click(
      within(section).getByRole('button', { name: 'Use Thank-you and review request' }),
    );
    await waitFor(() =>
      expect(within(section).getByTestId('automation-item').textContent).toContain(SUMMARY),
    );
    const post = calls.find(
      (call) => call.url === '/api/automations' && call.init.method === 'POST',
    )!;
    expect(JSON.parse(String(post.init.body))).toEqual({
      templateKey: 'review_request',
      enabled: true,
    });
    expect(new Headers(post.init.headers).get('Idempotency-Key')).toBeTruthy();

    fireEvent.click(
      within(section).getByRole('button', { name: 'Edit Thank-you and review request' }),
    );
    const editor = await screen.findByTestId('automation-editor');
    expect(within(editor).getAllByTestId('condition-row')).toHaveLength(1);
    fireEvent.click(within(editor).getByRole('button', { name: 'Customer first name' }));
    expect((within(editor).getByLabelText('Action 1 message') as HTMLTextAreaElement).value).toBe(
      'Hi {{customer.firstName}}{{customer.firstName}}',
    );
    await waitFor(() =>
      expect(within(editor).getByTestId('automation-summary').textContent).toContain('1 day later'),
    );
    expect((await within(editor).findByTestId('automation-runs')).textContent).toContain(
      'condition cleared',
    );
  });
});
