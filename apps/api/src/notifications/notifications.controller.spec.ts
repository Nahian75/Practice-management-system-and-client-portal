import { randomBytes } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { NotificationsModule } from './notifications.module.js';

@Module({ imports: [TasksModule, NotificationsModule] })
class TasksAndNotificationsModule {}

describe('Notifications', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let creator: TestAccount;
  let assignee: TestAccount;
  let partner: TestAccount;
  let creatorToken: string;
  let assigneeToken: string;
  let partnerToken: string;
  let matterId: string;

  const randomName = () => {
    const letters = Array.from(randomBytes(16), (byte) => String.fromCharCode(97 + (byte % 26))).join('');
    return letters[0]!.toUpperCase() + letters.slice(1);
  };

  const as = (token: string) => {
    const server = request(app.getHttpServer());
    const cookie = `__Host-session=${token}`;
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie),
      post: (path: string, body?: object) => server.post(path).set('Cookie', cookie).send(body),
      put: (path: string, body?: object) => server.put(path).set('Cookie', cookie).send(body),
      patch: (path: string, body?: object) => server.patch(path).set('Cookie', cookie).send(body),
    };
  };

  async function staffWith(...roles: StaffRole[]): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) {
      await grantTestRole(db, account.id, role);
    }
    return account;
  }

  const signedIn = (account: TestAccount) => sessions.start(account, 'authenticated', {});

  async function addToTeam(accountId: string, role: 'fee_earner' | 'supervising_partner' = 'fee_earner'): Promise<void> {
    await db.insertInto('matter_team').values({ matter_id: matterId, account_id: accountId, role, added_by: creator.id }).execute();
  }

  async function openMatter(): Promise<string> {
    return db.transaction().execute(async (trx) => {
      const client = await trx
        .insertInto('clients')
        .values({ kind: 'individual', created_by: creator.id })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('client_individuals')
        .values({ client_id: client.id, given_names: randomName(), family_name: randomName() })
        .execute();
      const check = await trx
        .insertInto('conflict_checks')
        .values({ client_id: client.id, requested_by: creator.id, names: [randomName()] })
        .returning('id')
        .executeTakeFirstOrThrow();
      const matter = await trx
        .insertInto('matters')
        .values({
          client_id: client.id,
          title: 'Notification test matter',
          matter_type: 'other',
          opened_by: creator.id,
          conflict_check_id: check.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('matter_team')
        .values([
          { matter_id: matter.id, account_id: creator.id, role: 'fee_earner', added_by: creator.id },
          { matter_id: matter.id, account_id: assignee.id, role: 'fee_earner', added_by: creator.id },
          { matter_id: matter.id, account_id: partner.id, role: 'supervising_partner', added_by: creator.id },
        ])
        .execute();
      return matter.id;
    });
  }

  async function createTask(assignedTo = assignee.id, title = 'Review draft contract') {
    return as(creatorToken).post(`/matters/${matterId}/tasks`, {
      title,
      description: 'Check the termination provisions.',
      dueOn: '2027-02-12',
      priority: 'high',
      assigneeId: assignedTo,
    });
  }

  const notificationEvents = (resourceId?: string) => {
    let query = db
      .selectFrom('audit_events')
      .select(['actor_id', 'action', 'resource_type', 'resource_id', 'metadata'])
      .where('action', 'like', 'notification.%');
    if (resourceId) {
      query = query.where('resource_id', '=', resourceId);
    }
    return query.orderBy('id').execute();
  };

  const failAudit = (action: string) => {
    const service = app.get(AuditService);
    const record = service.record.bind(service);
    return vi.spyOn(service, 'record').mockImplementation((event, transaction) =>
      event.action === action ? Promise.reject(new Error('audit unavailable')) : record(event, transaction),
    );
  };

  beforeAll(async () => {
    app = await createTestApp(TasksAndNotificationsModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    creator = await staffWith('fee_earner');
    assignee = await staffWith('fee_earner');
    partner = await staffWith('partner');
    creatorToken = await signedIn(creator);
    assigneeToken = await signedIn(assignee);
    partnerToken = await signedIn(partner);
    matterId = await openMatter();
  });

  it('lists the newest visible assignment with current task text and an unread count', async () => {
    const created = await createTask();

    const response = await as(assigneeToken).get('/notifications');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      notifications: [
        {
          id: expect.any(String),
          kind: 'task_assigned',
          createdAt: expect.any(String),
          readAt: null,
          task: { id: created.body.id, title: 'Review draft contract', status: 'open', dueOn: '2027-02-12' },
        },
      ],
      next: null,
      unreadCount: 1,
    });
    expect((await as(creatorToken).get('/notifications')).body.notifications).toEqual([]);
  });

  it('reads changed task text instead of copying it into the notification', async () => {
    const created = await createTask();
    await as(creatorToken).patch(`/tasks/${created.body.id}`, { title: 'Review final contract' });

    const response = await as(assigneeToken).get('/notifications');

    expect(response.body.notifications[0].task.title).toBe('Review final contract');
  });

  it('notifies both people after reassignment', async () => {
    const next = await staffWith('fee_earner');
    await addToTeam(next.id);
    const nextToken = await signedIn(next);
    const created = await createTask();

    expect((await as(creatorToken).put(`/tasks/${created.body.id}/assignee`, { assigneeId: next.id })).status).toBe(200);

    expect((await as(assigneeToken).get('/notifications')).body.notifications.map((notice: { kind: string }) => notice.kind)).toEqual([
      'task_unassigned',
      'task_assigned',
    ]);
    expect((await as(nextToken).get('/notifications')).body.notifications.map((notice: { kind: string }) => notice.kind)).toEqual([
      'task_assigned',
    ]);
  });

  it('notifies the assignee only when someone else changes task status', async () => {
    const first = await createTask();
    await as(partnerToken).post(`/tasks/${first.body.id}/complete`);
    const second = await createTask();
    await as(assigneeToken).post(`/tasks/${second.body.id}/cancel`);

    const notices = (await as(assigneeToken).get('/notifications')).body.notifications as { kind: string; task: { id: string } }[];

    expect(notices).toContainEqual(expect.objectContaining({ kind: 'task_completed', task: expect.objectContaining({ id: first.body.id }) }));
    expect(notices).not.toContainEqual(expect.objectContaining({ kind: 'task_cancelled', task: expect.objectContaining({ id: second.body.id }) }));
  });

  it('records cancellation and reopening when another person makes the change', async () => {
    const created = await createTask();
    await as(partnerToken).post(`/tasks/${created.body.id}/cancel`);
    await as(partnerToken).post(`/tasks/${created.body.id}/reopen`);

    expect((await as(assigneeToken).get('/notifications')).body.notifications.map((notice: { kind: string }) => notice.kind)).toEqual([
      'task_reopened',
      'task_cancelled',
      'task_assigned',
    ]);
  });

  it('marks a notification read once and audits no task text', async () => {
    const created = await createTask();
    const notice = (await as(assigneeToken).get('/notifications')).body.notifications[0];

    expect((await as(assigneeToken).post(`/notifications/${notice.id}/read`)).status).toBe(204);
    expect((await as(assigneeToken).post(`/notifications/${notice.id}/read`)).status).toBe(204);

    const listed = (await as(assigneeToken).get('/notifications')).body;
    expect(listed.notifications[0].readAt).toEqual(expect.any(String));
    expect(listed.unreadCount).toBe(0);
    const events = (await notificationEvents(notice.id)).filter((event) => event.action === 'notification.read');
    expect(events).toEqual([
      {
        actor_id: assignee.id,
        action: 'notification.read',
        resource_type: 'notification',
        resource_id: notice.id,
        metadata: { taskId: created.body.id },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('Review draft contract');
  });

  it('records creation with ids and kind only', async () => {
    const created = await createTask();
    const notice = (await as(assigneeToken).get('/notifications')).body.notifications[0];

    const events = await notificationEvents(notice.id);

    expect(events).toEqual([
      {
        actor_id: creator.id,
        action: 'notification.created',
        resource_type: 'notification',
        resource_id: notice.id,
        metadata: { recipientId: assignee.id, kind: 'task_assigned', taskId: created.body.id },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('Review draft contract');
  });

  it('hides a notification and refuses to read it as soon as matter access ends', async () => {
    await createTask();
    const notice = (await as(assigneeToken).get('/notifications')).body.notifications[0];
    await db
      .updateTable('matter_team')
      .set({ removed_by: partner.id, removed_at: new Date() })
      .where('matter_id', '=', matterId)
      .where('account_id', '=', assignee.id)
      .execute();

    expect((await as(assigneeToken).get('/notifications')).body).toEqual({ notifications: [], next: null, unreadCount: 0 });
    expect((await as(assigneeToken).post(`/notifications/${notice.id}/read`)).status).toBe(404);
  });

  it('does not let another staff member find or read a notification', async () => {
    await createTask();
    const notice = (await as(assigneeToken).get('/notifications')).body.notifications[0];

    expect((await as(creatorToken).get('/notifications')).body).toEqual({ notifications: [], next: null, unreadCount: 0 });
    expect((await as(creatorToken).post(`/notifications/${notice.id}/read`)).status).toBe(404);
  });

  it('returns 50 at a time with a cursor and counts every visible unread notification', async () => {
    await db
      .insertInto('tasks')
      .values(Array.from({ length: 51 }, (_, index) => ({
        matter_id: matterId,
        title: `Task ${index}`,
        description: null,
        due_on: null,
        priority: 'normal' as const,
        assigned_to: assignee.id,
        created_by: creator.id,
      })))
      .execute();

    const first = (await as(assigneeToken).get('/notifications')).body;
    const second = (await as(assigneeToken).get(`/notifications?before=${first.next}`)).body;

    expect(first.notifications).toHaveLength(50);
    expect(first.next).toEqual(expect.any(String));
    expect(first.unreadCount).toBe(51);
    expect(second.notifications).toHaveLength(1);
    expect(second.next).toBeNull();
    expect(second.unreadCount).toBe(51);
  });

  it('allows every signed-in staff account, but refuses clients and missing sessions', async () => {
    const staff = await staffWith();
    expect((await as(await signedIn(staff)).get('/notifications')).status).toBe(200);

    const client = await createTestAccount(db, 'client');
    expect((await as(await signedIn(client)).get('/notifications')).status).toBe(403);
    expect((await request(app.getHttpServer()).get('/notifications')).status).toBe(401);
  });

  it('validates cursors and ids before the handler runs', async () => {
    expect((await as(assigneeToken).get('/notifications?before=not-a-uuid')).status).toBe(400);
    expect((await as(assigneeToken).post('/notifications/not-a-uuid/read')).status).toBe(400);
  });

  it('rolls task creation back when notification creation cannot be audited', async () => {
    const audit = failAudit('notification.created');
    let response: request.Response;
    try {
      response = await createTask();
    } finally {
      audit.mockRestore();
    }

    expect(response!.status).toBe(500);
    expect(await db.selectFrom('tasks').select('id').where('matter_id', '=', matterId).execute()).toEqual([]);
  });

  it('rolls reassignment and its notifications back when notification creation cannot be audited', async () => {
    const next = await staffWith('fee_earner');
    await addToTeam(next.id);
    const nextToken = await signedIn(next);
    const created = await createTask();
    const audit = failAudit('notification.created');
    let response: request.Response;
    try {
      response = await as(creatorToken).put(`/tasks/${created.body.id}/assignee`, { assigneeId: next.id });
    } finally {
      audit.mockRestore();
    }

    expect(response!.status).toBe(500);
    expect((await as(creatorToken).get(`/tasks/${created.body.id}`)).body.assignee.accountId).toBe(assignee.id);
    expect((await as(nextToken).get('/notifications')).body.notifications).toEqual([]);
    expect((await as(assigneeToken).get('/notifications')).body.notifications.map((notice: { kind: string }) => notice.kind)).toEqual([
      'task_assigned',
    ]);
  });

  it('rolls a status change and its notification back when notification creation cannot be audited', async () => {
    const created = await createTask();
    const audit = failAudit('notification.created');
    let response: request.Response;
    try {
      response = await as(partnerToken).post(`/tasks/${created.body.id}/complete`);
    } finally {
      audit.mockRestore();
    }

    expect(response!.status).toBe(500);
    expect((await as(creatorToken).get(`/tasks/${created.body.id}`)).body.status).toBe('open');
    expect((await as(assigneeToken).get('/notifications')).body.notifications.map((notice: { kind: string }) => notice.kind)).toEqual([
      'task_assigned',
    ]);
  });

  it('rolls read state back when its audit record cannot be written', async () => {
    await createTask();
    const notice = (await as(assigneeToken).get('/notifications')).body.notifications[0];
    const audit = failAudit('notification.read');
    let response: request.Response;
    try {
      response = await as(assigneeToken).post(`/notifications/${notice.id}/read`);
    } finally {
      audit.mockRestore();
    }

    expect(response!.status).toBe(500);
    expect((await as(assigneeToken).get('/notifications')).body.notifications[0].readAt).toBeNull();
  });
});
