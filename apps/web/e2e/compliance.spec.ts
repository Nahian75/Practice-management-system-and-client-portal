import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { noAxeViolations, randomName } from './support/checks';
import { apiSessionFor, signedInStaff } from './support/session';
import { openMatter } from './support/matters';

test.describe.configure({ mode: 'serial', timeout: 60_000 });

async function createClient(api: APIRequestContext) {
  const created = await api.post('/api/clients', { data: { kind: 'individual', givenNames: 'Compliance', familyName: randomName() } });
  expect(created.status(), await created.text()).toBe(201);
  return await created.json() as { id: string; reference: string };
}

async function accountId(page: Page) {
  return ((await (await page.request.get('/api/auth/session')).json()) as { account: { id: string } }).account.id;
}

test('lets every staff member send a confidential concern without exposing a Compliance queue', async ({ page, request }) => {
  await signedInStaff(page, request, ['fee_earner']);
  const client = await createClient(page.request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/report-concern');
  await expect(page.getByRole('heading', { name: 'Report a concern' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Compliance/ })).toHaveCount(0);
  const form = page.getByRole('form', { name: 'Confidential internal report' });
  await form.getByLabel('Client').selectOption(client.id);
  await form.getByLabel('Date observed').fill(new Date().toISOString().slice(0, 10));
  await form.getByLabel('Facts observed').fill('I observed an unexpected instruction and recorded only the facts for protected review.');
  await form.getByRole('button', { name: 'Send confidential report' }).click();
  await expect(page.getByRole('status')).toContainText('Report received');
  await expect(page.getByRole('status')).not.toContainText('unexpected instruction');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await noAxeViolations(page);
});

test('gives Compliance an accessible ordinary dashboard and controlled retention workflow', async ({ page, request }) => {
  const creator = await apiSessionFor(request, ['fee_earner']);
  const client = await createClient(creator.api);
  await signedInStaff(page, request, ['compliance']);
  await page.goto('/compliance');
  await expect(page.getByRole('heading', { name: 'Compliance', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Nominated-officer records/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Retention and disposal', exact: true }).click();
  const form = page.getByRole('form', { name: 'Record relationship end and retention' });
  await form.getByLabel('Client').selectOption(client.id);
  await form.getByLabel('Relationship ended').fill('2016-01-01');
  await form.getByLabel('Evidence of relationship end').fill('The signed closure letter was checked against the final closed client file.');
  await form.getByRole('button', { name: 'Record schedule' }).click();
  await page.waitForURL(/\/compliance\/retention\//);
  await expect(page.getByRole('heading', { name: 'Retention schedule' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Permanently dispose of AML records' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await noAxeViolations(page);
});

test('lets Compliance complete a protected CDD case through the staff screens', async ({ page, request }) => {
  const creator = await apiSessionFor(request, ['fee_earner']);
  const client = await createClient(creator.api);
  await signedInStaff(page, request, ['compliance']);
  await page.goto(`/clients/${client.id}/compliance`);
  const start = page.getByRole('form', { name: 'Start CDD case' });
  await start.getByLabel('Intended relationship').fill('Ongoing legal services for the individual client and related transactions.');
  await start.getByLabel('Reason for these checks').fill('Verify identity before accepting instructions and opening regulated work.');
  await start.getByRole('button', { name: 'Start versioned CDD case' }).click();
  await page.getByRole('link', { name: 'Version 1' }).click();

  const subject = page.getByRole('form', { name: 'Add CDD subject' });
  await subject.getByLabel('Full name or registered name').fill('Compliance Test Client');
  await subject.getByLabel('Date of birth (individual)').fill('1980-01-02');
  await subject.getByLabel('Country of residence (two letters)').fill('GB');
  await subject.getByRole('button', { name: 'Add subject' }).click();
  await expect(page.getByText('Compliance Test Client')).toBeVisible();

  const evidence = page.getByRole('form', { name: 'Upload CDD evidence' });
  await evidence.getByLabel('Evidence type').fill('Government passport');
  await evidence.getByLabel('Country (two letters)').fill('GB');
  await evidence.getByLabel('Issued').fill('2020-01-01');
  await evidence.getByLabel('Expires').fill('2030-01-01');
  await evidence.getByLabel('Document identifier').fill('CDD-E2E-001');
  await evidence.getByLabel('File').setInputFiles({ name: 'passport.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF') });
  await evidence.getByRole('button', { name: 'Upload evidence' }).click();
  await expect(page.getByRole('link', { name: 'passport.pdf' })).toBeVisible();

  const verification = page.getByRole('form', { name: 'Record verification' });
  await verification.getByLabel('Independent source').fill('Government-issued passport inspected by the fee earner');
  await verification.getByLabel('Checked').fill(new Date().toISOString().slice(0, 10));
  await verification.getByRole('button', { name: 'Record result' }).click();
  await expect(page.getByRole('heading', { name: 'Verification results' })).toBeVisible();
  await page.getByRole('form', { name: 'Finish CDD case' }).getByRole('button', { name: 'Submit immutable case' }).click();
  await expect(page.getByText(/Status:\s*submitted/)).toBeVisible();
  await noAxeViolations(page);
});

test('opens review work without granting Compliance ordinary matter access', async ({ page, request }) => {
  const partner = await apiSessionFor(request, ['partner']);
  const matter = await openMatter(partner.api, partner.accountId, [], {}, false);
  await signedInStaff(page, request, ['compliance']);
  await page.goto('/compliance');
  await page.getByRole('link', { name: matter.reference }).click();
  await expect(page).toHaveURL(`/matters/${matter.id}/compliance`);
  await expect(page.getByRole('heading', { name: `${matter.reference}: AML assessment` })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Compliance' })).toBeVisible();
  await noAxeViolations(page);
});

test('reveals the protected queue only after a live nominated-officer appointment', async ({ page, request }) => {
  await signedInStaff(page, request, ['compliance']);
  const officerId = await accountId(page);
  const admin = await apiSessionFor(request, ['administrator']);
  expect((await admin.api.post('/api/compliance/officers', { data: { accountId: officerId, kind: 'nominated_officer' } })).status()).toBe(201);
  const reporter = await apiSessionFor(request, ['fee_earner']);
  const client = await createClient(reporter.api);
  const submitted = await reporter.api.post('/api/compliance/restricted-reports', { data: { clientId: client.id,
    matterId: null, financeTransactionId: null, observedOn: new Date().toISOString().slice(0, 10),
    observedFacts: 'Protected browser-test facts for a nominated officer to assess independently.' } });
  expect(submitted.status(), await submitted.text()).toBe(201);

  await page.goto('/compliance');
  await page.getByRole('link', { name: 'Nominated-officer records' }).click();
  await expect(page.getByRole('heading', { name: 'Nominated-officer records' })).toBeVisible();
  await expect(page.getByText('Protected browser-test facts')).toHaveCount(0);
  await page.getByRole('link', { name: (await submitted.json() as { receiptId: string }).receiptId }).click();
  await expect(page.getByRole('heading', { name: 'Facts observed' })).toBeVisible();
  await expect(page.getByText(/Protected browser-test facts/)).toBeVisible();
  await noAxeViolations(page);
});
