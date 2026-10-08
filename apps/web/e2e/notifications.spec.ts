import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { follow, noAxeViolations } from './support/checks';
import { openMatter } from './support/matters';
import { apiSessionFor, signedInStaff } from './support/session';

const accountIdOf = async (page: Page) =>
  ((await (await page.request.get('/api/auth/session')).json()) as { account: { id: string } }).account.id;

async function createTask(api: APIRequestContext, matterId: string, assigneeId: string, title: string) {
  const response = await api.post(`/api/matters/${matterId}/tasks`, {
    data: {
      title,
      description: 'Private instructions must not appear in the inbox.',
      dueOn: '2027-02-12',
      priority: 'high',
      assigneeId,
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: string };
}

test('shows the unread count, current task facts and one-way read state', async ({ page, request }) => {
  await signedInStaff(page, request);
  const recipientId = await accountIdOf(page);
  const partner = await apiSessionFor(request, ['partner']);
  const matter = await openMatter(partner.api, partner.accountId, [recipientId]);
  const task = await createTask(partner.api, matter.id, recipientId, 'Review completion statement');

  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Notifications, 1 unread' })).toBeVisible();
  await follow(page, page.getByRole('link', { name: 'Notifications, 1 unread' }));

  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  const notice = page.getByRole('list', { name: 'Notifications' }).getByRole('listitem');
  await expect(notice).toContainText('Task assigned to you');
  await expect(notice).toContainText('Review completion statement');
  await expect(notice).toContainText('Open');
  await expect(notice).toContainText('12 February 2027');
  await expect(notice).toContainText('Unread');
  await expect(notice).not.toContainText('Private instructions');
  await expect(notice).not.toContainText(matter.title);
  await noAxeViolations(page);

  await notice.getByRole('button', { name: 'Mark as read' }).click();
  await expect(page.getByRole('link', { name: 'Notifications, 0 unread' })).toBeVisible();
  await expect(notice).toContainText('Read');
  await expect(notice.getByRole('button', { name: 'Mark as read' })).toHaveCount(0);

  await follow(page, notice.getByRole('link', { name: 'Review completion statement' }));
  await expect(page).toHaveURL(`/tasks/${task.id}`);
  await expect(page.getByRole('heading', { name: 'Review completion statement' })).toBeVisible();
});

test('removes notification text as soon as matter access ends', async ({ page, request }) => {
  await signedInStaff(page, request);
  const recipientId = await accountIdOf(page);
  const partner = await apiSessionFor(request, ['partner']);
  const next = await apiSessionFor(request);
  const matter = await openMatter(partner.api, partner.accountId, [recipientId, next.accountId]);
  const task = await createTask(partner.api, matter.id, recipientId, 'Private access-loss task');
  expect((await partner.api.put(`/api/tasks/${task.id}/assignee`, { data: { assigneeId: next.accountId } })).status()).toBe(200);
  expect((await partner.api.delete(`/api/matters/${matter.id}/team/${recipientId}`)).status()).toBe(204);

  await page.goto('/notifications');

  await expect(page.getByText('You have no notifications.')).toBeVisible();
  await expect(page.getByText('Private access-loss task')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Notifications, 0 unread' })).toBeVisible();
});

test('returns an invalid paging address to the first page', async ({ page, request }) => {
  await signedInStaff(page, request);

  await page.goto('/notifications?before=not-a-notification-id');

  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
});

test('shows 50 newest notifications at a time and links to older ones', async ({ page, request }) => {
  await signedInStaff(page, request);
  const recipientId = await accountIdOf(page);
  const partner = await apiSessionFor(request, ['partner']);
  const matter = await openMatter(partner.api, partner.accountId, [recipientId]);
  for (let index = 1; index <= 51; index += 1) {
    await createTask(partner.api, matter.id, recipientId, `Paging task ${index.toString().padStart(2, '0')}`);
  }

  await page.goto('/notifications');
  const list = page.getByRole('list', { name: 'Notifications' });
  await expect(list.getByRole('listitem')).toHaveCount(50);
  await expect(page.getByRole('link', { name: 'Notifications, 51 unread' })).toBeVisible();
  await expect(page.getByText('Paging task 51')).toBeVisible();
  await expect(page.getByText('Paging task 01')).toHaveCount(0);

  await follow(page, page.getByRole('link', { name: 'Older notifications' }));
  await expect(page.getByRole('list', { name: 'Notifications' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByText('Paging task 01')).toBeVisible();
});
