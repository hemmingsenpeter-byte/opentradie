import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AppState, JobDetail } from './types';

/**
 * Job card and property UI against a stubbed fetch. These check what the client sends and
 * shows; they are not evidence that the real API works (see tests/integration/job-cards.test.ts).
 */
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const PROPERTY_ID = '44444444-4444-4444-8444-444444444444';

const property = {
  id: PROPERTY_ID,
  customerId: CUSTOMER_ID,
  label: 'Home',
  addressLine1: '14 Kauri Street',
  accessNotes: 'Dog on the property.',
  address: '14 Kauri Street, Grey Lynn, Auckland 1021',
};

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
    customers: [{ id: CUSTOMER_ID, name: 'Mrs Johnson', phone: '+64 21 555 0101' }],
    properties: [property],
    jobs: [
      {
        id: JOB_ID,
        customerId: CUSTOMER_ID,
        title: 'Replace lounge power points',
        status: 'scheduled',
        propertyId: PROPERTY_ID,
      },
    ],
    communications: [],
    quotes: [],
    rates: [],
    auditEvents: [],
    settings: { profile: 'local', privacyMode: 'LOCAL_ONLY', agentMode: 'mock', agentHealth: 'ok' },
  };
}

function makeDetail(status: JobDetail['job']['status'] = 'scheduled'): JobDetail {
  return {
    job: { id: JOB_ID, customerId: CUSTOMER_ID, title: 'Replace lounge power points', status },
    customer: { id: CUSTOMER_ID, name: 'Mrs Johnson' },
    property,
    nextStatuses:
      status === 'scheduled'
        ? [
            { status: 'in_progress', reopen: false },
            { status: 'cancelled', reopen: false },
          ]
        : [
            { status: 'completed', reopen: false },
            { status: 'cancelled', reopen: false },
          ],
    notes: [
      {
        id: 'n1',
        text: 'Two cracked sockets.',
        provenance: 'user_supplied',
        createdAt: '2026-10-01T00:00:00Z',
      },
    ],
    documents: [
      {
        id: '55555555-5555-4555-8555-555555555555',
        kind: 'photo',
        fileName: 'switchboard.png',
        mediaType: 'image/png',
        sizeBytes: 2048,
        createdAt: '2026-10-01T00:00:00Z',
      },
    ],
    timeline: [
      {
        id: 'e2',
        type: 'status_changed',
        actorType: 'user',
        actorName: 'Demo Owner',
        fromStatus: 'new',
        toStatus: 'scheduled',
        summary: 'Status changed',
        noteText: null,
        createdAt: '2026-10-02T00:00:00Z',
      },
      {
        id: 'e1',
        type: 'created',
        actorType: 'user',
        actorName: 'Demo Owner',
        fromStatus: null,
        toStatus: 'new',
        summary: 'Job created',
        noteText: null,
        createdAt: '2026-10-01T00:00:00Z',
      },
    ],
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi(role: 'owner' | 'viewer') {
  const state = makeState(role);
  let detail = makeDetail();
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url === '/api/me') return json(200, state.user);
      if (url === '/api/state') return json(200, state);
      if (url === `/api/jobs/${JOB_ID}` && (init.method ?? 'GET') === 'GET')
        return json(200, detail);
      if (url === `/api/jobs/${JOB_ID}` && init.method === 'PATCH') {
        detail = makeDetail('in_progress');
        return json(200, detail.job);
      }
      if (url === `/api/jobs/${JOB_ID}/evidence`)
        return json(201, { ...detail.documents[0], id: '66666666-6666-4666-8666-666666666666' });
      if (url === `/api/customers/${CUSTOMER_ID}/properties`)
        return json(201, { ...property, id: '77777777-7777-4777-8777-777777777777' });
      return json(404, { error: 'NOT_FOUND', message: 'Page or endpoint not found.' });
    }),
  );
  return calls;
}

beforeEach(() => {
  window.location.hash = `#/jobs/${JOB_ID}`;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('job card', () => {
  it('shows the site, history and only the valid next statuses, and changes status idempotently', async () => {
    const calls = stubApi('owner');
    render(<App />);

    const group = await screen.findByRole('group', { name: 'Change status' });
    const buttons = within(group)
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(buttons).toEqual(['In progress', 'Cancelled']);
    expect(screen.getByText('14 Kauri Street, Grey Lynn, Auckland 1021')).toBeTruthy();
    expect(screen.getByText('Access: Dog on the property.')).toBeTruthy();
    const history = screen.getByRole('list', { name: 'Job history' });
    expect(within(history).getByText(/Scheduled/)).toBeTruthy();
    expect(within(history).getByText('Job created')).toBeTruthy();
    const photo = screen.getByRole('img', { name: 'switchboard.png' });
    expect(photo.getAttribute('src')).toBe(
      '/api/documents/55555555-5555-4555-8555-555555555555/content',
    );

    const input = screen.getByTestId('evidence-input');
    expect(input.getAttribute('accept')).toBe('image/*,application/pdf');
    expect(input.getAttribute('capture')).toBe('environment');

    fireEvent.click(within(group).getByRole('button', { name: 'In progress' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('group', { name: 'Change status' }))
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual(['Completed', 'Cancelled']),
    );
    const patch = calls.find((call) => call.init.method === 'PATCH');
    expect(JSON.parse(String(patch?.init.body))).toEqual({ status: 'in_progress' });
    expect(new Headers(patch?.init.headers).get('Idempotency-Key')).toMatch(
      /^[A-Za-z0-9_-]{8,128}$/,
    );
  });

  it('uploads a photo as base64 with the detected type', async () => {
    const calls = stubApi('owner');
    render(<App />);
    const input = await screen.findByTestId('evidence-input');
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'site.png', {
      type: 'image/png',
    });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/evidence'))).toBe(true));
    const upload = calls.find((call) => call.url.endsWith('/evidence'))!;
    expect(JSON.parse(String(upload.init.body))).toEqual({
      fileName: 'site.png',
      mediaType: 'image/png',
      dataBase64: 'iVBORw==',
    });
    expect(new Headers(upload.init.headers).get('Idempotency-Key')).toBeTruthy();
  });

  it('refuses unsupported files before uploading', async () => {
    const calls = stubApi('owner');
    render(<App />);
    const input = await screen.findByTestId('evidence-input');
    fireEvent.change(input, {
      target: { files: [new File(['<html>'], 'page.html', { type: 'text/html' })] },
    });
    expect(
      await screen.findByText('Choose a JPEG, PNG, WebP or HEIC photo, or a PDF.'),
    ).toBeTruthy();
    expect(calls.some((call) => call.url.endsWith('/evidence'))).toBe(false);
  });

  it('gives viewers the job card without status or upload controls', async () => {
    stubApi('viewer');
    render(<App />);
    expect(await screen.findByRole('list', { name: 'Job history' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Change status' })).toBeNull();
    expect(screen.queryByTestId('evidence-input')).toBeNull();
  });
});

describe('customer properties', () => {
  it('lists properties and adds one', async () => {
    const calls = stubApi('owner');
    window.location.hash = `#/customers/${CUSTOMER_ID}`;
    render(<App />);
    const list = await screen.findByRole('list', { name: 'Properties' });
    expect(within(list).getByText('14 Kauri Street, Grey Lynn, Auckland 1021')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add property' }));
    const form = screen.getByRole('form', { name: 'Add property' });
    fireEvent.change(within(form).getByLabelText('Street address'), {
      target: { value: '88 Totara Avenue' },
    });
    fireEvent.change(within(form).getByLabelText(/Suburb/), { target: { value: 'Henderson' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save property' }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/properties'))).toBe(true));
    const create = calls.find((call) => call.url.endsWith('/properties'))!;
    expect(JSON.parse(String(create.init.body))).toEqual({
      addressLine1: '88 Totara Avenue',
      suburb: 'Henderson',
    });
    expect(new Headers(create.init.headers).get('Idempotency-Key')).toBeTruthy();
  });
});
