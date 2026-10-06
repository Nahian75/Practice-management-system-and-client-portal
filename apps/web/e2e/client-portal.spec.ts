import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { noAxeViolations } from './support/checks';
import { clientSession, clientWithMatter, signInClient } from './support/client';
import { signedInStaff } from './support/session';

const DRAFT = Buffer.from('%PDF-1.7\n% draft\n%%EOF\n', 'ascii');
const FINAL = Buffer.from('%PDF-1.7\n% final advice\n%%EOF\n', 'ascii');

test('sends clients to their portal and keeps staff and client pages separate', async ({ page, request }) => {
  const fixture = await clientWithMatter(request);

  await page.goto('/portal');
  await expect(page).toHaveURL(/\/sign-in$/);
  await signInClient(page, fixture.client);
  await expect(page.getByRole('heading', { name: 'Your matters' })).toBeVisible();
  await expect(page.getByText('Client portal')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Clients', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Staff', exact: true })).toHaveCount(0);
  await page.goto('/');
  await expect(page).toHaveURL(/\/portal$/);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await signedInStaff(page, request);
  await page.goto('/portal');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
});

test('shows safe matter details and only the latest shared document, which downloads exactly', async ({ page, request }) => {
  const fixture = await clientWithMatter(request);
  const added = await fixture.feeEarner.api.post(`/api/matters/${fixture.matter.id}/documents`, {
    multipart: {
      title: 'Advice letter',
      category: 'correspondence',
      file: { name: 'advice-draft.pdf', mimeType: 'application/pdf', buffer: DRAFT },
    },
  });
  expect(added.status()).toBe(201);
  const documentId = ((await added.json()) as { id: string }).id;
  expect(
    (
      await fixture.feeEarner.api.post(`/api/documents/${documentId}/versions`, {
        multipart: { file: { name: 'advice-final.pdf', mimeType: 'application/pdf', buffer: FINAL } },
      })
    ).status(),
  ).toBe(201);
  expect((await fixture.feeEarner.api.put(`/api/documents/${documentId}/client-sharing`)).status()).toBe(204);
  const internal = await fixture.feeEarner.api.post(`/api/matters/${fixture.matter.id}/documents`, {
    multipart: {
      title: 'Internal strategy',
      category: 'other',
      file: { name: 'internal.txt', mimeType: 'text/plain', buffer: Buffer.from('Not for the client') },
    },
  });
  expect(internal.status()).toBe(201);
  await clientSession(page.request, fixture.client);

  await page.goto('/portal');
  const row = page.getByRole('row', { name: new RegExp(fixture.matter.reference) });
  await expect(row).toContainText(fixture.matter.title);
  await expect(row).toContainText('Litigation');
  await expect(row).toContainText('Open');
  await expect(row).toContainText(fixture.partner.staff.displayName);
  await expect(row).toContainText(fixture.feeEarner.staff.displayName);
  await noAxeViolations(page);

  await row.getByRole('link', { name: fixture.matter.title }).click();
  await expect(page.getByRole('heading', { name: fixture.matter.title })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();
  const documentRow = page.getByRole('row', { name: /Advice letter/ });
  await expect(documentRow).toContainText('advice-final.pdf');
  await expect(documentRow).not.toContainText('advice-draft.pdf');
  await expect(page.getByText('Internal strategy')).toHaveCount(0);
  await expect(page.getByText('Conflict check')).toHaveCount(0);
  await expect(page.getByText('Other parties')).toHaveCount(0);
  await noAxeViolations(page);

  const downloading = page.waitForEvent('download');
  await documentRow.getByRole('link', { name: 'Download Advice letter' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('advice-final.pdf');
  expect(await readFile(await download.path())).toEqual(FINAL);
});

test('removes the matter and document screens as soon as portal access ends', async ({ page, request }) => {
  const fixture = await clientWithMatter(request);
  const added = await fixture.feeEarner.api.post(`/api/matters/${fixture.matter.id}/documents`, {
    multipart: {
      title: 'Shared advice',
      category: 'correspondence',
      file: { name: 'advice.pdf', mimeType: 'application/pdf', buffer: FINAL },
    },
  });
  const documentId = ((await added.json()) as { id: string }).id;
  expect((await fixture.feeEarner.api.put(`/api/documents/${documentId}/client-sharing`)).status()).toBe(204);
  await clientSession(page.request, fixture.client);
  await page.goto(`/portal/matters/${fixture.matter.id}`);
  await expect(page.getByRole('row', { name: /Shared advice/ })).toBeVisible();

  expect((await fixture.feeEarner.api.delete(`/api/clients/${fixture.clientId}/portal-access/${fixture.linkId}`)).status()).toBe(204);
  await page.reload();

  await expect(page.getByRole('heading', { name: 'You cannot see this matter' })).toBeVisible();
  await expect(page.getByText('Shared advice')).toHaveCount(0);
  await page.goto('/portal');
  await expect(page.getByText('You have no matters to view.')).toBeVisible();
});
