import { expect, test } from '@playwright/test';

/**
 * Workflow D journey (Feature 10, ADR 0027): a posted invoice past its due date -> the owner turns
 * on payment follow-ups and runs the check -> a first-reminder DRAFT appears in the Inbox -> the
 * owner approves & sends it through the FAKE mailbox -> a mock payment is read back from the FAKE
 * accounting adapter -> another check prepares nothing further.
 *
 * Needs ACCOUNTING_PROVIDER=fake, MAIL_PROVIDER=fake (+ *_ALLOW_FAKE) and COLLECTIONS_TEST_NOW set
 * about 30 days ahead (a test-only clock; config refuses it in production). Mocks only: this is not
 * evidence that Xero, Gmail or Microsoft 365 work.
 */
const owner = {
  email: process.env.OWNER_EMAIL ?? 'owner@demo.opentradie.test',
  password: process.env.OWNER_PASSWORD ?? '',
};
const REQUEST = 'Mrs Johnson needs one power point replaced in the hallway. Prepare a quote.';

test('an overdue invoice gets an approved follow-up, then nothing more once paid', async ({
  page,
  baseURL,
}) => {
  test.skip(!owner.password, 'Set OWNER_PASSWORD (pnpm setup:dev writes it to .env).');
  const origin = new URL(baseURL!).origin;
  const headers = (label: string) => ({
    Origin: origin,
    'Idempotency-Key': `e2e-follow-up-${label}-${Date.now()}`,
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
  const mail = (await (await page.request.get('/api/integrations/mail/status')).json()) as {
    provider: string;
    status: string;
  };
  test.skip(
    accounting.provider !== 'fake' || mail.provider !== 'fake',
    'Needs ACCOUNTING_PROVIDER=fake and MAIL_PROVIDER=fake with their *_ALLOW_FAKE opt-ins.',
  );

  // Setup through the API: accepted quote, completed job.
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
    quote: { id: string; jobId: string; version: number };
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
  expect(
    (
      await page.request.post(`/api/public/quotes/${token}/accept`, {
        data: { name: 'Margaret Johnson' },
        headers: { Origin: origin },
      })
    ).ok(),
  ).toBeTruthy();
  for (const status of ['in_progress', 'completed']) {
    const moved = await page.request.patch(`/api/jobs/${quote.jobId}`, {
      data: { status },
      headers: headers(`job-${status}`),
    });
    expect(moved.ok()).toBeTruthy();
  }

  // Connect the mock accounting adapter and the mock mailbox (no consent screens in the mocks).
  await page.goto('/#/settings');
  if (accounting.status !== 'connected') {
    await page.getByRole('button', { name: /Connect mock accounting|Reconnect/ }).click();
    await expect(page.getByTestId('accounting-status')).toHaveText('connected');
  }
  if (mail.status !== 'connected') {
    await page.getByRole('button', { name: /(Connect|Reconnect) mock mailbox/ }).click();
    await expect(page.getByTestId('mail-status')).toHaveText('connected');
  }

  // Invoice the job and post it to the mock ledger.
  await page.goto(`/#/jobs/${quote.jobId}`);
  await page.reload();
  await page.getByRole('button', { name: 'Create invoice' }).click();
  await expect(page.getByTestId('invoice-status')).toHaveText('Draft');
  await page.getByRole('button', { name: 'Approve invoice' }).click();
  await expect(page.getByTestId('invoice-status')).toHaveText('Posted', { timeout: 30_000 });
  const invoiceUrl = page.url();

  // Settings › Payment follow-ups: turn on (every stage still needs approval) and run the check.
  await page.goto('/#/settings');
  const followUps = page.getByTestId('follow-up-settings');
  await expect(followUps).toContainText('Every follow-up needs your approval');
  await followUps.getByLabel('Prepare payment follow-ups').check();
  await followUps.getByRole('button', { name: 'Save follow-up settings' }).click();
  await expect(followUps.getByText('Follow-up settings saved.')).toBeVisible();
  await followUps.getByRole('button', { name: 'Run follow-up check now' }).click();
  await expect(followUps.getByText(/Follow-up check queued/)).toBeVisible();

  // The invoice's timeline shows the prepared first reminder (the clock is ~10 days past due).
  await page.goto(invoiceUrl);
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('follow-up-history')).toContainText('First reminder', {
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByTestId('follow-up-history')).toContainText('draft waiting for approval');

  // Inbox: the deterministic draft waits for approval; approve & send through the mock mailbox.
  await page.getByRole('link', { name: 'Open in Inbox' }).click();
  const reply = page.getByLabel('Reply');
  await expect(reply).toHaveValue(/overdue/i);
  await page.getByRole('button', { name: 'Approve & send' }).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  // The customer pays (mock ledger); reading it back marks the invoice paid.
  await page.goto(invoiceUrl);
  await page.reload();
  await expect(page.getByTestId('follow-up-history')).toContainText('sent');
  await page.getByRole('button', { name: 'Record payment (mock)' }).click();
  await expect(page.getByText(/Mock payment recorded/)).toBeVisible();
  await page.getByRole('button', { name: 'Check payments now' }).click();
  await expect(page.getByTestId('invoice-status')).toHaveText('Paid');

  // Another check prepares no further stage.
  const scan = await page.request.post('/api/collections/scan', { headers: headers('scan') });
  expect(scan.status()).toBe(202);
  await page.reload();
  await expect(page.getByTestId('follow-up-next')).toHaveText('Paid. No further follow-up.');
  const invoiceId = invoiceUrl.split('/').at(-1)!;
  await expect(async () => {
    const data = (await (
      await page.request.get(`/api/invoices/${invoiceId}/follow-ups`)
    ).json()) as { history: { stage: string; communicationStatus: string | null }[] };
    expect(data.history.map((item) => `${item.stage}:${item.communicationStatus}`)).toEqual([
      'overdue_1:sent',
    ]);
  }).toPass({ timeout: 10_000 });

  // Leave the shared demo tenant as later journeys expect: follow-ups off, no mailbox.
  expect(
    (
      await page.request.patch('/api/settings/collections', {
        data: { enabled: false },
        headers: headers('disable'),
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await page.request.post('/api/integrations/mail/fake/disconnect', {
        headers: headers('mail-off'),
      })
    ).ok(),
  ).toBeTruthy();
});
