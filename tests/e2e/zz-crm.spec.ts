import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Customer CRM journey (ADR 0034): tag a customer → filter by the tag → use the tag in an
 * automation condition; find a duplicate → merge → its job appears under the survivor; the
 * insights page shows the expected totals. Real API and PostgreSQL with synthetic data.
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

test('tag → filter → automation condition; duplicate → merge; insights totals', async ({
  page,
  baseURL,
}) => {
  test.skip(!owner.password, 'Set OWNER_PASSWORD (pnpm setup:dev writes it to .env).');
  const origin = new URL(baseURL!).origin;
  await signIn(page, origin);
  let n = 0;
  const headers = () => ({ Origin: origin, 'Idempotency-Key': `crm-e2e-${Date.now()}-${n++}` });
  const stamp = Date.now();
  const post = async (url: string, data: unknown) => {
    const response = await page.request.post(url, { data, headers: headers() });
    expect(response.ok(), `${url} ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const survivor = await post('/api/customers', {
    name: `Ngaio Survivor ${stamp}`,
    phone: '+64 27 400 1234',
  });
  const duplicate = await post('/api/customers', {
    name: `N Survivor ${stamp}`,
    phone: '027 400 1234',
  });
  const job = await post('/api/jobs', {
    customerId: duplicate.id,
    title: `Duplicate's job ${stamp}`,
  });

  // Tag the survivor inline from the profile.
  const tagName = `gold-${stamp}`;
  await page.goto(`/#/customers/${survivor.id}`);
  await page.getByRole('button', { name: 'Edit tags' }).click();
  await page.getByLabel('New tag').fill(tagName);
  await page.getByRole('button', { name: 'Add tag' }).click();
  await expect(page.getByRole('list', { name: `Tags for ${survivor.name}` })).toContainText(
    tagName,
  );

  // Filter the list by the tag.
  await page.goto('/#/customers');
  await page.getByLabel('Filter by tag').selectOption({ label: `${tagName} (1)` });
  await expect(page.getByText(survivor.name)).toBeVisible();
  await expect(page.getByText(duplicate.name)).toHaveCount(0);

  // Use the tag as an automation condition in the editor.
  const automationName = `CRM tag ${stamp}`;
  await post('/api/automations', {
    definition: {
      name: automationName,
      trigger: {
        event: 'job.completed',
        filter: { field: 'job.title', op: 'contains', value: 'x' },
      },
      actions: [{ tool: 'task.create', title: 'Call a gold customer' }],
    },
  });
  await page.goto('/#/settings');
  await page.getByRole('button', { name: `Edit ${automationName}` }).click();
  const editor = page.getByTestId('automation-editor');
  const row = editor.getByTestId('condition-row').first();
  await row.getByLabel('Condition 1 fact').selectOption({ label: 'customer tags' });
  await row.getByLabel('Condition 1 value').fill(tagName);
  await expect(editor.getByTestId('automation-summary')).toContainText(`tagged "${tagName}"`);
  await editor.getByRole('button', { name: 'Save automation' }).click();
  await expect(editor).toHaveCount(0);
  const saved = (await (await page.request.get('/api/automations')).json()).automations.find(
    (item: { name: string }) => item.name === automationName,
  );
  expect(saved.definition.trigger.filter).toEqual({
    field: 'customer.tags',
    op: 'contains',
    value: tagName,
  });

  // Possible duplicates → review → merge.
  await page.goto('/#/customers/duplicates');
  await page
    .getByRole('button', { name: new RegExp(`Review .*Survivor ${stamp} and .*Survivor ${stamp}`) })
    .click();
  const keepName = survivor.name;
  const keepCard = page.getByRole('region', { name: keepName });
  await keepCard.getByRole('radio', { name: 'Keep this customer' }).check();
  await page.getByLabel(`Type "${keepName}" to confirm the merge`).fill(keepName);
  await page.getByRole('button', { name: `Merge into ${keepName}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: keepName })).toBeVisible();
  await expect(page.getByText(job.title)).toBeVisible();

  // Insights: this financial year shows a row for the survivor (no invoices yet: $0.00).
  await page.goto('/#/customers/insights');
  const tiles = page.getByRole('list', { name: 'Summary' });
  await expect(tiles).toBeVisible();
  const report = await (
    await page.request.get('/api/reports/customers?period=this_financial_year')
  ).json();
  await expect(tiles).toContainText(
    `$${(report.summary.invoicedInclCents / 100).toLocaleString('en-NZ', { minimumFractionDigits: 2 })}`,
  );
  await expect(page.getByRole('link', { name: keepName })).toBeVisible();
});
