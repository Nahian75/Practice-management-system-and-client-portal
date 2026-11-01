import { expect, test } from './support/test';
import { follow, noAxeViolations, unique } from './support/checks';
import { apiSessionFor, signedInStaff } from './support/session';
import { emailedToken } from './support/staff';

// Invitations and role changes send their email before answering, which is slow when every test worker sends at once.
const afterEmail = expect.configure({ timeout: 15_000 });

test('staff management is discoverable in navigation and workspace search', async ({ page, request }) => {
  await signedInStaff(page, request, ['administrator']);
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Staff management', exact: true })).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search your workspace' });
  await search.fill('staff');
  const suggestions = page.getByRole('region', { name: 'Search suggestions' });
  await expect(suggestions.getByRole('link', { name: /Staff management/ })).toBeVisible();
  await noAxeViolations(page);
  await search.press('Escape');
  await expect(suggestions).toHaveCount(0);
  await search.fill('users');
  await suggestions.getByRole('link', { name: /Staff management/ }).click();
  await expect(page.getByRole('heading', { name: 'Staff', exact: true })).toBeVisible();
  await search.fill('staff');
  await search.press('Enter');
  await expect(page.getByRole('main').getByRole('link', { name: /Staff management/ })).toBeVisible();
});

test('workspace search does not suggest staff management without staff access', async ({ page, request }) => {
  await signedInStaff(page, request, ['fee_earner']);
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Staff management', exact: true })).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search your workspace' }).fill('staff');
  await expect(page.getByRole('region', { name: 'Search suggestions' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Search suggestions' }).getByRole('link', { name: /Staff management/ })).toHaveCount(0);
});

test('an administrator invites someone, then gives them a role', async ({ page, request }) => {
  await signedInStaff(page, request, ['administrator']);
  const email = `e2e-invite-${unique()}@example.com`;

  await follow(page, page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true }));
  await follow(page, page.getByRole('link', { name: /Users & permissions/ }));
  await noAxeViolations(page);
  await follow(page, page.getByRole('link', { name: 'Add user' }));
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
  await expect(page.getByRole('row', { name: new RegExp(`Morgan Hale ${email.replaceAll('.', '\\.')} Invited Fee earner`) })).toBeVisible();
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

test('a partner sees read-only staff controls and cannot change accounts', async ({ page, request }) => {
  const person = await apiSessionFor(request, ['fee_earner']);
  await signedInStaff(page, request, ['partner']);

  await page.goto(`/staff/${person.accountId}`);
  await expect(page.getByText('Your access is read-only.', {exact:false})).toBeVisible();
  await expect(page.getByRole('button', {name:/role|account/})).toHaveCount(0);
  const refused=await page.request.put(`/api/staff/${person.accountId}/roles/partner`);
  expect(refused.status()).toBe(403);
  await page.goto('/staff');
  await expect(page.getByRole('link',{name:'Add user',exact:true})).toHaveCount(0);
});

test('a fee earner cannot see the staff list', async ({ page, request }) => {
  await signedInStaff(page, request);

  await page.goto('/staff');

  await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible();
});


test('staff list exposes status tabs, access actions and the HR role',async({page,request})=>{
 const person=await apiSessionFor(request,['fee_earner']);
 await signedInStaff(page,request,['administrator']);
 await page.goto('/staff');
 await expect(page.getByRole('link',{name:'Add user',exact:true})).toBeVisible();
 const tabs=page.getByRole('navigation',{name:'Staff status'});
 for(const name of ['All users','Active','Invited','Disabled'])await expect(tabs.getByRole('link',{name:new RegExp('^'+name+' [(]')})).toBeVisible();
 const row=page.getByRole('row').filter({hasText:person.staff.email});
 await row.getByRole('link',{name:/Manage roles/}).click();
 await expect(page.getByRole('button',{name:'Give the HR role',exact:true})).toBeVisible();
 await page.getByRole('link',{name:'Back to staff'}).click();
 await row.getByRole('link',{name:/Disable account/}).click();
 await expect(page.getByRole('heading',{name:'Account access',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Disable the account',exact:true})).toBeVisible();
 await page.goto('/staff?status=disabled');
 await expect(tabs.getByRole('link',{name:/^Disabled/})).toHaveAttribute('aria-current','page');
 await expect(page.getByRole('row').filter({hasText:person.staff.email})).toHaveCount(0);
});
