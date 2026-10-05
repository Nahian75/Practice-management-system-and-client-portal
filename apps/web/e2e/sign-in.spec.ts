import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createStaff, nextTotp, type TestStaff } from './support/staff';

async function signInWithPassword(page: Page, staff: TestStaff, password = staff.password) {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(staff.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function enterCode(page: Page, code: string) {
  await page.getByLabel('Security code').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
}

test('sends someone who is not signed in to the sign-in page', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page).toHaveTitle('Sign in – Stass');
});

test('signs in with a password and an authenticator code, and signs out', async ({ page, request }) => {
  test.slow(); // waits for the next 30-second code
  const staff = await createStaff(request);

  await signInWithPassword(page, staff);
  await enterCode(page, await nextTotp(staff.secret));

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByText(`You are signed in as ${staff.displayName}.`)).toBeVisible();

  const signedOut = page.waitForResponse('**/api/auth/sign-out');
  await page.getByRole('button', { name: 'Sign out' }).click();
  expect((await (await signedOut).allHeaders())['clear-site-data']).toBe('"cache"');
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('signs in with a backup code', async ({ page, request }) => {
  const staff = await createStaff(request);

  await signInWithPassword(page, staff);
  await enterCode(page, staff.backupCodes[0] ?? '');

  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
});

test("shows the API's message for a wrong password, and moves focus to it", async ({ page, request }) => {
  const staff = await createStaff(request);

  await signInWithPassword(page, staff, 'not-the-right-password');

  const summary = page.getByRole('alert', { name: 'There is a problem' });
  await expect(summary).toContainText('Email or password is incorrect');
  await expect(summary).toBeFocused();
  await expect(page.getByLabel('Security code')).toHaveCount(0);
});

test('sends a strict Content Security Policy and the other security headers, and breaks no rule of its own', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) {
      violations.push(message.text());
    }
  });

  const response = await page.goto('/sign-in');
  const headers = response?.headers() ?? {};

  expect(headers['content-security-policy']).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['content-security-policy']).not.toContain('unsafe-inline');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['cache-control']).toContain('no-store');
  expect(headers['x-powered-by']).toBeUndefined();
  await page.getByLabel('Email address').fill('someone@example.com');
  expect(violations).toEqual([]);
});

test('gives each page a different nonce', async ({ request }) => {
  const nonce = async () => /'nonce-([^']+)'/.exec((await request.get('/sign-in')).headers()['content-security-policy'] ?? '')?.[1];

  expect(await nonce()).not.toEqual(await nonce());
});

test('refuses a form posted from another site', async ({ request }) => {
  const response = await request.post('/api/auth/sign-in', {
    headers: { 'Sec-Fetch-Site': 'cross-site' },
    data: { email: 'someone@example.com', password: 'whatever-it-is' },
  });

  expect(response.status()).toBe(403);
});

test('keeps nothing in browser storage, and the session cookie out of reach of scripts', async ({ page, request, context }) => {
  const staff = await createStaff(request);
  await signInWithPassword(page, staff);
  await enterCode(page, staff.backupCodes[1] ?? '');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();

  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(await page.evaluate(() => document.cookie)).toBe('');
  const [cookie] = (await context.cookies()).filter((c) => c.name === '__Host-session');
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
});

test('has no accessibility problems axe can find on the sign-in and home pages', async ({ page, request }) => {
  await page.goto('/sign-in');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);

  const staff = await createStaff(request);
  await signInWithPassword(page, staff);
  await enterCode(page, staff.backupCodes[2] ?? '');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
});
