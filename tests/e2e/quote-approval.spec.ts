import { expect, test } from '@playwright/test';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

/**
 * Essential journey from the v0.1 brief (§13): enquiry -> matched customer (or clarification)
 * -> proposed job -> draft quote with server-calculated totals -> owner approval.
 * And the authorisation counterpart: a viewer cannot approve.
 */
const REQUEST =
  'Mrs Johnson needs two power points replaced. Check her existing information and prepare a quote.';

const owner = {
  email: process.env.OWNER_EMAIL ?? 'owner@demo.opentradie.test',
  password: process.env.OWNER_PASSWORD ?? '',
};
const viewer = {
  email: process.env.VIEWER_EMAIL ?? 'viewer@demo.opentradie.test',
  password: process.env.VIEWER_PASSWORD ?? '',
};

interface StateQuote {
  id: string;
  customerId: string;
  status: string;
  version: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}
interface State {
  business: { currency: string };
  customers: { id: string; name: string }[];
  quotes: StateQuote[];
}

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('en-NZ', { style: 'currency', currency }).format(cents / 100);

async function signIn(page: Page, user: { email: string; password: string }) {
  test.skip(
    !user.password,
    'Set OWNER_PASSWORD / VIEWER_PASSWORD (pnpm setup:dev writes them to .env).',
  );
  await page.goto('/');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

async function readState(request: APIRequestContext): Promise<State> {
  const response = await request.get('/api/state');
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as State;
}

/** Resolve a clarification by choosing Mrs Johnson if the server asks which customer. */
async function resolveClarificationIfAsked(page: Page, proposal: Locator) {
  const clarification = page.getByText('Which customer?').last();
  await expect(proposal.or(clarification).first()).toBeVisible({ timeout: 20_000 });
  if (await clarification.isVisible()) {
    const choice = page
      .getByRole('group', { name: 'Matching customers' })
      .last()
      .getByRole('button', { name: 'Mrs Johnson', exact: true });
    if (await choice.isVisible()) {
      await choice.click();
    } else {
      await page.getByLabel('Customer').last().selectOption({ label: 'Mrs Johnson' });
      await page.getByRole('button', { name: 'Use this customer' }).last().click();
    }
  }
}

test.describe.configure({ mode: 'serial' });

test('owner turns an enquiry into an approved quote', async ({ page }) => {
  await signIn(page, owner);

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Assistant' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Assistant' })).toBeVisible();
  await page.getByLabel('Describe the work or what you need').fill(REQUEST);
  await page.getByRole('button', { name: 'Send' }).click();

  const proposal = page.getByTestId('proposal').last();
  await resolveClarificationIfAsked(page, proposal);
  await expect(proposal).toBeVisible({ timeout: 20_000 });
  await expect(proposal.getByText('Matched customer')).toBeVisible();
  await expect(proposal.getByRole('link', { name: 'Mrs Johnson' })).toBeVisible();
  await expect(proposal.getByText('Proposed job')).toBeVisible();

  // The displayed totals are exactly the server's integer-cent values, formatted.
  const state = await readState(page.request);
  const johnson = state.customers.find((customer) => customer.name === 'Mrs Johnson');
  const quote = state.quotes.find(
    (entry) => entry.customerId === johnson?.id && entry.status === 'draft',
  );
  expect(quote, 'a draft quote for Mrs Johnson exists on the server').toBeTruthy();
  await expect(proposal.getByTestId('quote-total')).toHaveText(
    money(quote!.totalCents, state.business.currency),
  );
  await expect(
    proposal.getByText(money(quote!.subtotalCents, state.business.currency)).first(),
  ).toBeVisible();

  await proposal.getByRole('button', { name: 'Approve quote' }).click();
  const dialog = page.getByRole('dialog', { name: 'Approve this quote?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Yes, approve' }).click();
  await expect(dialog).toBeHidden();
  await expect(proposal.getByText('Quote approved')).toBeVisible();

  // The approval is persisted: the quote page shows Approved after navigation.
  await page.goto(`/#/quotes/${quote!.id}`);
  await expect(page.getByTestId('quote-status')).toHaveText(/Approved/);
  const after = await readState(page.request);
  expect(after.quotes.find((entry) => entry.id === quote!.id)?.status).toBe('approved');
});

test('viewer sees approval disabled and the server refuses a viewer approval', async ({
  page,
  browser,
  baseURL,
}) => {
  test.skip(!owner.password || !viewer.password, 'Owner and viewer credentials are required.');

  // Arrange a fresh draft quote as the owner through the API (same contract the UI uses).
  const ownerContext = await browser.newContext({ baseURL });
  const ownerRequest = ownerContext.request;
  const origin = new URL(baseURL!).origin;
  expect(
    (await ownerRequest.post('/api/auth/login', { data: owner, headers: { Origin: origin } })).ok(),
  ).toBeTruthy();
  const seeded = await readState(ownerRequest);
  const johnson = seeded.customers.find((customer) => customer.name === 'Mrs Johnson');
  expect(johnson).toBeTruthy();
  const enquiry = await ownerRequest.post('/api/enquiries', {
    data: { text: REQUEST, customerId: johnson!.id },
    headers: { Origin: origin, 'Idempotency-Key': `e2e-viewer-${Date.now()}` },
  });
  expect(enquiry.ok()).toBeTruthy();
  const { quoteId } = (await enquiry.json()) as { quoteId: string };
  await ownerContext.close();

  await signIn(page, viewer);
  await expect(page.getByText('View only').first()).toBeVisible();
  await page.goto(`/#/quotes/${quoteId}`);
  const approve = page.getByRole('button', { name: 'Approve quote' });
  await expect(approve).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reject' })).toBeDisabled();
  await expect(
    page.getByText('only the business owner can approve or reject quotes'),
  ).toBeVisible();

  // The assistant is owner-only too, and says so rather than failing silently.
  await page.goto('/#/assistant');
  await expect(page.getByLabel('Describe the work or what you need')).toBeDisabled();

  // Server-side enforcement does not depend on the disabled button.
  const state = await readState(page.request);
  const quote = state.quotes.find((entry) => entry.id === quoteId)!;
  const attempt = await page.request.post(`/api/quotes/${quoteId}/approve`, {
    data: { version: quote.version },
    headers: { Origin: origin, 'Idempotency-Key': `e2e-viewer-approve-${Date.now()}` },
  });
  expect(attempt.status()).toBe(403);
  expect((await readState(page.request)).quotes.find((entry) => entry.id === quoteId)?.status).toBe(
    'draft',
  );
});
