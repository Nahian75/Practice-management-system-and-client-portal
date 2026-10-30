import { expect, test, type Page } from './support/test';
import { noAxeViolations, randomName, unique } from './support/checks';
import { signedInStaff } from './support/session';
import { createStaff, emailedToken } from './support/staff';

/** A new individual client of the person signed in on `page`, with this email on record. */
async function individualClient(page: Page, email: string | null) {
  const familyName = randomName();
  const response = await page.request.post('/api/clients', {
    data: { kind: 'individual', givenNames: 'Jane', familyName, ...(email ? { email } : {}) },
  });
  expect(response.status()).toBe(201);
  return { id: ((await response.json()) as { id: string }).id, name: `Jane ${familyName}` };
}

test('invites an individual client at the address on record, then ends their access', async ({ page, request }) => {
  await signedInStaff(page, request);
  const email = `e2e-client-${unique()}@example.com`;
  const client = await individualClient(page, email);

  await page.goto(`/clients/${client.id}`);
  await expect(page.getByText('Nobody can see this client in the portal yet.')).toBeVisible();
  await expect(page.getByText(`The invitation goes to ${email}, the address on record.`)).toBeVisible();
  await noAxeViolations(page);
  await page.getByRole('button', { name: `Invite ${client.name} to the portal` }).click();

  await expect(page.getByRole('region', { name: 'Portal access' }).getByRole('status')).toContainText(`${client.name} has been given access`);
  await expect(page.getByRole('row', { name: new RegExp(`${client.name} ${email} Invited, not yet set up`) })).toBeVisible();
  await expect(page.getByRole('button', { name: `Invite ${client.name} to the portal` })).toHaveCount(0);
  expect(await emailedToken(email, '/accept-invitation')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await noAxeViolations(page);

  await page.getByRole('button', { name: `End access for ${client.name}` }).click();
  await expect(page.getByRole('region', { name: 'Portal access' }).getByRole('status')).toContainText(`${client.name} can no longer see this client in the portal.`);
  await expect(page.getByText('Nobody can see this client in the portal yet.')).toBeVisible();
});

test("offers each of an organisation's contacts with an email address, and says how to add a missing one", async ({ page, request }) => {
  await signedInStaff(page, request);
  const created = await page.request.post('/api/clients', { data: { kind: 'organisation', legalName: `${randomName()} Ltd`, organisationType: 'company' } });
  const clientId = ((await created.json()) as { id: string }).id;
  await page.request.post(`/api/clients/${clientId}/contacts`, { data: { givenNames: 'Kim', familyName: 'Ray', email: `e2e-contact-${unique()}@example.com` } });
  await page.request.post(`/api/clients/${clientId}/contacts`, { data: { givenNames: 'Lee', familyName: 'Fox' } });

  await page.goto(`/clients/${clientId}`);

  await expect(page.getByRole('button', { name: 'Invite Kim Ray to the portal' })).toBeVisible();
  await expect(page.getByText('Lee Fox has no email address on record.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add one to invite them' })).toHaveAttribute('href', new RegExp(`/clients/${clientId}/contacts/`));
});

test("shows the API's reason when an address cannot be used for the portal", async ({ page, request }) => {
  const colleague = await createStaff(request);
  await signedInStaff(page, request);
  const client = await individualClient(page, colleague.email);

  await page.goto(`/clients/${client.id}`);
  await page.getByRole('button', { name: `Invite ${client.name} to the portal` }).click();

  await expect(page.getByRole('alert', { name: 'There is a problem' })).toContainText('belongs to a staff account');
  await expect(page.getByText('Nobody can see this client in the portal yet.')).toBeVisible();
});
