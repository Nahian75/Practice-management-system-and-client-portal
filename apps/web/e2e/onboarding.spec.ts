import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { noAxeViolations, randomName } from './support/checks';
import { clientWithMatter, signInClient } from './support/client';
import { isoDay } from './support/compliance';
import { apiSessionFor, signIn, signedInStaff } from './support/session';
import { emailedToken } from './support/staff';

test.describe.configure({ mode: 'serial', timeout: 60_000 });

test('publishes, approves and acknowledges an exact firm policy version', async ({ page, request }) => {
  const compliance = await signedInStaff(page, request, ['compliance']);
  await page.goto('/policies');
  await expect(page.getByRole('heading', { name: 'Firm policies' })).toBeVisible();
  const form = page.getByRole('form', { name: 'Prepare policy version' });
  const title = `Client care ${randomName()}`;
  await form.getByLabel('Category').selectOption('client_care_policy');
  await form.getByLabel('Title').fill(title);
  await form.getByLabel('Owner').selectOption({ label: compliance.displayName });
  await form.getByLabel('Approved policy text').fill('This tailored client-care policy records the firm process, responsibilities and evidence requirements.');
  await form.getByLabel('Source and tailoring evidence').fill('Approved firm process and current SRA requirements');
  const today = new Date().toISOString().slice(0, 10);
  await form.getByLabel('Effective from').fill(today);
  await form.getByLabel('Review due').fill('2099-12-31');
  await form.getByLabel('Require staff acknowledgement').check();
  await form.getByRole('button', { name: 'Prepare immutable version' }).click();
  await expect(form.getByLabel('Title')).toHaveValue('');

  const partner = await apiSessionFor(request, ['partner']);
  const pending = await partner.api.get('/api/compliance/controls/pending-approval');
  expect(pending.status()).toBe(200);
  const { controls } = (await pending.json()) as { controls: { id: string; title: string }[] };
  const policy = controls.find((item) => item.title === title);
  expect(policy).toBeDefined();

  const approved = await partner.api.post(`/api/compliance/controls/${policy!.id}/approval`, { data: {} });
  expect(approved.status(), await approved.text()).toBe(201);

  await signedInStaff(page, request, ['fee_earner']);
  await page.goto('/policies');
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByRole('button', { name: 'Acknowledge this version' }).click();
  await expect(page.getByText(/Acknowledged/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await noAxeViolations(page);
});

test('verifies the email channel from a one-time public link without claiming identity', async ({ page, request }) => {
  await signedInStaff(page, request, ['fee_earner']);
  const email = `onboarding-${randomUUID()}@example.com`;
  const created = await page.request.post('/api/clients', { data: { kind: 'individual',
    givenNames: 'Contact', familyName: randomName(), email } });
  expect(created.status(), await created.text()).toBe(201);
  const client = await created.json() as { id: string };
  await page.goto(`/clients/${client.id}`);
  await page.getByRole('button', { name: /Send verification link/ }).click();
  await expect(page.getByRole('region', { name: 'Contact verification' }).getByRole('status')).toContainText('one-time link was queued');
  const token = await emailedToken(email, '/verify-contact');

  await page.goto(`/verify-contact#token=${token}`);
  await expect(page).not.toHaveURL(/#token=/);
  await expect(page.getByText('Email address verified.')).toBeVisible();
  await expect(page.getByText(/does not verify identity/)).toBeVisible();
  await noAxeViolations(page);

  await page.goto(`/clients/${client.id}`);
  await expect(page.getByRole('cell', { name: 'Email verified' })).toBeVisible();
});

test('requests client evidence, client uploads via portal, and staff reviews submission', async ({ page, request }) => {
  const setup = await clientWithMatter(request);
  const { client, clientId, feeEarner } = setup;

  const cddCreated = await feeEarner.api.post(`/api/clients/${clientId}/cdd`, {
    data: { intendedRelationship: 'Legal representation', reason: 'New client onboarding verification' },
  });
  expect(cddCreated.status(), await cddCreated.text()).toBe(201);
  const cddCase = (await cddCreated.json()) as { id: string };

  await signIn(page, feeEarner.staff);
  await page.goto(`/clients/${clientId}/compliance/${cddCase.id}`);
  await expect(page.getByRole('heading', { name: /CDD case/ })).toBeVisible();

  const reqForm = page.getByRole('form', { name: 'Request evidence from client' });
  await reqForm.getByLabel('Evidence type').fill('Proof of address');
  await reqForm.getByLabel('Instructions').fill('Please upload a utility bill or bank statement dated within the last 3 months.');
  const due = isoDay(14);
  await reqForm.getByLabel('Due date').fill(due);
  await reqForm.getByRole('button', { name: 'Send portal evidence request' }).click();

  await expect(page.getByRole('cell', { name: 'Proof of address' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Awaiting client upload' })).toBeVisible();

  await signInClient(page, client);

  await expect(page.getByRole('heading', { name: 'Requested evidence' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Proof of address' })).toBeVisible();

  const uploadForm = page.getByRole('form', { name: 'Upload Proof of address' });
  const samplePdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');
  await uploadForm.getByLabel(/Choose Proof of address file/).setInputFiles({
    name: 'utility-bill.pdf',
    mimeType: 'application/pdf',
    buffer: samplePdf,
  });
  await uploadForm.getByRole('button', { name: 'Upload Proof of address' }).click();

  await expect(page.getByRole('status')).toContainText('Uploaded utility-bill.pdf successfully.');
  await expect(page.getByText(/Submitted/)).toBeVisible();
  await noAxeViolations(page);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await signIn(page, feeEarner.staff);
  await page.goto(`/clients/${clientId}/compliance/${cddCase.id}`);
  await expect(page.getByRole('cell', { name: /Submitted/ })).toBeVisible();
});
