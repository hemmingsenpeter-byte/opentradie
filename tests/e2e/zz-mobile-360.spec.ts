import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Feature 5: every main screen at 360 x 740 (a small Android phone) has no horizontal page
 * overflow and shows its primary action. Also covers the owner's per-customer export and
 * erasure controls on the customer screen (ADR 0025).
 */
const owner = {
  email: process.env.OWNER_EMAIL ?? 'owner@demo.opentradie.test',
  password: process.env.OWNER_PASSWORD ?? '',
};

test.use({ viewport: { width: 360, height: 740 } });
test.describe.configure({ timeout: 150_000 });

/**
 * Sign in through the API (one call per test). The login route allows 10 attempts a minute and
 * the full suite signs in about that often, so this waits out a 429 instead of failing. The
 * file is named zz- so it runs last and absorbs any wait.
 */
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

async function expectNoHorizontalOverflow(page: Page, screen: string) {
  const sizes = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(sizes.scroll, `${screen} overflows horizontally`).toBeLessThanOrEqual(sizes.client);
}

test('main screens fit a 360 px wide phone without horizontal scrolling', async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(!owner.password, 'Set OWNER_PASSWORD (pnpm setup:dev writes it to .env).');
  const origin = new URL(baseURL!).origin;
  await signIn(page, new URL(baseURL!).origin);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  const headers = (key: string) => ({
    Origin: origin,
    'Idempotency-Key': `e2e-360-${key}-${Date.now()}`,
  });
  const state = (await (await page.request.get('/api/state')).json()) as {
    customers: { id: string; name: string }[];
    jobs: { id: string; customerId: string }[];
  };
  const johnson = state.customers.find((customer) => customer.name === 'Mrs Johnson')!;
  const enquiry = await page.request.post('/api/enquiries', {
    data: {
      text: 'Mrs Johnson needs two power points replaced. Check her existing information and prepare a quote.',
      customerId: johnson.id,
    },
    headers: headers('enquiry'),
  });
  expect(enquiry.ok()).toBeTruthy();
  const { quoteId } = (await enquiry.json()) as { quoteId: string };
  const jobId = state.jobs.find((job) => job.customerId === johnson.id)!.id;
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  const screens: { name: string; path: string; primary: () => ReturnType<Page['getByRole']> }[] = [
    { name: 'home', path: '/#/', primary: () => page.getByRole('navigation', { name: 'Main' }) },
    {
      name: 'customers',
      path: '/#/customers',
      primary: () => page.getByRole('link', { name: 'Add' }),
    },
    {
      name: 'customer detail',
      path: `/#/customers/${johnson.id}`,
      primary: () => page.getByRole('link', { name: 'Export customer data' }),
    },
    {
      name: 'jobs',
      path: '/#/jobs',
      primary: () => page.getByRole('link', { name: /New job/ }).first(),
    },
    {
      name: 'job card',
      path: `/#/jobs/${jobId}`,
      primary: () => page.getByRole('heading', { level: 1 }),
    },
    { name: 'quotes', path: '/#/quotes', primary: () => page.getByRole('heading', { level: 1 }) },
    {
      name: 'quote editor',
      path: `/#/quotes/${quoteId}`,
      primary: () => page.getByRole('button', { name: 'Approve quote' }),
    },
    {
      name: 'invoices',
      path: '/#/invoices',
      primary: () => page.getByRole('heading', { level: 1 }),
    },
    {
      name: 'calendar',
      path: '/#/calendar',
      primary: () => page.getByRole('heading', { level: 1 }),
    },
    { name: 'inbox', path: '/#/inbox', primary: () => page.getByRole('heading', { level: 1 }) },
    {
      name: 'approvals',
      path: '/#/approvals',
      primary: () => page.getByRole('heading', { level: 1 }),
    },
    {
      name: 'settings',
      path: '/#/settings',
      primary: () => page.getByRole('heading', { level: 1 }),
    },
  ];
  for (const screen of screens) {
    await page.goto(screen.path);
    await expect(screen.primary(), screen.name).toBeVisible();
    await expectNoHorizontalOverflow(page, screen.name);
  }

  // Public quote page: approve and send through the API, then open the link signed out.
  const quote = async () =>
    (
      (await (await page.request.get('/api/state')).json()) as {
        quotes: { id: string; version: number }[];
      }
    ).quotes.find((item) => item.id === quoteId)!;
  const approve = await page.request.post(`/api/quotes/${quoteId}/approve`, {
    data: { version: (await quote()).version },
    headers: headers('approve'),
  });
  expect(approve.ok()).toBeTruthy();
  const send = await page.request.post(`/api/quotes/${quoteId}/send`, {
    data: { version: (await quote()).version },
    headers: headers('send'),
  });
  expect(send.ok()).toBeTruthy();
  const { acceptanceUrl } = (await send.json()) as { acceptanceUrl: string };
  const customer = await browser.newContext({ baseURL, viewport: { width: 360, height: 740 } });
  const publicPage = await customer.newPage();
  await publicPage.goto(acceptanceUrl);
  await expect(publicPage.getByRole('button', { name: 'Accept quote' })).toBeVisible();
  await expectNoHorizontalOverflow(publicPage, 'public quote');
  await customer.close();
});

test('the owner erases a customer after typing their name', async ({ page, baseURL }) => {
  test.skip(!owner.password, 'Set OWNER_PASSWORD (pnpm setup:dev writes it to .env).');
  await signIn(page, new URL(baseURL!).origin);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  const state = (await (await page.request.get('/api/state')).json()) as {
    customers: { id: string; name: string }[];
  };
  const sam = state.customers.find((customer) => customer.name === 'Sam Patel')!;
  await page.goto(`/#/customers/${sam.id}`);
  await page.getByRole('button', { name: 'Erase customer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Erase this customer?' });
  const confirm = dialog.getByRole('button', { name: 'Erase customer' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Type "Sam Patel" to confirm').fill('Sam Patel');
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Customers', level: 1 })).toBeVisible();
  await expect(page.getByText('Sam Patel')).toHaveCount(0);
  const erased = await page.request.get(`/api/customers/${sam.id}`);
  expect(((await erased.json()) as { customer: { name: string } }).customer.name).toMatch(
    /^Erased customer /,
  );
});
