import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Feature 16 journey (ADR 0032): an accepted quote puts "Book in" on Today → the owner schedules
 * from a suggested slot → the task resolves itself; then a quick-added to-do is completed.
 * Real API, PostgreSQL and worker with synthetic data and the mock agent. Named zz- so it runs
 * after the other journeys and absorbs any login rate-limit wait.
 */
const owner = {
  email: process.env.OWNER_EMAIL ?? 'owner@demo.opentradie.test',
  password: process.env.OWNER_PASSWORD ?? '',
};

test.describe.configure({ timeout: 150_000 });
test.use({ timezoneId: 'Pacific/Auckland' });

/** API sign-in that waits out the 10-per-minute login limit instead of failing. */
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

test('accepted quote → Today "Book in" → schedule from a slot → task resolves; quick-add → complete', async ({
  page,
  baseURL,
}) => {
  test.skip(!owner.password, 'Set OWNER_PASSWORD (pnpm setup:dev writes it to .env).');
  const origin = new URL(baseURL!).origin;
  await signIn(page, origin);
  let n = 0;
  const headers = () => ({ Origin: origin, 'Idempotency-Key': `today-e2e-${Date.now()}-${n++}` });

  // An accepted quote (API set-up; the quote journeys cover these screens).
  const customers = await (await page.request.get('/api/customers')).json();
  const enquiry = await page.request.post('/api/enquiries', {
    headers: headers(),
    data: {
      text: 'Mrs Johnson needs two power points replaced. Check her existing information and prepare a quote.',
      customerId: customers.customers[0].id,
    },
  });
  expect(enquiry.status()).toBe(201);
  const quote = (await enquiry.json()).quote;
  const approved = await (
    await page.request.post(`/api/quotes/${quote.id}/approve`, {
      headers: headers(),
      data: { version: quote.version },
    })
  ).json();
  const sent = await (
    await page.request.post(`/api/quotes/${quote.id}/send`, {
      headers: headers(),
      data: { version: approved.version },
    })
  ).json();
  const token = new URL(sent.acceptanceUrl).pathname.split('/').at(-1);
  expect(
    (
      await page.request.post(`/api/public/quotes/${token}/accept`, {
        headers: { Origin: origin },
        data: { name: 'Margaret Johnson' },
      })
    ).status(),
  ).toBe(200);

  // Today shows "Book in" for the job once the rules run ("Check now").
  await page.goto('/#/home');
  const today = page.getByRole('region', { name: /^Today/ });
  await today.getByRole('button', { name: 'Check now' }).click();
  const schedule = today.locator(`a[href="#/jobs/${quote.jobId}?schedule=1"]`);
  await expect(schedule).toBeVisible();
  await expect(page.getByLabel(/tasks due/)).toBeVisible();

  // Schedule opens the job with suggested free slots; book the first.
  await schedule.click();
  const first = page.getByRole('group', { name: 'Suggested times' }).getByRole('button').first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page.getByText(/Booked/)).toBeVisible();

  // The booking queues a rule scan; the task resolves itself (completed by the system).
  await page.goto('/#/home');
  await expect(async () => {
    await page.reload();
    await expect(
      page
        .getByRole('region', { name: /^Today/ })
        .locator(`a[href="#/jobs/${quote.jobId}?schedule=1"]`),
    ).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });

  // Quick-add a to-do and complete it in one tap.
  const title = `Order cylinder ${Date.now()}`;
  await today.getByLabel('New task').fill(title);
  await today.getByRole('button', { name: 'Add' }).click();
  const complete = today.getByRole('button', { name: `Complete: ${title}` });
  await expect(complete).toBeVisible();
  await complete.click();
  await expect(today.getByText(title)).toHaveCount(0);
});
