import { expect, test } from '@playwright/test';

/**
 * Inbox journey (Feature 8): the owner pastes a customer email, sees it become a conversation
 * with a customer, a job and an assistant-prepared draft, edits the draft and approves it. With
 * no mailbox connected the send fails visibly (NO_MAIL_CONNECTION); nothing is sent silently.
 * Runs against the real API and PostgreSQL with the mock agent and synthetic data only.
 */
const owner = {
  email: process.env.OWNER_EMAIL ?? 'owner@demo.opentradie.test',
  password: process.env.OWNER_PASSWORD ?? '',
};

test('owner pastes an email, reviews the AI draft and approves it', async ({ page }) => {
  test.skip(!owner.password, 'Set OWNER_PASSWORD (pnpm setup:dev writes it to .env).');
  const stamp = Date.now();
  const subject = `Garage power points ${stamp}`;

  // This spec may run first, while the API is still starting behind the web dev server.
  await expect(async () => {
    await page.goto('/');
    await expect(page.getByLabel('Email')).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 45_000 });
  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Password').fill(owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  await page.getByRole('link', { name: 'Paste an email' }).first().click();
  await page.getByLabel(/From \(email address\)/).fill(`synthetic.${stamp}@customer.example.test`);
  await page.getByLabel(/Sender name/).fill('Synthetic Sender');
  await page.getByLabel(/Subject/).fill(subject);
  await page
    .getByLabel(/^Message/)
    .fill('Kia ora, could you quote to install three new power points in our garage?');
  await page.getByRole('button', { name: 'Add to inbox' }).click();

  await expect(page.getByRole('heading', { level: 1, name: subject })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Synthetic Sender' })).toBeVisible();
  await expect(page.getByRole('link', { name: `Job: ${subject}` })).toBeVisible();
  await expect(page.getByText('Assistant summary')).toBeVisible();
  const reply = page.getByLabel('Reply');
  await expect(reply).toHaveValue(/Kia ora Synthetic/);
  await reply.fill('Kia ora, we can look at the garage on Thursday morning.');
  await page.getByRole('button', { name: 'Approve & send' }).click();

  // The in-process worker picks up the send; without a mailbox it fails visibly.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(/no mailbox is connected/)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  await page.goto('/#/inbox');
  await expect(page.getByRole('link', { name: new RegExp(subject) })).toBeVisible();
});
