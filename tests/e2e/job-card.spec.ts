import { expect, test } from '@playwright/test';

/**
 * Field journey (Features 5, 6, 11, 12): create a customer, add a property, open a job at it,
 * move it through valid statuses, record a note and a photo, read the timeline, export the data.
 * Runs against the real API and PostgreSQL with synthetic data only.
 */
const owner = {
  email: process.env.OWNER_EMAIL ?? 'owner@demo.opentradie.test',
  password: process.env.OWNER_PASSWORD ?? '',
};

/** A valid 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test('owner records a job at a property from start to finish', async ({ page }) => {
  test.skip(!owner.password, 'Set OWNER_PASSWORD (pnpm setup:dev writes it to .env).');
  const name = `Synthetic Customer ${Date.now()}`;

  await page.goto('/');
  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Password').fill(owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  // Customer
  await page.goto('/#/customers/new');
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Add customer' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  // Property
  await page.getByRole('button', { name: 'Add property' }).click();
  const form = page.getByRole('form', { name: 'Add property' });
  await form.getByLabel('Street address').fill('5 Synthetic Lane');
  await form.getByLabel(/Suburb/).fill('Testville');
  await form.getByLabel(/City/).fill('Auckland');
  await form.getByLabel(/Access notes/).fill('Gate code on request.');
  await form.getByRole('button', { name: 'Save property' }).click();
  const properties = page.getByRole('list', { name: 'Properties' });
  await expect(properties.getByText('5 Synthetic Lane, Testville, Auckland')).toBeVisible();

  // Job at that property
  await properties.getByRole('link', { name: 'New job here' }).click();
  await expect(page.getByLabel('Job site')).toHaveValue(/.+/);
  await page.getByLabel(/What.s the job/).fill('Install outdoor power point');
  await page.getByRole('button', { name: 'Create job' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Install outdoor power point' }),
  ).toBeVisible();
  await expect(page.getByText('Access: Gate code on request.')).toBeVisible();

  // Only valid next statuses are offered.
  const statuses = page.getByRole('group', { name: 'Change status' });
  await expect(statuses.getByRole('button', { name: 'Completed' })).toHaveCount(0);
  await statuses.getByRole('button', { name: 'In progress' }).click();
  await expect(page.getByTestId('job-status')).toHaveText('In progress');

  // Work record: a note and a photo.
  await page.getByLabel('Add a note').fill('Cable run through the garage wall.');
  await page.getByRole('button', { name: 'Save note' }).click();
  await page
    .getByTestId('evidence-input')
    .setInputFiles({ name: 'wall.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('img', { name: 'wall.png' })).toBeVisible();

  await page
    .getByRole('group', { name: 'Change status' })
    .getByRole('button', { name: 'Completed' })
    .click();
  await expect(page.getByTestId('job-status')).toHaveText('Completed');
  await expect(
    page.getByRole('group', { name: 'Change status' }).getByRole('button', {
      name: 'Reopen as in progress',
    }),
  ).toBeVisible();

  // Timeline
  const history = page.getByRole('list', { name: 'Job history' });
  for (const entry of ['Job created', 'Note added', 'Photo added'])
    await expect(history.getByText(entry, { exact: true })).toBeVisible();
  await expect(history.getByText(/In progress → Completed/)).toBeVisible();
  await expect(history.getByText('Cable run through the garage wall.')).toBeVisible();

  // Export includes the new records.
  const exported = await page.request.get('/api/export');
  expect(exported.ok()).toBeTruthy();
  const bundle = (await exported.json()) as {
    format: string;
    tables: Record<string, { rows: Array<Record<string, unknown>> }>;
  };
  expect(bundle.format).toBe('opentradie-business-export');
  expect(bundle.tables.customers!.rows.some((row) => row.name === name)).toBe(true);
  expect(
    bundle.tables.properties!.rows.some((row) => row.address_line1 === '5 Synthetic Lane'),
  ).toBe(true);
  expect(JSON.stringify(bundle.tables)).not.toContain('password_hash');
});
