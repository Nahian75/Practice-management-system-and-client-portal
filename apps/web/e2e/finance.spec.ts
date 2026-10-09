import { expect, test, type Page } from '@playwright/test';
import { noAxeViolations, unique } from './support/checks';
import { openMatter } from './support/matters';
import { apiSessionFor, signedInStaff } from './support/session';

const accountIdOf = async (page: Page) =>
  ((await (await page.request.get('/api/auth/session')).json()) as { account: { id: string } }).account.id;

const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

test.describe.configure({ mode: 'serial', timeout: 60_000 });

test('records time on a visible matter and keeps firm-wide Finance out of ordinary navigation', async ({ page, request }) => {
  const accounts = await apiSessionFor(request, ['accounts']);
  await signedInStaff(page, request, ['partner']);
  const partnerId = await accountIdOf(page);
  expect((await accounts.api.post('/api/finance/rates', { data: { accountId: partnerId, hourlyRate: '275.00', effectiveFrom: today() } })).status()).toBe(201);
  const matter = await openMatter(page.request, partnerId);

  await page.goto(`/matters/${matter.id}`);
  await expect(page.getByRole('heading', { name: 'Time and finance' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Finance' })).toHaveCount(0);
  const form = page.getByRole('form', { name: 'Record time' });
  const [year, month, day] = today().split('-');
  await form.getByLabel('Day').fill(String(Number(day)));
  await form.getByLabel('Month').fill(String(Number(month)));
  await form.getByLabel('Year').fill(year!);
  await form.getByLabel('Minutes').fill('75');
  await form.getByLabel('Work description').fill('Reviewed transaction papers and advised the client.');
  await form.getByRole('button', { name: 'Record time' }).click();
  await expect(form.getByRole('status')).toContainText('Time recorded.');
  const row = page.getByRole('row', { name: /75.*£275\.00.*Current/ });
  await expect(row).toBeVisible();
  await noAxeViolations(page);
  await row.getByRole('link').click();
  const correction = page.getByRole('form', { name: 'Correct this time entry' });
  await correction.getByLabel('Correct minutes').fill('90');
  await correction.getByLabel('Reason for correction').fill('Corrected after reviewing the attendance note.');
  await correction.getByRole('button', { name: 'Record permanent correction' }).click();
  await expect(page.getByRole('heading', { name: /90 minutes/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Corrected after reviewing.*90 minutes/ })).toBeVisible();
  await noAxeViolations(page);
});

test('gives Accounts operational queues, cash books, exports and responsive accessible forms', async ({ page, request }) => {
  const partner = await apiSessionFor(request, ['partner']);
  await signedInStaff(page, request, ['accounts']);
  const fixtureDate = yesterday();
  const matter = await openMatter(partner.api, partner.accountId, [], { address: { line1: '22 Client Road', line2: null, town: 'London', postcode: 'SW1A 2AA', country: 'GB' } });
  const bankName = `Business account ${unique()}`;
  const bank = await page.request.post('/api/finance/bank-accounts', { data: { kind: 'business', name: bankName, sortCode: '12-34-56', accountNumber: `1${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`, openedOn: fixtureDate } });
  expect(bank.status()).toBe(201);
  const bankBody = await bank.json() as { id: string };
  expect((await page.request.post('/api/finance/receipts', { data: { bankAccountId: bankBody.id, matterId: matter.id, receivedOn: fixtureDate, amount: '250.00', reference: `E2E-${unique()}`, purpose: 'Funds on account' } })).status()).toBe(201);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/finance');
  await expect(page.getByRole('heading', { name: 'Finance', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Draft bills' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Add bank account' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Record bank-confirmed receipt' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Request client-account payment' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Import bank statement' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Prepare client-account reconciliation' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByRole('link', { name: new RegExp(bankName) }).first().click();
  await expect(page.getByRole('heading', { name: bankName })).toBeVisible();
  await expect(page.getByText('£250.00', { exact: true })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Export cash book (CSV)' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^cash-book-.*\.csv$/);
  await noAxeViolations(page);
  expect((await page.request.post(`/api/finance/bank-accounts/${bankBody.id}/close`, { data: { closedOn: fixtureDate, reason: 'End of browser test' } })).status()).toBe(201);
});

test('builds, issues, delivers and credits a bill through the Accounts workspace', async ({ page, request }) => {
  const partner = await apiSessionFor(request, ['partner']);
  await signedInStaff(page, request, ['accounts']);
  const matter = await openMatter(partner.api, partner.accountId, [], { address: { line1: '22 Client Road', line2: null, town: 'London', postcode: 'SW1A 2AA', country: 'GB' } });
  await page.goto(`/finance/matters/${matter.id}`);
  const draft = page.getByRole('form', { name: 'Start a draft bill' });
  await draft.getByLabel('Tax point').fill(today());
  await draft.getByLabel('Payment due').fill(today());
  await draft.getByLabel('Firm name').fill('Stass Legal LLP');
  await draft.getByLabel('Address line 1').fill('1 Justice Street');
  await draft.getByLabel('Town or city').fill('London');
  await draft.getByLabel('Postcode (optional)').fill('SW1A 1AA');
  await draft.getByLabel('VAT registration number (when taxable)').fill('GB123456789');
  await draft.getByLabel('Description').fill('Professional services');
  await draft.getByLabel('Net amount in GBP').fill('100.00');
  await draft.getByRole('button', { name: 'Save draft' }).click();
  await page.waitForURL(/\/finance\/bill-drafts\//);
  await expect(page.getByText('£120.00', { exact: true })).toBeVisible();
  await noAxeViolations(page);
  await page.getByRole('button', { name: 'Issue fixed bill' }).click();
  await page.waitForURL(new RegExp(`/finance/matters/${matter.id}`));
  const billLink = page.getByRole('link', { name: /^INV-/ }).first();
  await expect(billLink).toBeVisible();
  await billLink.click();
  await expect(page.getByRole('heading', { name: /^INV-/ })).toBeVisible();
  await noAxeViolations(page);
  const delivery = page.getByRole('form', { name: 'Record delivery' });
  await delivery.getByLabel('Method').selectOption('email');
  await delivery.getByLabel('Note (optional)').fill('Sent through the approved firm mailbox.');
  await delivery.getByRole('button', { name: 'Record delivery' }).click();
  await expect(delivery.getByRole('status')).toContainText('Delivery recorded');
  const credit = page.getByRole('form', { name: 'Issue a credit note' });
  await credit.getByLabel('Reason').fill('Agreed fee reduction');
  await credit.getByLabel('Net credit for Professional services').fill('25.00');
  await credit.getByRole('button', { name: 'Issue credit note' }).click();
  await page.waitForURL(/\/finance\/credit-notes\//);
  await expect(page.getByRole('heading', { name: /^CRN-/ })).toBeVisible();
  await expect(page.getByText('Agreed fee reduction')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download fixed credit note' })).toBeVisible();
  await noAxeViolations(page);
});

test('uses two Accounts holders for a payment request and records the bank outcome', async ({ page, request }) => {
  const partner = await apiSessionFor(request, ['partner']);
  const requester = await apiSessionFor(request, ['accounts']);
  await signedInStaff(page, request, ['accounts']);
  const fixtureDate = yesterday();
  const matter = await openMatter(partner.api, partner.accountId);
  const evidence = await partner.api.post(`/api/matters/${matter.id}/documents`, { multipart: { title: 'Payment authority', category: 'correspondence', file: { name: 'authority.txt', mimeType: 'text/plain', buffer: Buffer.from('Authority for the client payment') } } });
  expect(evidence.status()).toBe(201);
  const bank = await requester.api.post('/api/finance/bank-accounts', { data: { kind: 'client', name: `Payment account ${unique()}`, sortCode: '12-34-56', accountNumber: `2${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`, openedOn: fixtureDate } });
  expect(bank.status()).toBe(201); const bankBody = await bank.json() as { id: string };
  expect((await requester.api.post('/api/finance/receipts', { data: { bankAccountId: bankBody.id, matterId: matter.id, receivedOn: fixtureDate, amount: '200.00', reference: `PAY-${unique()}`, purpose: 'Funds on account' } })).status()).toBe(201);
  const requested = await requester.api.post('/api/finance/payment-requests', { data: { kind: 'refund', matterId: matter.id, clientBankAccountId: bankBody.id, evidenceDocumentId: (await evidence.json() as { id: string }).id, purpose: 'Return surplus funds to the client', amount: '200.00', payee: { name: 'Alex Client', sortCode: '65-43-21', accountNumber: '87654321' } } });
  expect(requested.status()).toBe(201); const payment = await requested.json() as { id: string };
  await page.goto(`/finance/payment-requests/${payment.id}`);
  await expect(page.getByText('Pending approval')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Approved, awaiting bank outcome')).toBeVisible();
  await page.getByRole('button', { name: 'Show payee bank details' }).click();
  await expect(page.getByText(/Payee: Alex Client/)).toBeVisible();
  await page.getByLabel('Bank reference').fill(`BANK-${unique()}`);
  await page.getByLabel('Date paid').fill(fixtureDate);
  await page.getByRole('button', { name: 'Record paid' }).click();
  await expect(page.getByText('Paid', { exact: true })).toBeVisible();
  await noAxeViolations(page);
  expect((await requester.api.post(`/api/finance/bank-accounts/${bankBody.id}/close`, { data: { closedOn: fixtureDate, reason: 'End of browser test' } })).status()).toBe(201);
});

test('shows immutable statement matching and gives reconciliation sign-off only to Compliance', async ({ page, request }) => {
  const partner = await apiSessionFor(request, ['partner']);
  const accounts = await apiSessionFor(request, ['accounts']);
  await signedInStaff(page, request, ['compliance']);
  const matter = await openMatter(partner.api, partner.accountId);
  const reference = `REC-${unique()}`;
  const bank = await accounts.api.post('/api/finance/bank-accounts', { data: { kind: 'client', name: `Reconciliation account ${unique()}`, sortCode: '12-34-56', accountNumber: `3${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`, openedOn: today() } });
  expect(bank.status()).toBe(201); const bankBody = await bank.json() as { id: string };
  const receipt = await accounts.api.post('/api/finance/receipts', { data: { bankAccountId: bankBody.id, matterId: matter.id, receivedOn: today(), amount: '100.00', reference, purpose: 'Funds on account' } });
  expect(receipt.status()).toBe(201);
  const statement = await accounts.api.post('/api/finance/statement-imports', { multipart: { bankAccountId: bankBody.id, periodStart: today(), periodEnd: today(), openingBalance: '0.00', closingBalance: '100.00', file: { name: 'statement.csv', mimeType: 'text/csv', buffer: Buffer.from(`date,amount,reference,description\r\n${today()},100.00,${reference},Client receipt\r\n`) } } });
  expect(statement.status()).toBe(201); const statementBody = await statement.json() as { id: string; rows: { id: string }[] };
  expect((await accounts.api.post(`/api/finance/statement-rows/${statementBody.rows[0]!.id}/matches`, { data: { financeTransactionId: (await receipt.json() as { id: string }).id } })).status()).toBe(201);
  const reconciliation = await accounts.api.post('/api/finance/reconciliations', { data: { asOf: today(), statementImportIds: [statementBody.id], explanations: {} } });
  expect(reconciliation.status()).toBe(201); const reconciliationBody = await reconciliation.json() as { id: string };
  await page.goto(`/finance/statements/${statementBody.id}`);
  await expect(page.getByText('Compliance view: matching is read-only.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reverse match' })).toHaveCount(0);
  await noAxeViolations(page);
  await page.goto(`/finance/reconciliations/${reconciliationBody.id}`);
  await expect(page.getByText('Awaiting sign-off', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign off reconciliation' }).click();
  await expect(page.getByText('Awaiting sign-off', { exact: true })).toHaveCount(0);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export reconciliation (CSV)' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^client-account-reconciliation-.*\.csv$/);
  await noAxeViolations(page);
  expect((await accounts.api.post(`/api/finance/bank-accounts/${bankBody.id}/close`, { data: { closedOn: today(), reason: 'End of browser test' } })).status()).toBe(201);
});

test('keeps Compliance finance read-only apart from reconciliation sign-off', async ({ page, request }) => {
  await signedInStaff(page, request, ['compliance']);
  await page.goto('/finance');
  await expect(page.getByRole('heading', { name: 'Finance', exact: true })).toBeVisible();
  await expect(page.getByText('Compliance access is read-only except for reconciliation sign-off.')).toBeVisible();
  await expect(page.getByRole('form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Record|Approve|Import|Prepare|Add bank/i })).toHaveCount(0);
  await noAxeViolations(page);
});

test('denies firm-wide Finance to a fee earner without leaking its queues', async ({ page, request }) => {
  await signedInStaff(page, request, ['fee_earner']);
  await page.goto('/finance');
  await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Finance' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Client-money payment requests' })).toHaveCount(0);
  await noAxeViolations(page);
});
