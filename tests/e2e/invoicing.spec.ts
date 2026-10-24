import { expect, test } from '@playwright/test';

/**
 * Feature 3/4 journey: a completed job with an accepted quote -> "Create invoice" on the job card
 * -> owner approves -> the worker posts it to the FAKE accounting adapter -> a mock payment is
 * read back by "Check payments now" -> Paid. Runs against the real API and PostgreSQL with
 * ACCOUNTING_PROVIDER=fake. This is not evidence that Xero works.
 */
const owner = {
  email: process.env.OWNER_EMAIL ?? 'owner@demo.opentradie.test',
  password: process.env.OWNER_PASSWORD ?? '',
};
const REQUEST =
  'Mrs Johnson needs two power points replaced. Check her existing information and prepare a quote.';

test('owner invoices a completed job, it posts to the mock ledger and is marked paid', async ({
  page,
  baseURL,
}) => {
  test.skip(!owner.password, 'Set OWNER_PASSWORD (pnpm setup:dev writes it to .env).');
  const origin = new URL(baseURL!).origin;
  const headers = (label: string) => ({
    Origin: origin,
    'Idempotency-Key': `e2e-invoice-${label}-${Date.now()}`,
  });

  await page.goto('/');
  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Password').fill(owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  const accounting = (await (await page.request.get('/api/integrations/xero/status')).json()) as {
    provider: string;
    status: string;
  };
  test.skip(
    accounting.provider !== 'fake',
    'Needs ACCOUNTING_PROVIDER=fake, ACCOUNTING_ALLOW_FAKE=true and CREDENTIAL_ENCRYPTION_KEY.',
  );

  // Setup through the API: accepted quote, then the job is completed.
  const state = (await (await page.request.get('/api/state')).json()) as {
    customers: { id: string; name: string }[];
  };
  const johnson = state.customers.find((customer) => customer.name === 'Mrs Johnson')!;
  const enquiry = await page.request.post('/api/enquiries', {
    data: { text: REQUEST, customerId: johnson.id },
    headers: headers('enquiry'),
  });
  expect(enquiry.ok()).toBeTruthy();
  const { quote } = (await enquiry.json()) as {
    quote: { id: string; jobId: string; version: number; totalCents: number };
  };
  const approved = await page.request.post(`/api/quotes/${quote.id}/approve`, {
    data: { version: quote.version },
    headers: headers('quote-approve'),
  });
  expect(approved.ok()).toBeTruthy();
  const sent = await page.request.post(`/api/quotes/${quote.id}/send`, {
    data: { version: ((await approved.json()) as { version: number }).version },
    headers: headers('quote-send'),
  });
  expect(sent.ok()).toBeTruthy();
  const token = new URL(((await sent.json()) as { acceptanceUrl: string }).acceptanceUrl).pathname
    .split('/')
    .at(-1)!;
  const accepted = await page.request.post(`/api/public/quotes/${token}/accept`, {
    data: { name: 'Margaret Johnson' },
    headers: { Origin: origin },
  });
  expect(accepted.ok()).toBeTruthy();
  for (const status of ['in_progress', 'completed']) {
    const moved = await page.request.patch(`/api/jobs/${quote.jobId}`, {
      data: { status },
      headers: headers(`job-${status}`),
    });
    expect(moved.ok()).toBeTruthy();
  }

  // Connect the mock accounting adapter from Settings (no consent screen in the mock).
  if (accounting.status !== 'connected') {
    await page.goto('/#/settings');
    await page.getByRole('button', { name: /Connect mock accounting|Reconnect/ }).click();
    await expect(page.getByTestId('accounting-status')).toHaveText('connected');
  }

  // Job card -> Create invoice -> the invoice copies the accepted quote.
  await page.goto(`/#/jobs/${quote.jobId}`);
  await page.reload();
  await page.getByRole('button', { name: 'Create invoice' }).click();
  await expect(page.getByTestId('invoice-status')).toHaveText('Draft');
  await expect(page.getByTestId('invoice-total')).toContainText(
    new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(
      quote.totalCents / 100,
    ),
  );

  // Approve -> outbox -> worker posts it to the mock ledger.
  await page.getByRole('button', { name: 'Approve invoice' }).click();
  await expect(page.getByTestId('invoice-status')).toHaveText('Posted', { timeout: 30_000 });
  await expect(page.getByTestId('external-id')).toHaveText(/^fake-invoice-/);
  await expect(page.getByRole('link', { name: 'Download PDF' })).toBeVisible();

  // A payment recorded in the mock ledger is read back by "Check payments now".
  await page.getByRole('button', { name: 'Record payment (mock)' }).click();
  await expect(page.getByText(/Mock payment recorded/)).toBeVisible();
  await page.getByRole('button', { name: 'Check payments now' }).click();
  await expect(page.getByTestId('invoice-status')).toHaveText('Paid');
  await expect(page.getByTestId('payment-status')).toContainText('$0.00 due');
});
