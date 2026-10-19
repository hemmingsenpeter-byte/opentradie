import { expect, test } from '@playwright/test';

/**
 * Scheduling journey (Feature 14): open a job, book one of the suggested free times, then find
 * the appointment in the calendar. Runs against the real API and PostgreSQL with synthetic data.
 */
const owner = {
  email: process.env.OWNER_EMAIL ?? 'owner@demo.opentradie.test',
  password: process.env.OWNER_PASSWORD ?? '',
};

// The device is in the business time zone, as an owner's phone would be.
test.use({ timezoneId: 'Pacific/Auckland' });

test('owner schedules a job from a suggested slot and sees it in the calendar', async ({
  page,
}) => {
  test.skip(!owner.password, 'Set OWNER_PASSWORD (pnpm setup:dev writes it to .env).');
  const name = `Synthetic Schedule ${Date.now()}`;
  const jobTitle = `Fit smoke alarms ${Date.now()}`;

  await page.goto('/');
  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Password').fill(owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  // A customer with a property, and a new job there.
  await page.goto('/#/customers/new');
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Add customer' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await page.getByRole('button', { name: 'Add property' }).click();
  const form = page.getByRole('form', { name: 'Add property' });
  await form.getByLabel('Street address').fill('9 Synthetic Close');
  await form.getByLabel(/City/).fill('Auckland');
  await form.getByRole('button', { name: 'Save property' }).click();
  const properties = page.getByRole('list', { name: 'Properties' });
  await properties.getByRole('link', { name: 'New job here' }).click();
  await page.getByLabel(/What.s the job/).fill(jobTitle);
  await page.getByRole('button', { name: 'Create job' }).click();
  await expect(page.getByRole('heading', { level: 1, name: jobTitle })).toBeVisible();
  await expect(page.getByTestId('job-status')).toHaveText('New');

  // Schedule: the server suggests free times inside working hours.
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  const suggestions = page.getByRole('group', { name: 'Suggested times' });
  const first = suggestions.getByRole('button').first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page.getByText(/Booked .* The job is now scheduled\./)).toBeVisible();
  await expect(page.getByTestId('job-status')).toHaveText('Scheduled');
  await expect(page.getByRole('list', { name: 'Appointments' }).getByRole('listitem')).toHaveCount(
    1,
  );
  await expect(
    page.getByRole('list', { name: 'Job history' }).getByText('Appointment booked'),
  ).toBeVisible();

  // Calendar (list view on a phone): the appointment appears, possibly in a later week.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Calendar' })
    .click();
  const calendar = page.getByTestId('calendar');
  const event = calendar.getByText(new RegExp(`${jobTitle} · ${name}`));
  await expect(page.getByText(/device’s time zone/)).toHaveCount(0);
  for (let week = 0; week < 3; week += 1) {
    const found = await event
      .waitFor({ timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (found) break;
    await calendar.getByRole('button', { name: 'Next week' }).click();
  }
  await expect(event).toBeVisible();

  // Opening it returns to the job card.
  await event.click();
  await expect(page.getByRole('heading', { level: 1, name: jobTitle })).toBeVisible();
});
