import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Feature 5 accessibility checks, automated and dependency-free: landmarks, accessible names,
 * keyboard reach and focus visibility, dialog focus trap, and WCAG contrast of the design tokens.
 * This is not a substitute for screen-reader testing (VoiceOver/TalkBack are not covered).
 */
const owner = {
  email: process.env.OWNER_EMAIL ?? 'owner@demo.opentradie.test',
  password: process.env.OWNER_PASSWORD ?? '',
};

test.use({ viewport: { width: 390, height: 844 } });
test.describe.configure({ timeout: 150_000 });

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

/** Returns a description of every violation found on the current page. */
async function audit(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const visible = (el: Element) => {
      const box = (el as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && (box.width || box.height);
    };
    const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const byIds = (ids: string | null) =>
      (ids ?? '')
        .split(/\s+/)
        .map((id) =>
          id ? text(document.getElementById(id) ?? document.body.ownerDocument.body) : '',
        )
        .join('')
        .trim();
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`;
    const h1s = Array.from(document.querySelectorAll('h1')).filter(visible);
    if (h1s.length !== 1) problems.push(`expected one h1, found ${h1s.length}`);
    if (document.querySelectorAll('main, [role="main"]').length !== 1)
      problems.push('expected exactly one main landmark');
    for (const el of Array.from(document.querySelectorAll('input, select, textarea'))) {
      const input = el as HTMLInputElement;
      if (input.type === 'hidden' || !visible(el)) continue;
      const name =
        (input.labels ? Array.from(input.labels).map(text).join('') : '') ||
        el.getAttribute('aria-label') ||
        byIds(el.getAttribute('aria-labelledby'));
      if (!name?.trim()) problems.push(`unlabelled field ${describe(el)}`);
    }
    for (const el of Array.from(
      document.querySelectorAll('button, a[href], [role="button"], [role="tab"]'),
    )) {
      if (!visible(el)) continue;
      const name =
        el.getAttribute('aria-label') ||
        byIds(el.getAttribute('aria-labelledby')) ||
        text(el) ||
        el.querySelector('img[alt]:not([alt=""])')?.getAttribute('alt');
      if (!name) problems.push(`nameless ${describe(el)}`);
    }
    for (const img of Array.from(document.querySelectorAll('img')))
      if (!img.hasAttribute('alt')) problems.push(`image without alt ${img.src}`);
    return problems;
  });
}

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
};
export const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

test('design tokens meet WCAG AA contrast (4.5:1) for text pairs in use', () => {
  const css = readFileSync('apps/web/src/styles.css', 'utf8');
  const token = (name: string) => {
    const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
    expect(match, `token ${name}`).not.toBeNull();
    return match![1]!;
  };
  const pairs: [string, string][] = [
    ['ink', 'paper'],
    ['ink', 'hivis'],
    ['ink', 'paper-deep'],
    ['steel', 'paper'],
    ['muted', 'paper'],
    ['muted', 'paper-deep'],
    ['link', 'paper'],
    ['go', 'go-bg'],
    ['stop', 'stop-bg'],
    ['caution', 'caution-bg'],
    ['info', 'info-bg'],
    ['stop', 'paper'],
    ['go', 'paper'],
  ];
  for (const [fg, bg] of pairs)
    expect(contrast(token(fg), token(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
});

test('main screens expose landmarks, names, alt text and keyboard focus', async ({
  page,
  baseURL,
}) => {
  test.skip(!owner.password, 'Set OWNER_PASSWORD (pnpm setup:dev writes it to .env).');
  await signIn(page, new URL(baseURL!).origin);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  const state = (await (await page.request.get('/api/state')).json()) as {
    customers: { id: string; name: string }[];
    jobs: { id: string }[];
    quotes: { id: string }[];
  };
  const paths = [
    '/#/',
    '/#/customers',
    `/#/customers/${state.customers[0]!.id}`,
    '/#/jobs',
    ...(state.jobs[0] ? [`/#/jobs/${state.jobs[0].id}`] : []),
    '/#/quotes',
    ...(state.quotes[0] ? [`/#/quotes/${state.quotes[0].id}`] : []),
    '/#/invoices',
    '/#/calendar',
    '/#/inbox',
    '/#/approvals',
    '/#/settings',
    '/#/settings/rates',
    '/#/settings/security',
  ];
  for (const path of paths) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await audit(page), path).toEqual([]);
  }

  // The tab bar is reachable from the keyboard and shows a visible focus indicator.
  await page.goto('/#/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav).toBeVisible();
  const first = nav.getByRole('link').first();
  await first.focus();
  await expect(first).toBeFocused();
  await page.keyboard.press('Tab');
  const second = nav.getByRole('link').nth(1);
  await expect(second).toBeFocused();
  const ring = await second.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2,
      shadow: style.boxShadow !== 'none',
    };
  });
  expect(ring.outline || ring.shadow).toBe(true);
});

test('the erase dialog traps focus and closes on Escape', async ({ page, baseURL }) => {
  test.skip(!owner.password, 'Set OWNER_PASSWORD (pnpm setup:dev writes it to .env).');
  await signIn(page, new URL(baseURL!).origin);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  const state = (await (await page.request.get('/api/state')).json()) as {
    customers: { id: string; name: string }[];
  };
  await page.goto(`/#/customers/${state.customers[0]!.id}`);
  await page.getByRole('button', { name: 'Erase customer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Erase this customer?' });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    // Focus stays in the dialog (or leaves to the browser, never to the inert page behind it).
    expect(
      await page.evaluate(
        () =>
          document.activeElement === document.body || !!document.activeElement?.closest('dialog'),
      ),
    ).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
