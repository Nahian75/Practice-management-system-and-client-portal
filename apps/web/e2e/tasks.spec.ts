import { expect, test, type Page } from './support/test';
import { follow, noAxeViolations } from './support/checks';
import { openMatter } from './support/matters';
import { apiSessionFor, signedInStaff } from './support/session';

const accountIdOf = async (page: Page) =>
  ((await (await page.request.get('/api/auth/session')).json()) as { account: { id: string } }).account.id;

async function createTask(
  api: Parameters<typeof openMatter>[0],
  matterId: string,
  assigneeId: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await api.post(`/api/matters/${matterId}/tasks`, {
    data: {
      title: 'Review draft contract',
      description: 'Check the termination provisions.',
      dueOn: '2027-02-12',
      priority: 'high',
      assigneeId,
      ...overrides,
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: string };
}

test('creates a task on the matter, lists it, and opens its details', async ({ page, request }) => {
  const partner = await apiSessionFor(request, ['partner']);
  const feeEarner = await signedInStaff(page, request);
  const accountId = await accountIdOf(page);
  const matter = await openMatter(page.request, partner.accountId, [accountId]);

  await page.goto(`/matters/${matter.id}`);
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  await expect(page.getByText('No tasks yet.')).toBeVisible();
  await noAxeViolations(page);

  const form = page.getByRole('form', { name: 'Add a task' });
  await form.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByRole('alert', { name: 'There is a problem' })).toContainText('Enter a title for the task');

  await form.getByLabel('Task title').fill('Prepare completion statement');
  await form.getByLabel('Description (optional)').fill('Check the agreed figures with the client.');
  await form.getByLabel('Day').fill('31');
  await form.getByLabel('Month').fill('2');
  await form.getByLabel('Year').fill('2027');
  await form.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByRole('alert', { name: 'There is a problem' })).toContainText('Check the task details');

  await form.getByLabel('Day').fill('15');
  await form.getByLabel('Month').fill('2');
  await form.getByLabel('Year').fill('2027');
  await form.getByLabel('Priority').selectOption('Urgent');
  await form.getByLabel('Assignee').selectOption(feeEarner.displayName);
  await form.getByRole('button', { name: 'Add task' }).click();

  await expect(form.getByRole('status')).toContainText('Added “Prepare completion statement”.');
  const row = page.getByRole('row', { name: /Prepare completion statement/ });
  await expect(row).toContainText('Urgent');
  await expect(row).toContainText('15 February 2027');
  await expect(row).toContainText(feeEarner.displayName);
  await expect(row).toContainText('Open');
  await follow(page, row.getByRole('link', { name: 'Prepare completion statement' }));

  await expect(page.getByRole('heading', { name: 'Prepare completion statement' })).toBeVisible();
  await expect(page.getByRole('definition').filter({ hasText: /^Check the agreed figures with the client\.$/ })).toBeVisible();
  await expect(page.getByText('No changes yet.')).toBeVisible();
  await noAxeViolations(page);
});

test('edits, reassigns, completes, reopens and cancels with visible history', async ({ page, request }) => {
  const assignee = await apiSessionFor(request);
  const partner = await signedInStaff(page, request, ['partner']);
  const partnerId = await accountIdOf(page);
  const matter = await openMatter(page.request, partnerId, [assignee.accountId]);
  const task = await createTask(page.request, matter.id, assignee.accountId);

  await page.goto(`/tasks/${task.id}`);
  const details = page.getByRole('form', { name: 'Change task details' });
  await details.getByLabel('Title').fill('');
  await details.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert', { name: 'There is a problem' })).toContainText('Enter a title for the task');
  await details.getByLabel('Title').fill('Review final contract');
  await details.getByLabel('Description (optional)').fill('Check the signed version.');
  await details.getByLabel('Priority').selectOption('Urgent');
  await details.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toContainText('Task details changed.');
  await expect(page.getByRole('heading', { name: 'Review final contract' })).toBeVisible();

  const assignment = page.getByRole('form', { name: 'Reassign task' });
  await assignment.getByLabel('Assignee').selectOption(partner.displayName);
  await assignment.getByRole('button', { name: 'Reassign' }).click();
  await expect(page.getByRole('status')).toContainText(`Assigned to ${partner.displayName}.`);

  await page.getByRole('button', { name: 'Complete task' }).click();
  await expect(page.getByRole('definition').filter({ hasText: /^Completed$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Reopen task' }).click();
  await expect(page.getByRole('definition').filter({ hasText: /^Open$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel task' }).click();
  await expect(page.getByRole('definition').filter({ hasText: /^Cancelled$/ })).toBeVisible();

  await expect(page.getByRole('row', { name: /Details.*Review draft contract.*Review final contract/ })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(`Assignee.*${assignee.staff.displayName}.*${partner.displayName}`) })).toBeVisible();
  await expect(page.getByRole('row', { name: /Status.*Open.*Completed/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Status.*Completed.*Open/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Status.*Open.*Cancelled/ })).toBeVisible();
  await noAxeViolations(page);
});

test('hides status actions from another team member and hides an outsider task', async ({ page, request }) => {
  const partner = await apiSessionFor(request, ['partner']);
  const assignee = await apiSessionFor(request);
  await signedInStaff(page, request);
  const accountId = await accountIdOf(page);
  const matter = await openMatter(partner.api, partner.accountId, [assignee.accountId, accountId]);
  const task = await createTask(partner.api, matter.id, assignee.accountId);

  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByRole('form', { name: 'Change task details' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Reassign task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete task' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel task' })).toHaveCount(0);

  const privateMatter = await openMatter(partner.api, partner.accountId);
  const privateTask = await createTask(partner.api, privateMatter.id, partner.accountId, { title: 'Private task' });
  await page.goto(`/tasks/${privateTask.id}`);
  await expect(page.getByRole('heading', { name: 'You cannot see this task' })).toBeVisible();
  await expect(page.getByText('Private task')).toHaveCount(0);
});

test('removes supervisor status actions when the supervisor loses the partner role', async ({ page, request }) => {
  const administrator = await apiSessionFor(request, ['administrator']);
  const assignee = await apiSessionFor(request);
  await signedInStaff(page, request, ['partner', 'fee_earner']);
  const formerPartnerId = await accountIdOf(page);
  const matter = await openMatter(page.request, formerPartnerId, [assignee.accountId]);
  const task = await createTask(page.request, matter.id, assignee.accountId);

  expect((await administrator.api.delete(`/api/staff/${formerPartnerId}/roles/partner`)).status()).toBe(204);
  await page.goto(`/tasks/${task.id}`);

  await expect(page.getByRole('form', { name: 'Change task details' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete task' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel task' })).toHaveCount(0);
  await noAxeViolations(page);
});

test('explains open-task closure refusal and makes closed tasks read-only', async ({ page, request }) => {
  await signedInStaff(page, request, ['partner']);
  const accountId = await accountIdOf(page);
  const matter = await openMatter(page.request, accountId);
  const task = await createTask(page.request, matter.id, accountId, { title: 'Send final report' });

  await page.goto(`/matters/${matter.id}/close`);
  await page.getByLabel('Why the matter is closing').fill('All work completed and final letter sent');
  await page.getByLabel('I understand a closed matter cannot be reopened or changed').check();
  await page.getByRole('button', { name: 'Close the matter' }).click();
  await expect(page.getByRole('alert', { name: 'There is a problem' })).toContainText('Complete or cancel every open task');

  await page.goto(`/tasks/${task.id}`);
  await page.getByRole('button', { name: 'Complete task' }).click();
  await page.goto(`/matters/${matter.id}/close`);
  await page.getByLabel('Why the matter is closing').fill('All work completed and final letter sent');
  await page.getByLabel('I understand a closed matter cannot be reopened or changed').check();
  await page.getByRole('button', { name: 'Close the matter' }).click();
  await expect(page.getByText('This matter is closed.')).toBeVisible();
  await expect(page.getByRole('row', { name: /Send final report.*Completed/ })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Add a task' })).toHaveCount(0);

  await follow(page, page.getByRole('link', { name: 'Send final report' }));
  await expect(page.getByRole('form', { name: 'Change task details' })).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'Reassign task' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reopen task' })).toHaveCount(0);
  await noAxeViolations(page);
});
