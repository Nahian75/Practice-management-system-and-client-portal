import { expect, test, type APIRequestContext } from '@playwright/test';
import { noAxeViolations } from './support/checks';
import { apiSessionFor, signIn, signedInStaff } from './support/session';

test.describe.configure({ mode: 'serial', timeout: 90_000 });

const pattern = { timeZone: 'Europe/London', mondayMinutes: 450, tuesdayMinutes: 450,
  wednesdayMinutes: 450, thursdayMinutes: 450, fridayMinutes: 420, saturdayMinutes: 0, sundayMinutes: 0 };

async function createPerson(hr: APIRequestContext, accountId: string, contact?: Record<string, unknown>) {
  const response = await hr.post('/api/hr/people', { data: { accountId, ...(contact ? { contact } : {}) } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json() as { personId: string }).personId;
}

async function engage(hr: APIRequestContext, personId: string, jobTitle: string) {
  const response = await hr.post(`/api/hr/people/${personId}/engagements`, { data: {
    kind: 'employee', startedOn: '2026-01-01', jobTitle, team: 'Employment', workLocation: 'London', pattern,
  } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json() as { engagementId: string }).engagementId;
}

test('shows every staff member the safe People area without granting the HR workspace', async ({ page, request }) => {
  await signedInStaff(page, request, ['fee_earner']);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Active staff directory' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'HR workspace' })).toHaveCount(0);
  await expect(page.getByText('Your own HR record has not been set up yet')).toBeVisible();
  await noAxeViolations(page);
});

test('lets HR create a personnel record, employment evidence and an assigned confidential case', async ({ page, request }) => {
  const worker = await apiSessionFor(request, ['fee_earner']);
  await signedInStaff(page, request, ['hr']);
  await page.goto('/hr');
  await expect(page.getByRole('heading', { name: 'HR workspace' })).toBeVisible();
  await page.getByText('Create a personnel record', { exact: true }).click();
  const create = page.getByRole('form', { name: 'Create personnel record' });
  await create.getByLabel('Active staff account').selectOption(worker.accountId);
  await create.getByRole('button', { name: 'Create personnel record' }).click();
  await page.waitForURL(/\/hr\/people\//);
  await expect(page.getByRole('heading', { name: worker.staff.displayName })).toBeVisible();

  await page.getByText('Create an engagement', { exact: true }).click();
  const engagement = page.getByRole('form', { name: 'Create engagement' });
  await engagement.getByLabel('Started').fill('2026-01-01');
  await engagement.getByLabel('Job title').fill('Employment solicitor');
  await engagement.getByLabel('Team (optional)').fill('Employment');
  await engagement.getByLabel('Work location (optional)').fill('London');
  await engagement.getByRole('button', { name: 'Create engagement' }).click();
  await expect(page.getByText('Employment solicitor').first()).toBeVisible();

  await page.getByRole('link', { name: 'Back to HR workspace' }).click();
  await page.getByText('Open a confidential case', { exact: true }).click();
  const openCase = page.getByRole('form', { name: 'Open confidential HR case' });
  await openCase.getByLabel('Person').selectOption({ label: worker.staff.displayName });
  await openCase.getByLabel('Policy version').fill('Grievance policy 2026.1');
  await openCase.getByLabel('Issue').fill('A confidential workplace concern requiring an assigned and documented investigation.');
  await openCase.getByRole('button', { name: 'Open encrypted case' }).click();
  await page.waitForURL(/\/people\/cases\//);
  await expect(page.getByRole('heading', { name: 'grievance case' })).toBeVisible();
  const event = page.getByRole('form', { name: 'Record case event' });
  await event.getByLabel('Event kind').selectOption('evidence');
  await event.getByLabel('Occurred').fill('2026-10-12');
  await event.getByLabel('Summary').fill('Initial evidence received');
  await event.getByLabel('Details').fill('The evidence was received securely and preserved for the assigned investigator.');
  await event.getByRole('button', { name: 'Record permanent event' }).click();
  await expect(page.getByRole('heading', { name: /evidence/ })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await noAxeViolations(page);
});

test('gives a current manager only the bounded team view and removes it after reassignment', async ({ page, request }) => {
  const hr = await apiSessionFor(request, ['hr']);
  const manager = await apiSessionFor(request, ['partner']);
  const replacement = await apiSessionFor(request, ['partner']);
  const worker = await apiSessionFor(request, ['fee_earner']);
  const workerId = await createPerson(hr.api, worker.accountId, { personalEmail: 'private-worker@example.test', phone: null,
    address: null, emergencyContact: null });
  const managerId = await createPerson(hr.api, manager.accountId); const replacementId = await createPerson(hr.api, replacement.accountId);
  await engage(hr.api, workerId, 'Solicitor'); await engage(hr.api, managerId, 'Partner'); await engage(hr.api, replacementId, 'Partner');
  expect((await hr.api.post(`/api/hr/people/${workerId}/manager`, { data: { managerPersonId: managerId, effectiveOn: '2026-01-02' } })).status()).toBe(201);

  await signIn(page, manager.staff); await page.goto('/people');
  await page.getByRole('link', { name: /My team/ }).click();
  await page.getByRole('link', { name: worker.staff.displayName }).click();
  await expect(page.getByRole('heading', { name: worker.staff.displayName })).toBeVisible();
  await expect(page.getByText('private-worker@example.test')).toHaveCount(0);

  expect((await hr.api.post(`/api/hr/people/${workerId}/manager`, { data: { managerPersonId: replacementId, effectiveOn: '2026-10-12' } })).status()).toBe(201);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

test('provides private self-service at 390 pixels without leaking it into the directory', async ({ page, request }) => {
  const hr = await apiSessionFor(request, ['hr']); const worker = await apiSessionFor(request, ['fee_earner']);
  const workerId = await createPerson(hr.api, worker.accountId, { personalEmail: 'self-private@example.test', phone: '+44 7700 900111',
    address: null, emergencyContact: null });
  await engage(hr.api, workerId, 'Trainee solicitor');
  await signIn(page, worker.staff); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/people');
  await expect(page.getByText('self-private@example.test')).toHaveCount(0);
  await page.getByRole('link', { name: 'My record' }).click();
  await expect(page.getByText('self-private@example.test')).toBeVisible();
  await page.getByText('Request a workplace adjustment', { exact: true }).click();
  const adjustment = page.getByRole('form', { name: 'Request workplace adjustment' });
  await adjustment.getByLabel('Adjustment requested and relevant circumstances').fill('Please review an ergonomic equipment adjustment for my workstation.');
  await adjustment.getByRole('button', { name: 'Send private request' }).click();
  await expect(page.getByText(/ergonomic equipment adjustment/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await noAxeViolations(page);
});
