import { expect, test, type Page } from '@playwright/test';
import { follow, noAxeViolations } from './support/checks';
import { openMatter } from './support/matters';
import { apiSessionFor, signedInStaff, signIn } from './support/session';

const accountIdOf = async (page: Page) =>
  ((await (await page.request.get('/api/auth/session')).json()) as { account: { id: string } }).account.id;

test('a team member changes the title and type of work', async ({ page, request }) => {
  const partner = await apiSessionFor(request, ['partner']);
  await signedInStaff(page, request);
  const matter = await openMatter(partner.api, partner.accountId, [await accountIdOf(page)]);

  await page.goto(`/matters/${matter.id}`);
  await expect(page.getByRole('link', { name: 'Change the team' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Close the matter' })).toHaveCount(0);
  await follow(page, page.getByRole('link', { name: 'Change details' }));
  await noAxeViolations(page);
  await page.getByLabel('Title').fill('Sale of 3 Mill Lane');
  await page.getByLabel('Type of work').selectOption('Residential property');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.getByRole('heading', { name: 'Sale of 3 Mill Lane' })).toBeVisible();
  await expect(page.getByText('Residential property')).toBeVisible();
});

test('the supervising partner adds and removes a fee earner, then hands over supervision', async ({ page, request }) => {
  test.slow();
  const feeEarner = await apiSessionFor(request);
  const nextPartner = await apiSessionFor(request, ['partner']);
  await signedInStaff(page, request, ['partner']);
  const matter = await openMatter(page.request, await accountIdOf(page));

  await page.goto(`/matters/${matter.id}`);
  await follow(page, page.getByRole('link', { name: 'Change the team' }));
  await noAxeViolations(page);
  await page.getByLabel('Colleague').selectOption(feeEarner.staff.displayName);
  await page.getByRole('button', { name: 'Add to the team' }).click();
  await expect(page.getByRole('row', { name: new RegExp(`^${feeEarner.staff.displayName} Fee earner`) })).toBeVisible();
  expect((await feeEarner.api.get(`/api/matters/${matter.id}`)).status()).toBe(200);

  await page.getByRole('button', { name: `Remove ${feeEarner.staff.displayName}` }).click();
  await expect(page.getByRole('row', { name: new RegExp(`^${feeEarner.staff.displayName}`) })).toHaveCount(0);
  expect((await feeEarner.api.get(`/api/matters/${matter.id}`)).status()).toBe(404);

  await page.getByLabel('Partner').selectOption(nextPartner.staff.displayName);
  await page.getByRole('button', { name: 'Hand over supervision' }).click();

  await expect(page.getByRole('heading', { name: matter.title })).toBeVisible();
  await expect(page.getByRole('row', { name: `${nextPartner.staff.displayName} Supervising partner` })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Change the team' })).toHaveCount(0);
});

test('the supervising partner closes the matter, which is then final', async ({ page, request }) => {
  await signedInStaff(page, request, ['partner']);
  const matter = await openMatter(page.request, await accountIdOf(page));

  await page.goto(`/matters/${matter.id}`);
  await follow(page, page.getByRole('link', { name: 'Close the matter' }));
  await noAxeViolations(page);
  await page.getByRole('button', { name: 'Close the matter' }).click();
  const problem = page.getByRole('alert', { name: 'There is a problem' });
  await expect(problem).toContainText('Give a reason of 10 to 500 characters');
  await expect(problem).toContainText('Confirm that closing cannot be undone');

  await page.getByLabel('Why the matter is closing').fill('Completed: the purchase has gone through');
  await page.getByLabel('I understand a closed matter cannot be reopened or changed').check();
  await page.getByRole('button', { name: 'Close the matter' }).click();

  await expect(page.getByText('This matter is closed.')).toBeVisible();
  await expect(page.getByText(/· Closed$/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Change details' })).toHaveCount(0);
  await page.goto(`/matters/${matter.id}/edit`);
  await expect(page).toHaveURL(new RegExp(`/matters/${matter.id}$`));
});

test('a partner takes over supervision only when the supervising partner can no longer act', async ({ page, request }) => {
  const administrator = await apiSessionFor(request, ['administrator']);
  const leaving = await apiSessionFor(request, ['partner']);
  const matter = await openMatter(leaving.api, leaving.accountId);
  await signedInStaff(page, request, ['partner']);

  await page.goto('/matters');
  await follow(page, page.getByRole('link', { name: 'take over supervision' }));
  await noAxeViolations(page);
  await page.getByLabel('Matter reference').fill(matter.reference.toLowerCase());
  await page.getByLabel('Reason').fill('The supervising partner has left the firm');
  await page.getByRole('button', { name: 'Take over supervision' }).click();
  await expect(page.getByRole('alert', { name: 'There is a problem' })).toContainText('The supervising partner of this matter can still act');

  expect((await administrator.api.delete(`/api/staff/${leaving.accountId}/roles/partner`)).status()).toBe(204);
  await page.getByRole('button', { name: 'Take over supervision' }).click();

  await expect(page.getByRole('status')).toContainText(`You are now the supervising partner of ${matter.reference}`);
  await page.getByRole('link', { name: 'Go to your matters' }).click();
  await page.getByRole('link', { name: matter.title }).click();
  await expect(page.getByRole('link', { name: 'Change the team' })).toBeVisible();
});

test('compliance looks at a matter with a reason, and its supervising partner sees the record', async ({ page, browser, request }) => {
  test.slow();
  const partner = await apiSessionFor(request, ['partner']);
  const matter = await openMatter(partner.api, partner.accountId);
  const lease = Buffer.from('%PDF-1.7\n% signed lease\n%%EOF\n', 'ascii');
  const added = await partner.api.post(`/api/matters/${matter.id}/documents`, {
    multipart: { title: 'Signed lease', category: 'contract', file: { name: 'lease.pdf', mimeType: 'application/pdf', buffer: lease } },
  });
  expect(added.status()).toBe(201);
  await signedInStaff(page, request, ['compliance']);

  await page.goto('/matters');
  await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible();
  await follow(page, page.getByRole('link', { name: 'look at a matter with a reason' }));
  await noAxeViolations(page);
  await page.getByLabel('Matter reference').fill('C-1/1');
  await page.getByLabel('Why you need to see it').fill('Short');
  await page.getByRole('button', { name: 'Show the matter' }).click();
  const problem = page.getByRole('alert', { name: 'There is a problem' });
  await expect(problem).toContainText('Enter the matter reference, such as C-000123/001');
  await expect(problem).toContainText('Give a reason of 10 to 500 characters');

  await page.getByLabel('Matter reference').fill(matter.reference);
  await page.getByLabel('Why you need to see it').fill('Complaint received about this file');
  await page.getByRole('button', { name: 'Show the matter' }).click();
  await expect(page.getByRole('heading', { name: matter.title })).toBeVisible();
  await expect(page.getByText('Read-only. This look has been recorded')).toBeVisible();
  await noAxeViolations(page);
  await page.getByLabel('Document', { exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Download' }).click();
  await expect(page.getByRole('alert', { name: 'There is a problem' })).toContainText('Give a reason of 10 to 500 characters');
  await page.getByLabel('Why you need this document').fill('Checking the signed lease after the complaint');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  expect((await downloading).suggestedFilename()).toBe('lease.pdf');
  await expect(page.getByText('Downloaded “Signed lease”. The download and its reason were recorded.')).toBeVisible();
  await expect(page.getByLabel('Why you need this document')).toHaveValue('');
  await page.reload();
  await expect(page.getByRole('heading', { name: matter.title })).toHaveCount(0);

  const partnerContext = await browser.newContext();
  const partnerPage = await partnerContext.newPage();
  await signIn(partnerPage, partner.staff);
  await partnerPage.goto(`/matters/${matter.id}`);
  await expect(partnerPage.getByRole('row', { name: /Complaint received about this file/ })).toBeVisible();
  await expect(partnerPage.getByRole('row', { name: /Downloaded “Signed lease”, version 1 Checking the signed lease/ })).toBeVisible();
  await partnerContext.close();
});

test('only the supervising partner can change the team or close, even by going to the page directly', async ({ page, request }) => {
  const partner = await apiSessionFor(request, ['partner']);
  await signedInStaff(page, request, ['partner']);
  const matter = await openMatter(partner.api, partner.accountId, [await accountIdOf(page)]);

  await page.goto(`/matters/${matter.id}/team`);
  await expect(page.getByText('Only the matter’s supervising partner can change its team.')).toBeVisible();
  await page.goto(`/matters/${matter.id}/close`);
  await expect(page.getByText('Only the matter’s supervising partner can close it.')).toBeVisible();
});
