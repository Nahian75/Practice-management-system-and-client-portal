import { expect, test, type Page } from '@playwright/test';
import { follow, noAxeViolations, randomName, unique, watchForCspViolations } from './support/checks';
import { openMatter } from './support/matters';
import { apiSessionFor, signedInStaff } from './support/session';

/** A new individual client of the person signed in on `page`. */
async function newClient(page: Page) {
  const givenNames = randomName();
  const familyName = randomName();
  const response = await page.request.post('/api/clients', { data: { kind: 'individual', givenNames, familyName } });
  expect(response.status()).toBe(201);
  return { ...((await response.json()) as { id: string }), name: `${givenNames} ${familyName}` };
}

test('a fee earner opens a matter with a clear conflict check, and finds it again', async ({ page, request }) => {
  // Three people to set up, and every colleague in the test database is a choice on the form.
  test.slow();
  const violations = await watchForCspViolations(page);
  const partner = await apiSessionFor(request, ['partner']);
  const colleague = await apiSessionFor(request);
  await signedInStaff(page, request);
  const client = await newClient(page);
  const opponent = randomName();

  await page.goto(`/clients/${client.id}`);
  await follow(page, page.getByRole('link', { name: 'Open a matter' }));
  await noAxeViolations(page);
  await page.getByRole('group', { name: 'Other party 1' }).getByLabel('Name').fill(opponent);
  await page.getByRole('button', { name: 'Run conflict check' }).click();

  await expect(page.getByText('No possible conflicts were found.')).toBeVisible();
  await expect(page.getByText(`Names checked: ${client.name}; ${opponent}.`)).toBeVisible();
  await noAxeViolations(page);
  await page.getByLabel('Title').fill('Purchase of 12 High Street');
  await page.getByLabel('Type of work').selectOption('Residential property');
  await page.getByLabel('Supervising partner').selectOption(partner.staff.displayName);
  await page.getByLabel(colleague.staff.displayName).check();
  await page.getByRole('button', { name: 'Open matter' }).click();

  await expect(page.getByRole('heading', { name: 'Purchase of 12 High Street' })).toBeVisible();
  await expect(page.getByText(/^C-\d{6,}\/\d{3,} · Open$/)).toBeVisible();
  await expect(page.getByRole('row', { name: `${partner.staff.displayName} Supervising partner` })).toBeVisible();
  await expect(page.getByRole('row', { name: `${colleague.staff.displayName} Fee earner` })).toBeVisible();
  await expect(page.getByRole('row', { name: `${opponent} Opponent Person` })).toBeVisible();
  await page.reload();
  await noAxeViolations(page);

  await page.getByRole('link', { name: 'Matters' }).click();
  await page.getByRole('link', { name: 'Purchase of 12 High Street' }).click();
  await expect(page.getByRole('link', { name: new RegExp(client.name) })).toBeVisible();
  expect(violations).toEqual([]);
});

test('a possible conflict holds the matter until its supervising partner clears it with a reason', async ({ page, request }) => {
  const someoneElse = await apiSessionFor(request);
  const existingName = `Existing${unique()}`;
  await someoneElse.api.post('/api/clients', { data: { kind: 'individual', givenNames: 'Robin', familyName: existingName } });
  await signedInStaff(page, request, ['partner']);
  const client = await newClient(page);

  await page.goto(`/clients/${client.id}/matters/new`);
  await page.getByRole('group', { name: 'Other party 1' }).getByLabel('Name').fill(`Robin ${existingName}`);
  await page.getByRole('button', { name: 'Run conflict check' }).click();
  await expect(page.getByRole('row', { name: new RegExp(`Robin ${existingName} Robin ${existingName} Client C-`) })).toBeVisible();
  await page.getByLabel('Title').fill('Boundary dispute');
  await page.getByRole('button', { name: 'Open matter' }).click();

  await expect(page.getByText(/· Awaiting conflict clearance$/)).toBeVisible();
  await noAxeViolations(page);
  await page.getByLabel('Why they are not a conflict').fill('Too short');
  await page.getByRole('button', { name: 'Clear and open the matter' }).click();
  await expect(page.getByRole('alert', { name: 'There is a problem' })).toContainText('Give a reason of 10 to 500 characters');

  await page.getByLabel('Why they are not a conflict').fill('A different person: checked the date of birth and address');
  await page.getByRole('button', { name: 'Clear and open the matter' }).click();

  await expect(page.getByText(/· Open$/)).toBeVisible();
  await expect(page.getByText('A different person: checked the date of birth and address')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear and open the matter' })).toHaveCount(0);
});

test('changing the other parties needs a new check, and the matter needs a title', async ({ page, request }) => {
  await signedInStaff(page, request, ['partner']);
  const client = await newClient(page);
  await page.goto(`/clients/${client.id}/matters/new`);

  await page.getByRole('group', { name: 'Other party 1' }).getByLabel('Name').fill(`First ${unique()}`);
  await page.getByRole('button', { name: 'Add another party' }).click();
  const second = `Second ${unique()}`;
  await page.getByRole('group', { name: 'Other party 2' }).getByLabel('Name').fill(second);
  await page.getByRole('group', { name: 'Other party 2' }).getByLabel('Role').selectOption("Opponent's solicitor");
  await page.getByRole('group', { name: 'Other party 2' }).getByLabel('Person or organisation').selectOption('An organisation');
  await page.getByRole('button', { name: 'Remove other party 1' }).click();
  await page.getByRole('button', { name: 'Run conflict check' }).click();
  await expect(page.getByText(`Names checked: ${client.name}; ${second}.`)).toBeVisible();

  await page.getByRole('button', { name: 'Change the other parties' }).click();
  await expect(page.getByRole('group', { name: 'Other party 1' }).getByLabel('Name')).toHaveValue(second);
  await page.getByRole('button', { name: 'Run conflict check' }).click();
  await page.getByRole('button', { name: 'Open matter' }).click();
  await expect(page.getByRole('alert', { name: 'There is a problem' })).toContainText('Enter a title for the matter');

  await page.getByLabel('Title').fill('Lease renewal');
  await page.getByRole('button', { name: 'Open matter' }).click();
  await expect(page.getByRole('row', { name: `${second} Opponent's solicitor Organisation` })).toBeVisible();
});

test('someone not on the team cannot see the matter, nor tell whether it exists', async ({ page, request }) => {
  const partner = await apiSessionFor(request, ['partner']);
  const { id, title } = await openMatter(partner.api, partner.accountId);
  await signedInStaff(page, request);

  await page.goto(`/matters/${id}`);
  await expect(page.getByRole('heading', { name: 'You cannot see this matter' })).toBeVisible();
  await expect(page.getByText(title)).toHaveCount(0);

  await page.goto('/matters/00000000-0000-7000-8000-000000000000');
  await expect(page.getByRole('heading', { name: 'You cannot see this matter' })).toBeVisible();
});

test('tells someone without matter access so, plainly', async ({ page, request }) => {
  await signedInStaff(page, request, ['accounts']);

  await page.goto('/matters');

  await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible();
});
