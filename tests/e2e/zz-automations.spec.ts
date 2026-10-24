import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Feature 17 journey (ADR 0033): the owner turns on the review-request template, removes its
 * one-day wait (the "immediate" option) in the editor, completes a job, and the deterministic
 * engine puts a draft message in the approval inbox. Nothing is sent. Real API, PostgreSQL and
 * in-process worker with synthetic data and the mock agent.
 */
const owner = {
  email: process.env.OWNER_EMAIL ?? 'owner@demo.opentradie.test',
  password: process.env.OWNER_PASSWORD ?? '',
};

test.describe.configure({ timeout: 150_000 });
test.use({ timezoneId: 'Pacific/Auckland' });

async function signIn(page: Page, origin: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await page.request.post('/api/auth/login', {
      data: owner,
      headers: { Origin: origin },
    });
    if (response.ok()) return;
    expect(response.status()).toBe(429);
    const wait = Number(response.headers()['retry-after'] ?? '30');
    await page.waitForTimeout(Math.min(Math.max(wait, 1), 61) * 1000);
  }
  throw new Error('sign-in kept being rate limited');
}

test('enable review template → complete a job → draft appears in approvals', async ({
  page,
  baseURL,
}) => {
  test.skip(!owner.password, 'Set OWNER_PASSWORD (pnpm setup:dev writes it to .env).');
  const origin = new URL(baseURL!).origin;
  await signIn(page, origin);
  let n = 0;
  const headers = () => ({ Origin: origin, 'Idempotency-Key': `auto-e2e-${Date.now()}-${n++}` });

  await page.goto('/#/settings');
  const section = page.getByTestId('automations');
  await section.getByRole('button', { name: 'Use Thank-you and review request' }).click();
  const item = section
    .getByTestId('automation-item')
    .filter({ hasText: 'Thank-you and review request' })
    .first();
  await expect(item).toContainText('On');
  await item.getByRole('button', { name: 'Edit Thank-you and review request' }).click();
  const editor = page.getByTestId('automation-editor');
  await editor.getByLabel('Days later').fill('0');
  await editor.getByLabel('At (business time, optional)').fill('');
  await expect(editor.getByTestId('automation-summary')).toContainText('straight away');
  await editor.getByRole('button', { name: 'Save automation' }).click();
  await expect(editor).toHaveCount(0);

  const customers = await (await page.request.get('/api/customers?q=Patel')).json();
  const stamp = Date.now();
  const job = await page.request.post('/api/jobs', {
    headers: headers(),
    data: { customerId: customers.customers[0].id, title: `Automation journey ${stamp}` },
  });
  expect(job.status()).toBe(201);
  const jobId = (await job.json()).id as string;
  for (const status of ['in_progress', 'completed'])
    expect(
      (
        await page.request.patch(`/api/jobs/${jobId}`, { headers: headers(), data: { status } })
      ).status(),
    ).toBe(200);

  // The in-process worker dispatches the event and runs the automation.
  await expect
    .poll(
      async () => {
        const body = await (await page.request.get('/api/proposals?status=pending')).json();
        return body.proposals.filter(
          (proposal: { source: string; payload: { text?: string } }) =>
            proposal.source === 'automation' &&
            proposal.payload.text?.includes(`Automation journey ${stamp}`),
        ).length;
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(1);

  await page.goto('/#/approvals');
  const actions = page.getByRole('list', { name: 'Proposed actions' });
  await expect(
    actions.getByRole('listitem').filter({ hasText: 'Propose message draft' }).first(),
  ).toBeVisible();
});
