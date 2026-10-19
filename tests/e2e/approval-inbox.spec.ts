import { expect, test } from '@playwright/test';

/**
 * AI operator journey (ADR 0021): the mock assistant turns a job update into proposals; nothing
 * changes until the owner approves one in the inbox. Real API, real PostgreSQL, mock agent only.
 */
const owner = {
  email: process.env.OWNER_EMAIL ?? 'owner@demo.opentradie.test',
  password: process.env.OWNER_PASSWORD ?? '',
};

test('owner approves and rejects assistant proposals from the inbox', async ({ page, baseURL }) => {
  test.skip(!owner.password, 'Set OWNER_PASSWORD (pnpm setup:dev writes it to .env).');
  await page.goto('/');
  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Password').fill(owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  // Arrange through the API with the signed-in session (no UI posts job updates yet).
  const origin = new URL(baseURL!).origin;
  const headers = (key: string) => ({ origin, 'idempotency-key': key });
  const customers = await (await page.request.get('/api/customers?q=Patel')).json();
  const stamp = Date.now();
  const job = await page.request.post('/api/jobs', {
    headers: headers(`e2e-job-${stamp}`),
    data: { customerId: customers.customers[0].id, title: `Inbox journey ${stamp}` },
  });
  expect(job.status()).toBe(201);
  const jobId = (await job.json()).id as string;
  const planned = await page.request.post(`/api/jobs/${jobId}/assistant-actions`, {
    headers: headers(`e2e-plan-${stamp}`),
    data: { text: 'Spent 2 hours on site. Mark the job as in progress.' },
  });
  expect(planned.status()).toBe(201);

  await page.goto('/#/approvals');
  await expect(page.getByRole('heading', { level: 1, name: 'Approval inbox' })).toBeVisible();
  const actions = page.getByRole('list', { name: 'Proposed actions' });
  const status = actions
    .getByRole('listitem')
    .filter({ hasText: `Inbox journey ${stamp}` })
    .filter({
      hasText: 'Propose job status',
    });
  await status.getByRole('button', { name: 'Approve' }).click();
  await expect(status).toHaveCount(0);

  const time = actions
    .getByRole('listitem')
    .filter({ hasText: `Inbox journey ${stamp}` })
    .filter({
      hasText: 'Propose time entry',
    });
  await time.getByRole('button', { name: 'Reject' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reject this proposal?' });
  await dialog.getByLabel('Reason').fill('Hours to be confirmed');
  await dialog.getByRole('button', { name: 'Yes, reject' }).click();
  await expect(time).toHaveCount(0);

  await page.goto(`/#/jobs/${jobId}`);
  await expect(page.getByTestId('job-status')).toHaveText('In progress');
});
