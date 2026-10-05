import { expect, test } from '@playwright/test';
import { noAxeViolations, unique } from './support/checks';
import { apiSessionFor, signedInStaff } from './support/session';
import { emailedToken } from './support/staff';

// Invitations and role changes send their email before answering, which is slow when every test worker sends at once.
const afterEmail = expect.configure({ timeout: 15_000 });

test('an administrator invites someone, then gives them a role', async ({ page, request }) => {
  await signedInStaff(page, request, ['administrator']);
  const email = `e2e-invite-${unique()}@example.com`;

  await page.getByRole('link', { name: 'Staff' }).click();
  await noAxeViolations(page);
  await page.getByRole('link', { name: 'Invite someone' }).click();
  await noAxeViolations(page);
  await page.getByLabel('Name').fill('Morgan Hale');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send invitation' }).click();

  await afterEmail(page.getByRole('heading', { name: 'Morgan Hale' })).toBeVisible();
  await expect(page.getByText(`Invitation sent to ${email}.`)).toBeVisible();
  await noAxeViolations(page);
  await page.getByRole('button', { name: 'Give the Fee earner role' }).click();
  await afterEmail(page.getByRole('status')).toContainText('Fee earner role given. Morgan Hale has been emailed.');
  await expect(page.getByRole('row', { name: /^Fee earner Runs matters day to day Yes/ })).toBeVisible();
  expect(await emailedToken(email, '/accept-invitation')).toMatch(/^[A-Za-z0-9_-]{43}$/);

  await page.getByRole('link', { name: 'Back to staff' }).click();
  await expect(page.getByRole('row', { name: `Morgan Hale ${email} Invited Fee earner` })).toBeVisible();
});

test('says what is wrong with an invitation before sending it', async ({ page, request }) => {
  await signedInStaff(page, request, ['administrator']);
  await page.goto('/staff/invite');

  await page.getByLabel('Email address').fill('not an address');
  await page.getByRole('button', { name: 'Send invitation' }).click();

  const problem = page.getByRole('alert', { name: 'There is a problem' });
  await expect(problem).toContainText('Enter their name');
  await expect(problem).toContainText('Enter their email address');
});

test('disabling signs the person out at once; re-enabling sends a new invitation', async ({ page, request }) => {
  const person = await apiSessionFor(request, ['fee_earner']);
  await signedInStaff(page, request, ['administrator']);

  await page.goto(`/staff/${person.accountId}`);
  await page.getByRole('button', { name: 'Disable the account' }).click();
  await afterEmail(page.getByRole('status')).toContainText('Disabled. They have been signed out.');
  await expect(page.getByText('Disabled', { exact: true })).toBeVisible();
  expect((await person.api.get('/api/auth/session')).status()).toBe(401);
  await expect(page.getByRole('button', { name: 'Give the Partner role' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Re-enable the account' }).click();
  await afterEmail(page.getByRole('status')).toContainText(`Re-enabled. ${person.staff.displayName} has been sent a new invitation.`);
  await expect(page.getByText('Invited', { exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: /^Fee earner .* Yes/ })).toBeVisible();
});

test('an administrator cannot change their own account', async ({ page, request }) => {
  await signedInStaff(page, request, ['administrator']);
  const { account } = (await (await page.request.get('/api/auth/session')).json()) as { account: { id: string } };

  await page.goto(`/staff/${account.id}`);

  await expect(page.getByText('This is your own account.')).toBeVisible();
  await expect(page.getByRole('button', { name: /role|account/ })).toHaveCount(0);
});

test('a partner sees the staff list, but changes are refused', async ({ page, request }) => {
  const person = await apiSessionFor(request, ['fee_earner']);
  await signedInStaff(page, request, ['partner']);

  await page.goto(`/staff/${person.accountId}`);
  await page.getByRole('button', { name: 'Give the Partner role' }).click();

  await expect(page.getByRole('alert', { name: 'There is a problem' })).toContainText('Only administrators can change staff accounts');
  await expect(page.getByRole('row', { name: /^Partner .* No/ })).toBeVisible();
});

test('a fee earner cannot see the staff list', async ({ page, request }) => {
  await signedInStaff(page, request);

  await page.goto('/staff');

  await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible();
});
