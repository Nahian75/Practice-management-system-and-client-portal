import { expect, test } from '@playwright/test';
import { COUNTRY_CODES as API_COUNTRY_CODES } from '../../api/src/common/validation/country-codes';
import { COUNTRY_CODES as WEB_COUNTRY_CODES } from '../src/lib/country-codes';
import { follow, noAxeViolations, unique, watchForCspViolations } from './support/checks';
import { apiSessionFor, signedInStaff } from './support/session';

test('creates an individual client and shows the details in UK form', async ({ page, request }) => {
  const violations = await watchForCspViolations(page);
  await signedInStaff(page, request);
  const family = `Doe${unique()}`;

  await page.getByRole('link', { name: 'Clients' }).click();
  await expect(page.getByRole('link', { name: 'Clients' })).toHaveAttribute('aria-current', 'page');
  await noAxeViolations(page);
  await follow(page, page.getByRole('link', { name: 'Create a client' }));
  await noAxeViolations(page);

  await page.getByLabel('Given names').fill('Jane');
  await page.getByLabel('Family name').fill(family);
  await page.getByLabel('Day').fill('29');
  await page.getByLabel('Month').fill('2');
  await page.getByLabel('Year').fill('1980');
  await page.getByLabel('Email (optional)').fill('Jane@Example.com');
  await page.getByLabel('Address line 1').fill('1 High Street');
  await page.getByLabel('Town or city').fill('Leeds');
  await page.getByLabel('Postcode (optional)').fill('ls1 1aa');
  await page.getByRole('button', { name: 'Create client' }).click();

  await expect(page.getByRole('heading', { name: `Jane ${family}` })).toBeVisible();
  await expect(page.getByText(/^C-\d{6,} · Individual$/)).toBeVisible();
  await expect(page.getByText('29 February 1980')).toBeVisible();
  await expect(page.getByText('jane@example.com')).toBeVisible();
  await expect(page.getByText('1 High Street, Leeds, LS1 1AA, United Kingdom')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: `Jane ${family}` })).toBeVisible();
  const answer = await page.request.get(`/api${new URL(page.url()).pathname}`);
  expect(answer.headers()['cache-control'], 'API answers through the pass-through are not kept (review W2)').toBe('no-store');
  await noAxeViolations(page);

  await page.getByRole('link', { name: 'Clients' }).click();
  await expect(page.getByRole('link', { name: `Jane ${family}` })).toBeVisible();
  expect(violations).toEqual([]);
});

test('changes details, and clearing a field removes it', async ({ page, request }) => {
  await signedInStaff(page, request);
  await page.goto('/clients/new');
  await page.getByLabel('Given names').fill('Sam');
  await page.getByLabel('Family name').fill(`Lee${unique()}`);
  await page.getByLabel('Phone (optional)').fill('020 7946 0000');
  await page.getByRole('button', { name: 'Create client' }).click();
  await expect(page.getByText('020 7946 0000')).toBeVisible();

  await follow(page, page.getByRole('link', { name: 'Change details' }));
  await noAxeViolations(page);
  await page.getByLabel('Family name').fill('Smith');
  await page.getByLabel('Phone (optional)').fill('');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.getByRole('heading', { name: 'Sam Smith' })).toBeVisible();
  await expect(page.getByText('020 7946 0000')).toHaveCount(0);
});

test('shows what is wrong when required details are missing', async ({ page, request }) => {
  await signedInStaff(page, request);
  await page.goto('/clients/new');

  await page.getByRole('button', { name: 'Create client' }).click();

  await expect(page.getByRole('alert', { name: 'There is a problem' })).toContainText('names are required');
});

test('creates an organisation, adds a contact, and marks them as no longer a contact', async ({ page, request }) => {
  await signedInStaff(page, request);
  const name = `Acme ${unique()} Ltd`;
  await page.goto('/clients/new');
  await page.getByLabel('An organisation, such as a company, charity or trust').check();
  await page.getByLabel('Legal name').fill(name);
  await page.getByLabel('Registration number (optional)').fill('sc123456');
  await page.getByRole('button', { name: 'Create client' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByText('SC123456')).toBeVisible();

  await follow(page, page.getByRole('link', { name: 'Add a contact' }));
  await noAxeViolations(page);
  await page.getByLabel('Given names').fill('Kim');
  await page.getByLabel('Family name').fill('Ray');
  await page.getByLabel('Job title (optional)').fill('Finance Director');
  await page.getByRole('button', { name: 'Add contact' }).click();
  await expect(page.getByRole('cell', { name: 'Finance Director' })).toBeVisible();

  await page.getByRole('link', { name: 'Change Kim Ray' }).click();
  await page.getByLabel('No longer a contact').check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('(no longer a contact)')).toBeVisible();
});

test("finds another person's client by name, but cannot open it, nor take it over as a fee earner", async ({ page, request }) => {
  const someoneElse = await apiSessionFor(request);
  const name = `Hidden${unique()}`;
  const created = await someoneElse.api.post('/api/clients', { data: { kind: 'individual', givenNames: 'Alex', familyName: name } });
  const { id } = (await created.json()) as { id: string };
  await signedInStaff(page, request);

  await page.goto('/clients');
  await page.getByLabel('Name or reference').fill(name);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('link', { name: `Alex ${name}` }).click();

  await expect(page).toHaveURL(new RegExp(`/clients/${id}$`));
  await expect(page.getByRole('heading', { name: 'You cannot see this client' })).toBeVisible();
  await page.getByLabel('Reason').fill('The fee earner has left the firm');
  await page.getByRole('button', { name: 'Take over' }).click();
  await expect(page.getByRole('alert', { name: 'There is a problem' })).toContainText('Only partners can take over a client');
});

test('asks for at least 2 characters to search', async ({ page, request }) => {
  await signedInStaff(page, request);
  await page.goto('/clients');

  await page.getByLabel('Name or reference').fill('a');
  await page.getByRole('button', { name: 'Search' }).click();

  await expect(page.getByRole('alert', { name: 'There is a problem' })).toContainText('Enter at least 2 characters');
});

test('tells someone without client access so, plainly', async ({ page, request }) => {
  await signedInStaff(page, request, ['accounts']);

  await page.goto('/clients');

  await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible();
});

test('offers exactly the countries the API accepts', () => {
  expect([...WEB_COUNTRY_CODES].sort()).toEqual([...API_COUNTRY_CODES].sort());
});
