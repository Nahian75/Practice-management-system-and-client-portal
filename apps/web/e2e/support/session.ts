import { expect, request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_WEB_URL } from '../../playwright.config';
import { createStaff, type TestStaff } from './staff';

const backupCodeUsed = new Map<string, number>();

/** The next unused backup code: each works once, and there are ten. */
function nextBackupCode(staff: TestStaff): string {
  const used = backupCodeUsed.get(staff.email) ?? 0;
  backupCodeUsed.set(staff.email, used + 1);
  const code = staff.backupCodes[used];
  if (!code) {
    throw new Error('Out of backup codes');
  }
  return code;
}

/** A new staff member with these roles, signed in in the browser through the sign-in page. */
export async function signedInStaff(page: Page, request: APIRequestContext, roles: string[] = ['fee_earner']): Promise<TestStaff> {
  const staff = await createStaff(request, roles);
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(staff.email);
  await page.getByLabel('Password').fill(staff.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Security code').fill(nextBackupCode(staff));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  return staff;
}

/**
 * Another staff member with their own signed-in API session, for setting up
 * what a test needs (for example a client someone else is responsible for).
 */
export async function apiSessionFor(request: APIRequestContext, roles: string[] = ['fee_earner']) {
  const staff = await createStaff(request, roles);
  const context = await playwrightRequest.newContext({ baseURL: E2E_WEB_URL });
  await context.post('/api/auth/sign-in', { data: { email: staff.email, password: staff.password } });
  const signedIn = await context.post('/api/auth/two-factor', { data: { code: nextBackupCode(staff) } });
  expect(signedIn.status()).toBe(200);
  return { staff, api: context };
}
