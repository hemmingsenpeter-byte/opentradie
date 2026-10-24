import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

/**
 * Phase 2b journey: enquiry -> draft quote -> owner edits a line -> approve -> send ->
 * customer opens the public link (no sign-in) -> accepts -> owner sees it accepted with
 * the audit trail. Runs against the real API and PostgreSQL with the mock agent.
 * Nothing is emailed: sending stores a message draft and shows the link to copy.
 */
const owner = {
  email: process.env.OWNER_EMAIL ?? 'owner@demo.opentradie.test',
  password: process.env.OWNER_PASSWORD ?? '',
};
const REQUEST =
  'Mrs Johnson needs two power points replaced. Check her existing information and prepare a quote.';

interface StateQuote {
  id: string;
  status: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

const money = (cents: number) =>
  new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(cents / 100);

async function quoteFromState(request: APIRequestContext, id: string): Promise<StateQuote> {
  const response = await request.get('/api/state');
  expect(response.ok()).toBeTruthy();
  const state = (await response.json()) as { quotes: StateQuote[] };
  return state.quotes.find((quote) => quote.id === id)!;
}

test('owner edits, approves and sends a quote; the customer accepts it online', async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(!owner.password, 'Set OWNER_PASSWORD (pnpm setup:dev writes it to .env).');
  const origin = new URL(baseURL!).origin;

  await page.goto('/');
  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Password').fill(owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  // Enquiry -> draft quote through the same API the assistant screen uses.
  const state = (await (await page.request.get('/api/state')).json()) as {
    customers: { id: string; name: string }[];
  };
  const johnson = state.customers.find((customer) => customer.name === 'Mrs Johnson')!;
  const enquiry = await page.request.post('/api/enquiries', {
    data: { text: REQUEST, customerId: johnson.id },
    headers: { Origin: origin, 'Idempotency-Key': `e2e-accept-${Date.now()}` },
  });
  expect(enquiry.ok()).toBeTruthy();
  const { quoteId } = (await enquiry.json()) as { quoteId: string };

  // Edit a line: three power points instead of two. The server recalculates the totals.
  await page.goto(`/#/quotes/${quoteId}`);
  await page.reload(); // the workspace snapshot loads on start; pick up the new draft
  await page.getByRole('button', { name: 'Edit lines' }).click();
  const editor = page.getByTestId('quote-editor');
  await editor.getByRole('group', { name: 'Line 1' }).getByLabel('Quantity').fill('3');
  await editor.getByRole('button', { name: 'Save lines' }).click();
  await expect(editor).toBeHidden();
  const edited = await quoteFromState(page.request, quoteId);
  expect(edited.subtotalCents).toBe(3 * 8_900 + 9_500);
  await expect(page.getByTestId('quote-subtotal')).toHaveText(money(edited.subtotalCents));
  await expect(page.getByTestId('quote-gst')).toHaveText(money(edited.taxCents));
  await expect(page.getByTestId('quote-total')).toHaveText(money(edited.totalCents));

  // Owner approval (internal) then send.
  await page.getByRole('button', { name: 'Approve quote' }).click();
  await page
    .getByRole('dialog', { name: 'Approve this quote?' })
    .getByRole('button', { name: 'Yes, approve' })
    .click();
  await expect(page.getByTestId('quote-status')).toHaveText(/Approved/);
  await page.getByRole('button', { name: 'Send to customer' }).click();
  const link = page.getByLabel('Acceptance link');
  await expect(link).toHaveValue(/\/q\/[A-Za-z0-9_-]{43}$/);
  const acceptanceUrl = await link.inputValue();
  await expect(page.getByTestId('quote-status')).toHaveText(/Sent/);

  // The customer opens the link in a fresh browser with no session.
  const customer = await browser.newContext({ baseURL });
  const customerPage = await customer.newPage();
  await customerPage.goto(acceptanceUrl);
  await expect(customerPage.getByRole('heading', { name: /Quote Q-\d{4}/ })).toBeVisible();
  await expect(customerPage.getByTestId('public-totals')).toContainText(money(edited.totalCents));
  await customerPage.getByLabel(/Your full name/).fill('Margaret Johnson');
  await customerPage.getByRole('button', { name: 'Accept quote' }).click();
  await expect(customerPage.getByText('Quote accepted')).toBeVisible();
  await customer.close();

  // The owner sees the decision and the audit trail.
  await page.reload();
  await expect(page.getByTestId('quote-status')).toHaveText(/Accepted/);
  await expect(page.getByText('Accepted by the customer').first()).toBeVisible();
  const activity = page.getByTestId('quote-activity');
  for (const step of [
    'Lines edited',
    'Approved by the owner',
    'Sent (message drafted with link)',
    'Accepted by the customer',
  ])
    await expect(activity).toContainText(step);
  expect((await quoteFromState(page.request, quoteId)).status).toBe('accepted');
});
