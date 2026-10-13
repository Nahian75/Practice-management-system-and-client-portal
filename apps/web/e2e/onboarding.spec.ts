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
  await expect(page.getByRole('cell', { name: 'Awaiting review' })).toBeVisible();

  const reviewForm = page.getByRole('form', { name: 'Review client evidence submission' });
  await reviewForm.getByLabel('Review decision').selectOption('accepted');
  await reviewForm.getByLabel('Review reason and findings').fill('Utility bill dated within 2 months with matching address');
  await reviewForm.getByRole('button', { name: 'Record review decision' }).click();

  await expect(page.getByRole('cell', { name: /Accepted: Utility bill dated within 2 months/ })).toBeVisible();
  await noAxeViolations(page);
});

test('records electronic verification checks and displays company verification status', async ({ page, request }) => {
  await signedInStaff(page, request, ['fee_earner']);
  const companyNumber = '09876543';
  const orgCreated = await page.request.post('/api/clients', {
    data: {
      kind: 'organisation',
      legalName: 'Apex Advisory Group Ltd',
      organisationType: 'company',
      registrationNumber: companyNumber,
    },
  });
  expect(orgCreated.status()).toBe(201);
  const org = (await orgCreated.json()) as { id: string };

  await page.goto(`/clients/${org.id}`);
  await expect(page.getByRole('heading', { name: 'Company verification' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Electronic verification checks' })).toBeVisible();

  // Record an electronic verification check
  await page.getByRole('button', { name: 'Record electronic check' }).click();
  const checkForm = page.getByRole('form', { name: 'Record electronic verification check' });
  await checkForm.getByLabel('Provider', { exact: true }).fill('Credas IDV');
  await checkForm.getByLabel('Service').fill('NFC biometric passport check');
  await checkForm.getByLabel('Provider reference').fill('CRD-88224');
  await checkForm.getByLabel('Document type').fill('Passport');
  await checkForm.getByLabel('Check date').fill('2026-10-01');
  await checkForm.getByLabel('Overall result').selectOption('pass');
  await checkForm.getByLabel('Liveness result').selectOption('pass');
  await checkForm.getByLabel('Evidence match notes').fill('Chip and photo verified');
  await checkForm.getByRole('button', { name: 'Save electronic check' }).click();

  await expect(page.getByRole('cell', { name: 'Credas IDV (NFC biometric passport check)' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'CRD-88224' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'PASS', exact: true })).toBeVisible();

  await noAxeViolations(page);
});

