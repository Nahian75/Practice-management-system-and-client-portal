import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { follow, noAxeViolations, watchForCspViolations } from './support/checks';
import { eicarTestFile } from './support/eicar';
import { openMatter } from './support/matters';
import { apiSessionFor, signedInStaff } from './support/session';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'ascii');

/** A fee earner signed in on `page`, on the team of a new open matter, on its page. */
async function onNewMatter(page: Page, request: Parameters<typeof signedInStaff>[1]) {
  const partner = await apiSessionFor(request, ['partner']);
  await signedInStaff(page, request);
  const matter = await openMatter(page.request, partner.accountId);
  await page.goto(`/matters/${matter.id}`);
  return { matter, partner };
}

async function addDocument(page: Page, title: string, file: { name: string; buffer: Buffer; mimeType?: string }) {
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('File').setInputFiles({ mimeType: 'application/octet-stream', ...file });
  await page.getByRole('button', { name: 'Add document' }).click();
}

test('adds a document to a matter and downloads exactly what was added', async ({ page, request }) => {
  const violations = await watchForCspViolations(page);
  await onNewMatter(page, request);
  await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();
  await noAxeViolations(page);

  await page.getByLabel('Category').selectOption('Contract');
  await addDocument(page, 'Signed lease', { name: 'lease.pdf', buffer: PDF });

  await expect(page.getByRole('status')).toContainText('Added “Signed lease”.');
  const row = page.getByRole('row', { name: /Signed lease/ });
  await expect(row).toContainText('Contract');
  await expect(row).toContainText('lease.pdf (version 1, 1 KB)');
  const downloading = page.waitForEvent('download');
  await row.getByRole('link', { name: 'Download Signed lease' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('lease.pdf');
  expect(await readFile(await download.path())).toEqual(PDF);
  await page.reload();
  await noAxeViolations(page);
  expect(violations).toEqual([]);
});

test("shows the API's reason for a refused file, and stores nothing", async ({ page, request }) => {
  test.slow();
  await onNewMatter(page, request);
  const problem = page.getByRole('alert', { name: 'There is a problem' });

  await addDocument(page, 'Not really a PDF', { name: 'lease.pdf', buffer: Buffer.from('<html><script>alert(1)</script></html>') });
  await expect(problem).toContainText('its content does not match its name');

  await addDocument(page, 'Invoice', { name: 'invoice.txt', buffer: eicarTestFile() });
  await expect(problem).toContainText('contains malware and was not stored');

  // Playwright takes files over 50 MB only from disk.
  const huge = test.info().outputPath('scan.pdf');
  await writeFile(huge, Buffer.alloc(50 * 1024 * 1024 + 1, 0x61));
  await page.getByLabel('Title', { exact: true }).fill('Huge scan');
  await page.getByLabel('File').setInputFiles(huge);
  await page.getByRole('button', { name: 'Add document' }).click();
  await expect(problem).toContainText('The file is over 50 MB');

  await page.reload();
  await expect(page.getByText('No documents yet.')).toBeVisible();
});

test('passes a file larger than the usual 10 MB request limit through to the API whole', async ({ page, request }) => {
  test.slow();
  await onNewMatter(page, request);
  const large = Buffer.alloc(11 * 1024 * 1024, 0x61);

  await addDocument(page, 'Long transcript', { name: 'transcript.txt', buffer: large });

  await expect(page.getByRole('row', { name: /Long transcript/ })).toContainText('transcript.txt (version 1, 11 MB)');
});

test('adds a new version, then withdraws the document: kept, but no longer listed or downloaded', async ({ page, request }) => {
  const { matter } = await onNewMatter(page, request);
  await addDocument(page, 'Draft lease', { name: 'lease-draft.pdf', buffer: PDF });
  await follow(page, page.getByRole('link', { name: 'Draft lease', exact: true }));
  await noAxeViolations(page);

  await page.getByLabel('File').setInputFiles({ name: 'lease-final.pdf', mimeType: 'application/pdf', buffer: PDF });
  await page.getByRole('button', { name: 'Add version' }).click();
  await expect(page.getByRole('row', { name: /^2 lease-final\.pdf/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /^1 lease-draft\.pdf/ })).toBeVisible();

  await page.getByRole('button', { name: 'Withdraw the document' }).click();
  await expect(page.getByRole('alert', { name: 'There is a problem' })).toContainText('Confirm that withdrawing cannot be undone');
  await page.getByLabel('Why it is being withdrawn').fill('Uploaded to the wrong matter by mistake');
  await page.getByLabel('I understand withdrawing cannot be undone').check();
  await page.getByRole('button', { name: 'Withdraw the document' }).click();

  await expect(page.getByText('Reason: Uploaded to the wrong matter by mistake')).toBeVisible();
  await expect(page.getByRole('link', { name: /Download/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add version' })).toHaveCount(0);
  await noAxeViolations(page);

  await page.goto(`/matters/${matter.id}`);
  await expect(page.getByText('No documents yet.')).toBeVisible();
});

test('only whoever added a document, or the supervising partner, is offered withdrawal', async ({ page, request }) => {
  const colleague = await apiSessionFor(request);
  const partner = await apiSessionFor(request, ['partner']);
  const matter = await openMatter(colleague.api, partner.accountId);
  const added = await colleague.api.post(`/api/matters/${matter.id}/documents`, {
    multipart: { title: 'Their letter', category: 'correspondence', file: { name: 'letter.txt', mimeType: 'text/plain', buffer: Buffer.from('Dear client') } },
  });
  expect(added.status()).toBe(201);
  await signedInStaff(page, request);
  const { account } = (await (await page.request.get('/api/auth/session')).json()) as { account: { id: string } };
  expect((await partner.api.put(`/api/matters/${matter.id}/team/${account.id}`)).status()).toBe(204);

  await page.goto(`/documents/${((await added.json()) as { id: string }).id}`);

  await expect(page.getByRole('button', { name: 'Add version' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Withdraw the document' })).toHaveCount(0);
});
