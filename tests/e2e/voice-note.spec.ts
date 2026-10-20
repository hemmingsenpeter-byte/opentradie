import { expect, test } from '@playwright/test';

/**
 * Voice note journey (ADR 0024): the owner uploads a recording on a job card; the server
 * transcribes it (SPEECH_PROVIDER=mock returns a fixed synthetic transcript) and the mock agent
 * proposes job updates that wait in the Approval inbox. Real API and PostgreSQL; mock speech and
 * mock agent only, so this is not evidence of a real speech or model integration.
 */
const owner = {
  email: process.env.OWNER_EMAIL ?? 'owner@demo.opentradie.test',
  password: process.env.OWNER_PASSWORD ?? '',
};

/** A tiny synthetic RIFF/WAVE file: enough for the server's magic-byte check. */
function wav(): Buffer {
  const data = Buffer.from(`synthetic-e2e-audio-${Date.now()}`);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  return Buffer.concat([header, data]);
}

test('owner records a voice update on a job and approves the proposed time', async ({
  page,
  baseURL,
}) => {
  test.skip(!owner.password, 'Set OWNER_PASSWORD (pnpm setup:dev writes it to .env).');
  // Late in a full suite the API's per-IP rate limit (300/min) can briefly reject status polls;
  // allow one rate-limit window to pass.
  test.setTimeout(150_000);
  for (let attempt = 0; attempt < 14; attempt++) {
    if ((await page.request.get('/health')).status() !== 429) break;
    await page.waitForTimeout(5_000);
  }
  await page.goto('/');
  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Password').fill(owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  // Arrange an in-progress job through the API with the signed-in session.
  const origin = new URL(baseURL!).origin;
  const headers = (key: string) => ({ origin, 'idempotency-key': key });
  const customers = await (await page.request.get('/api/customers?q=Patel')).json();
  const stamp = Date.now();
  const job = await page.request.post('/api/jobs', {
    headers: headers(`e2e-voice-job-${stamp}`),
    data: { customerId: customers.customers[0].id, title: `Voice journey ${stamp}` },
  });
  expect(job.status()).toBe(201);
  const jobId = (await job.json()).id as string;
  const started = await page.request.patch(`/api/jobs/${jobId}`, {
    headers: headers(`e2e-voice-start-${stamp}`),
    data: { status: 'in_progress' },
  });
  expect(started.status()).toBe(200);

  // Reload so the workspace state includes the job created above.
  await page.goto(`/#/jobs/${jobId}`);
  await page.reload();
  const panel = page.getByTestId('voice-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('voice-input').setInputFiles({
    name: 'update.wav',
    mimeType: 'audio/wav',
    buffer: wav(),
  });

  await expect(panel.getByTestId('voice-status')).toHaveText('Proposals ready', {
    timeout: 90_000,
  });
  await expect(panel.getByTestId('voice-transcript')).toContainText('hot water cylinder');
  await expect(panel.getByTestId('low-confidence')).toContainText('Reece');
  const proposals = panel.getByRole('list', { name: 'Proposals from this voice note' });
  await expect(proposals.getByText(/Record 1\.5 h/)).toBeVisible();
  await expect(proposals.getByText(/reported supplier cost \$185\.00/)).toBeVisible();

  await panel.getByTestId('voice-approvals-link').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Approval inbox' })).toBeVisible();
  const time = page
    .getByRole('list', { name: 'Proposed actions' })
    .getByRole('listitem')
    .filter({ hasText: `Voice journey ${stamp}` })
    .filter({ hasText: 'Propose time entry' });
  await time.getByRole('button', { name: 'Approve' }).click();
  await expect(time).toHaveCount(0);

  const detail = await (await page.request.get(`/api/jobs/${jobId}`)).json();
  expect(JSON.stringify(detail.timeline)).toContain('1.5 h recorded');
});
