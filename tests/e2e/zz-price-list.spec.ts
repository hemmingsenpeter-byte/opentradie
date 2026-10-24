import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * ADR 0030 journey: Settings › Price list → owner adds a rate → it prices a quote line →
 * owner changes the price → the existing quote keeps the price it was drafted with.
 * Runs against the real API and PostgreSQL with the mock agent. Named zz- so it runs after the
 * other journeys and absorbs any login rate-limit wait.
 */
const owner = {
  email: process.env.OWNER_EMAIL ?? 'owner@demo.opentradie.test',
  password: process.env.OWNER_PASSWORD ?? '',
};
const money = (cents: number) =>
  new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(cents / 100);

test.describe.configure({ timeout: 150_000 });

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

test('owner adds a rate, quotes with it, changes the price; the old quote is unchanged', async ({
  page,
  baseURL,
}) => {
  test.skip(!owner.password, 'Set OWNER_PASSWORD (pnpm setup:dev writes it to .env).');
  const origin = new URL(baseURL!).origin;
  const code = `e2e_rate_${Date.now()}`;
  const label = `E2E heat pump service ${Date.now()}`;

  await signIn(page, origin);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  await page.goto('/#/settings');
  await page.getByRole('link', { name: 'Manage price list' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Price list' })).toBeVisible();
  await page.getByRole('button', { name: 'Add rate' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add rate' });
  await dialog.getByLabel('Code').fill(code);
  await dialog.getByLabel('Description').fill(label);
  await dialog.getByLabel('Unit').selectOption('each');
  await dialog.getByLabel('Price (NZD)').fill('$1,234.50');
  await dialog.getByRole('button', { name: 'Add rate' }).click();
  await expect(page.getByText(`“${label}” added.`)).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: label });
  await expect(row).toContainText(money(123_450));
  await expect(row).toContainText('Active');

  // Draft a quote and put the new rate on it, through the API the quote editor uses.
  const headers = (key: string) => ({
    Origin: origin,
    'Idempotency-Key': `e2e-rates-${key}-${Date.now()}`,
  });
  const state = (await (await page.request.get('/api/state')).json()) as {
    customers: { id: string; name: string }[];
  };
  const enquiry = await page.request.post('/api/enquiries', {
    data: {
      text: 'Mrs Johnson needs two power points replaced. Check her existing information and prepare a quote.',
      customerId: state.customers.find((c) => c.name === 'Mrs Johnson')!.id,
    },
    headers: headers('enquiry'),
  });
  expect(enquiry.ok()).toBeTruthy();
  const { quoteId } = (await enquiry.json()) as { quoteId: string };
  const draft = (await (await page.request.get(`/api/quotes/${quoteId}`)).json()) as {
    version: number;
  };
  const edit = await page.request.patch(`/api/quotes/${quoteId}`, {
    data: {
      version: draft.version,
      lines: [{ source: 'approved_rate', rateCode: code, quantityMilli: 1000 }],
    },
    headers: headers('edit'),
  });
  expect(edit.ok(), await edit.text()).toBeTruthy();
  await page.goto(`/#/quotes/${quoteId}`);
  // The workspace state loads once per page load; reload so it includes the API edit.
  await page.reload();
  await expect(page.getByText(label).first()).toBeVisible();
  await expect(page.getByText(money(123_450)).first()).toBeVisible();

  // Change the price on the price list.
  await page.goto('/#/settings/rates');
  await page.getByRole('button', { name: `Edit ${label}` }).click();
  const editDialog = page.getByRole('dialog', { name: 'Edit rate' });
  await editDialog.getByLabel('Price (NZD)').fill('1300');
  await editDialog.getByRole('button', { name: 'Save rate' }).click();
  await expect(page.getByText(`“${label}” saved.`)).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: label })).toContainText(money(130_000));
  await page.getByRole('button', { name: `History of ${label}` }).click();
  const history = page.getByRole('dialog', { name: `Price history: ${label}` });
  await expect(history).toContainText(money(130_000));
  await expect(history).toContainText(money(123_450));
  await history.getByRole('button', { name: 'Close' }).click();

  // The quote drafted earlier still carries the price it was drafted with.
  await page.goto(`/#/quotes/${quoteId}`);
  // The workspace state loads once per page load; reload so it includes the API edit.
  await page.reload();
  await expect(page.getByText(label).first()).toBeVisible();
  await expect(page.getByText(money(123_450)).first()).toBeVisible();
  await expect(page.getByText(money(130_000))).toHaveCount(0);
  const quote = (await (await page.request.get(`/api/quotes/${quoteId}`)).json()) as {
    lines: { rateCode: string; unitPriceCents: number }[];
  };
  expect(quote.lines.find((line) => line.rateCode === code)!.unitPriceCents).toBe(123_450);
});
