import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createStaff, emailedToken, inviteStaff, totp } from './support/staff';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const noAxeViolations = async (page: Page) => expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations).toEqual([]);

async function signIn(page: Page, email: string, password: string, code: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Security code').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
}

test.describe('accepting an invitation', () => {
  test('sets a password and an authenticator, shows the backup codes once, and the account can sign in', async ({ page }) => {
    const invited = await inviteStaff();
    const password = 'lantern-orchard-copper-tide';

    await page.goto(`/accept-invitation#token=${invited.token}`);
    await expect(page.getByText(`You have been invited as ${invited.displayName}`)).toBeVisible();
    // The token leaves the address bar as soon as it is read.
    await expect(page).not.toHaveURL(/#token=/);
    await noAxeViolations(page);

    await page.getByLabel('Choose a password').fill(password);
    await page.getByLabel('Type it again').fill('something-else-entirely');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert', { name: 'There is a problem' })).toContainText('The two passwords are not the same');

    await page.getByLabel('Type it again').fill(password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
    const secret = (await page.locator('code.secret').textContent())?.replaceAll(' ', '') ?? '';
    await noAxeViolations(page);

    await page.getByLabel('Code from the app').fill(totp(secret));
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('heading', { name: 'Keep your backup codes' })).toBeVisible();
    const codes = await page.locator('.backup-codes code').allTextContents();
    expect(codes).toHaveLength(10);
    await noAxeViolations(page);

    await page.getByRole('link', { name: /sign in/ }).click();
    await signIn(page, invited.email, password, codes[0] ?? '');
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  });

  test('lists every reason the API gives for refusing a password', async ({ page }) => {
    const invited = await inviteStaff();

    await page.goto(`/accept-invitation#token=${invited.token}`);
    await page.getByLabel('Choose a password').fill('short');
    await page.getByLabel('Type it again').fill('short');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('alert', { name: 'There is a problem' })).toContainText('Use at least 12 characters');
  });

  test('says when a link is invalid, without a token or with a made-up one', async ({ page }) => {
    await page.goto('/accept-invitation');
    await expect(page.getByText('This invitation link is invalid or has expired')).toBeVisible();

    await page.goto(`/accept-invitation#token=${'A'.repeat(43)}`);
    await expect(page.getByText('This invitation link is invalid or has expired')).toBeVisible();
  });
});

test.describe('resetting a password', () => {
  test('gives the same answer for an address with an account and one without', async ({ page, request }) => {
    const staff = await createStaff(request);
    const answerFor = async (email: string) => {
      await page.goto('/forgot-password');
      await page.getByLabel('Email address').fill(email);
      await page.getByRole('button', { name: 'Send the link' }).click();
      await expect(page.getByRole('link', { name: 'Back to sign in' })).toBeVisible();
      return page.getByRole('main').locator('p').first().textContent();
    };

    expect(await answerFor(staff.email)).toEqual(await answerFor(`nobody-${Date.now()}@example.com`));
  });

  test('changes the password from the emailed link; the old one stops working', async ({ page, request }) => {
    const staff = await createStaff(request);
    await page.goto('/sign-in');
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await page.getByLabel('Email address').fill(staff.email);
    await page.getByRole('button', { name: 'Send the link' }).click();
    const token = await emailedToken(staff.email, '/reset-password');
    const newPassword = 'meadow-granite-violin-north';

    await page.goto(`/reset-password#token=${token}`);
    await expect(page).not.toHaveURL(/#token=/);
    await noAxeViolations(page);
    await page.getByLabel('New password').fill(newPassword);
    await page.getByLabel('Type it again').fill(newPassword);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Your password has been changed')).toBeVisible();

    await signIn(page, staff.email, newPassword, staff.backupCodes[0] ?? '');
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);

    await page.getByLabel('Email address').fill(staff.email);
    await page.getByLabel('Password').fill(staff.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert', { name: 'There is a problem' })).toContainText('Email or password is incorrect');
  });

  test('says when a reset link is invalid', async ({ page }) => {
    await page.goto(`/reset-password#token=${'B'.repeat(43)}`);
    await page.getByLabel('New password').fill('meadow-granite-violin-north');
    await page.getByLabel('Type it again').fill('meadow-granite-violin-north');
    await page.getByRole('button', { name: 'Change password' }).click();

    await expect(page.getByText('This reset link is invalid or has expired')).toBeVisible();
  });
});
