import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAccount, grantTestRole, revokeTestRole, setAccountStatus, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { ClientsModule } from '../clients/clients.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { DATABASE } from '../database/database.module.js';
import { MattersModule } from '../matters/matters.module.js';
import { TasksModule } from './tasks.module.js';

@Module({ imports: [ClientsModule, MattersModule, TasksModule] })
class ClientsMattersTasksModule {}

describe('Tasks', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let token: string;
  let matterId: string;

  const uniqueName = () => randomUUID().replaceAll('-', '').slice(0, 16);
  const cookie = (sessionToken: string) => `__Host-session=${sessionToken}`;
  const signedIn = (account: TestAccount) => sessions.start(account, 'authenticated', {});

  async function staffWith(...roles: StaffRole[]): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) {
      await grantTestRole(db, account.id, role);
    }
    return account;
  }

  const as = (sessionToken: string) => {
    const server = request(app.getHttpServer());
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie(sessionToken)),
      post: (path: string, body: object) => server.post(path).set('Cookie', cookie(sessionToken)).send(body),
      patch: (path: string, body: object) => server.patch(path).set('Cookie', cookie(sessionToken)).send(body),
      put: (path: string, body: object) => server.put(path).set('Cookie', cookie(sessionToken)).send(body),
    };
  };

  async function createClient(sessionToken: string, givenNames = uniqueName(), familyName = uniqueName()) {
    return as(sessionToken).post('/clients', { kind: 'individual', givenNames, familyName });
  }

  async function openMatter(sessionToken: string, otherParty = uniqueName()) {
    const client = await createClient(sessionToken);
    const check = await as(sessionToken).post('/conflict-checks', { clientId: client.body.id, names: [otherParty] });
    return as(sessionToken).post('/matters', {
      clientId: client.body.id,
      title: 'Lease renewal',
      matterType: 'commercial_property',
      supervisingPartnerId: partner.id,
      conflictCheckId: check.body.id,
      parties: [{ role: 'opponent', kind: 'individual', name: otherParty }],
    });
  }

  const newTask = (overrides: object = {}) => ({
    title: 'Review draft contract',
    description: 'Check the termination provisions.',
    dueOn: '2027-02-12',
    priority: 'high',
    assigneeId: feeEarner.id,
    ...overrides,
  });

  const createTask = (sessionToken = token, matter = matterId, overrides: object = {}) =>
    as(sessionToken).post(`/matters/${matter}/tasks`, newTask(overrides));

  beforeAll(async () => {
    app = await createTestApp(ClientsMattersTasksModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    partner = await staffWith('partner');
    feeEarner = await staffWith('fee_earner');
    await db.updateTable('accounts').set({ display_name: 'Pat Fee Earner' }).where('id', '=', feeEarner.id).execute();
    await db.updateTable('accounts').set({ display_name: 'Sam Partner' }).where('id', '=', partner.id).execute();
    token = await signedIn(feeEarner);
    matterId = (await openMatter(token)).body.id;
  });

  describe('POST /matters/:id/tasks', () => {
    it('creates a task on an open matter and returns only its staff-safe fields', async () => {
      const response = await createTask();

      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        id: expect.any(String),
        matterId,
        title: 'Review draft contract',
        description: 'Check the termination provisions.',
        dueOn: '2027-02-12',
        priority: 'high',
        status: 'open',
        assignee: { accountId: feeEarner.id, displayName: 'Pat Fee Earner' },
        createdBy: { accountId: feeEarner.id, displayName: 'Pat Fee Earner' },
        createdAt: expect.any(String),
      });
    });

    it('uses normal priority and null optional fields when they are omitted', async () => {
      const response = await as(token).post(`/matters/${matterId}/tasks`, { title: 'Call the client', assigneeId: partner.id });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ description: null, dueOn: null, priority: 'normal', assignee: { accountId: partner.id, displayName: 'Sam Partner' } });
    });

    it('records the creation in the same transaction without task text', async () => {
      const response = await createTask();

      const event = await db.selectFrom('audit_events').select(['actor_id', 'action', 'outcome', 'resource_type', 'metadata']).where('resource_id', '=', response.body.id).executeTakeFirstOrThrow();
      expect(event).toEqual({
        actor_id: feeEarner.id,
        action: 'task.created',
        outcome: 'success',
        resource_type: 'task',
        metadata: { matterId, assigneeId: feeEarner.id, priority: 'high', hasDueDate: true },
      });
      expect(JSON.stringify(event)).not.toContain('Review draft contract');
      expect(JSON.stringify(event)).not.toContain('termination provisions');
    });

    it('rolls the task back if its audit record cannot be written', async () => {
      const audit = vi.spyOn(app.get(AuditService), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
      let response: request.Response;
      try {
        response = await createTask(token, matterId, { title: 'Must roll back' });
      } finally {
        audit.mockRestore();
      }

      expect(response!.status).toBe(500);
      expect(await db.selectFrom('tasks').select('id').where('matter_id', '=', matterId).where('title', '=', 'Must roll back').execute()).toEqual([]);
    });

    it('lets the supervising partner create a task too', async () => {
      const partnerToken = await signedIn(partner);

      expect((await createTask(partnerToken, matterId, { assigneeId: partner.id })).status).toBe(201);
    });

    it.each([
      ['an empty title', { title: '' }],
      ['a title over 200 characters', { title: 'x'.repeat(201) }],
      ['an empty description', { description: '' }],
      ['a description over 2,000 characters', { description: 'x'.repeat(2_001) }],
      ['an invalid due date', { dueOn: '12/02/2027' }],
      ['an unknown priority', { priority: 'immediate' }],
      ['an unknown field', { secret: true }],
    ])('refuses %s', async (_case, invalid) => {
      expect((await createTask(token, matterId, invalid)).status).toBe(400);
    });

    it('requires a signed-in staff session', async () => {
      const response = await request(app.getHttpServer()).post(`/matters/${matterId}/tasks`).send(newTask());

      expect(response.status).toBe(401);
    });

    it.each(['administrator', 'accounts', 'compliance'] as const)('refuses the %s role', async (role) => {
      const account = await staffWith(role);

      expect((await createTask(await signedIn(account))).status).toBe(403);
    });

    it('hides a matter outside the creator team', async () => {
      const outsider = await staffWith('fee_earner');

      expect((await createTask(await signedIn(outsider))).status).toBe(404);
    });

    it('refuses a matter awaiting conflict clearance or already closed', async () => {
      const matchingName = uniqueName();
      await createClient(token, 'Conflict', matchingName);
      const awaiting = await openMatter(token, `Conflict ${matchingName}`);
      expect(awaiting.body.status).toBe('awaiting_clearance');
      expect((await createTask(token, awaiting.body.id)).status).toBe(409);

      await db.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'All work completed and final letter sent' }).execute();
      expect((await createTask()).status).toBe(409);
    });

    it('refuses an assignee outside the active matter team', async () => {
      const outsider = await staffWith('fee_earner');
      expect((await createTask(token, matterId, { assigneeId: outsider.id })).status).toBe(409);

      await db.insertInto('matter_team').values({ matter_id: matterId, account_id: outsider.id, role: 'fee_earner', added_by: partner.id }).execute();
      await setAccountStatus(db, outsider.id, 'disabled');
      expect((await createTask(token, matterId, { assigneeId: outsider.id })).status).toBe(409);
    });
  });

  describe('reading tasks', () => {
    it('lists the matter tasks newest first', async () => {
      const first = await createTask(token, matterId, { title: 'First task' });
      const second = await createTask(token, matterId, { title: 'Second task', priority: 'urgent' });

      const response = await as(token).get(`/matters/${matterId}/tasks`);

      expect(response.status).toBe(200);
      expect(response.body.next).toBeNull();
      expect(response.body.tasks.map((task: { id: string }) => task.id)).toEqual([second.body.id, first.body.id]);
      expect(response.body.tasks[0]).toMatchObject({ title: 'Second task', priority: 'urgent', assignee: { accountId: feeEarner.id } });
    });

    it('paginates 100 tasks at a time without repeating one', async () => {
      await db
        .insertInto('tasks')
        .values(
          Array.from({ length: 101 }, (_, index) => ({
            matter_id: matterId,
            title: `Task ${index + 1}`,
            description: null,
            due_on: null,
            priority: 'normal' as const,
            assigned_to: feeEarner.id,
            created_by: feeEarner.id,
          })),
        )
        .execute();

      const first = await as(token).get(`/matters/${matterId}/tasks`);
      const second = await as(token).get(`/matters/${matterId}/tasks?before=${first.body.next}`);

      expect(first.body.tasks).toHaveLength(100);
      expect(first.body.next).toBe(first.body.tasks[99].id);
      expect(second.body.tasks).toHaveLength(1);
      expect(second.body.tasks[0].id).not.toBe(first.body.tasks[99].id);
      expect(second.body.next).toBeNull();
    });

    it('returns one task with its assignee and creator names', async () => {
      const created = await createTask(token, matterId, { assigneeId: partner.id });

      const response = await as(token).get(`/tasks/${created.body.id}`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: created.body.id,
        matterId,
        assignee: { accountId: partner.id, displayName: 'Sam Partner' },
        createdBy: { accountId: feeEarner.id, displayName: 'Pat Fee Earner' },
      });
    });

    it('keeps tasks readable after the matter closes', async () => {
      const created = await createTask();
      await as(token).post(`/tasks/${created.body.id}/cancel`, {});
      await db.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'All work completed and final letter sent' }).execute();

      expect((await as(token).get(`/matters/${matterId}/tasks`)).body.tasks).toHaveLength(1);
      expect((await as(token).get(`/tasks/${created.body.id}`)).status).toBe(200);
    });

    it('hides lists and details outside the active matter team', async () => {
      const created = await createTask();
      const outsider = await staffWith('fee_earner');
      const outsiderToken = await signedIn(outsider);

      expect((await as(outsiderToken).get(`/matters/${matterId}/tasks`)).status).toBe(404);
      expect((await as(outsiderToken).get(`/tasks/${created.body.id}`)).status).toBe(404);
      expect((await as(token).get(`/tasks/${randomUUID()}`)).status).toBe(404);
    });

    it.each(['administrator', 'accounts', 'compliance'] as const)('refuses task reads for the %s role', async (role) => {
      const account = await staffWith(role);

      expect((await as(await signedIn(account)).get(`/matters/${matterId}/tasks`)).status).toBe(403);
    });

    it('validates list and task ids', async () => {
      expect((await as(token).get('/matters/not-a-uuid/tasks')).status).toBe(400);
      expect((await as(token).get(`/matters/${matterId}/tasks?before=not-a-uuid`)).status).toBe(400);
      expect((await as(token).get('/tasks/not-a-uuid')).status).toBe(400);
    });
  });

  describe('changing tasks', () => {
    it('edits details, keeps before and after history, and audits field names only', async () => {
      const created = await createTask();

      const response = await as(token).patch(`/tasks/${created.body.id}`, {
        title: 'Review final contract',
        description: null,
        dueOn: null,
        priority: 'urgent',
      });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ title: 'Review final contract', description: null, dueOn: null, priority: 'urgent' });
      const found = await as(token).get(`/tasks/${created.body.id}`);
      expect(found.body.changes).toEqual([
        {
          id: expect.any(String),
          kind: 'details',
          changedBy: { accountId: feeEarner.id, displayName: 'Pat Fee Earner' },
          changedAt: expect.any(String),
          from: { title: 'Review draft contract', description: 'Check the termination provisions.', dueOn: '2027-02-12', priority: 'high' },
          to: { title: 'Review final contract', description: null, dueOn: null, priority: 'urgent' },
        },
      ]);
      const event = await db.selectFrom('audit_events').select(['action', 'metadata']).where('resource_id', '=', created.body.id).where('action', '=', 'task.updated').executeTakeFirstOrThrow();
      expect(event).toEqual({ action: 'task.updated', metadata: { matterId, fields: 'description,dueOn,priority,title' } });
      expect(JSON.stringify(event)).not.toContain('Review final contract');
    });

    it('rolls a change and its history back if audit cannot be written', async () => {
      const created = await createTask();
      const audit = vi.spyOn(app.get(AuditService), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
      let response: request.Response;
      try {
        response = await as(token).patch(`/tasks/${created.body.id}`, { title: 'Must roll back' });
      } finally {
        audit.mockRestore();
      }

      expect(response!.status).toBe(500);
      const found = await as(token).get(`/tasks/${created.body.id}`);
      expect(found.body.title).toBe('Review draft contract');
      expect(found.body.changes).toEqual([]);
    });

    it('does not record no-op edits, assignments or repeated status changes', async () => {
      const created = await createTask();

      expect((await as(token).patch(`/tasks/${created.body.id}`, { title: 'Review draft contract' })).status).toBe(200);
      expect((await as(token).put(`/tasks/${created.body.id}/assignee`, { assigneeId: feeEarner.id })).status).toBe(200);
      expect((await as(token).post(`/tasks/${created.body.id}/complete`, {})).status).toBe(204);
      expect((await as(token).post(`/tasks/${created.body.id}/complete`, {})).status).toBe(204);

      const found = await as(token).get(`/tasks/${created.body.id}`);
      expect(found.body.changes.map((change: { kind: string }) => change.kind)).toEqual(['status']);
      const events = await db
        .selectFrom('audit_events')
        .select('action')
        .where('resource_id', '=', created.body.id)
        .where('action', 'in', ['task.updated', 'task.reassigned', 'task.completed'])
        .orderBy('id')
        .execute();
      expect(events.map((event) => event.action)).toEqual(['task.completed']);
    });

    it('reassigns to an active team member and records ids, not names', async () => {
      const created = await createTask();

      const response = await as(token).put(`/tasks/${created.body.id}/assignee`, { assigneeId: partner.id });

      expect(response.status).toBe(200);
      expect(response.body.assignee).toEqual({ accountId: partner.id, displayName: 'Sam Partner' });
      const found = await as(token).get(`/tasks/${created.body.id}`);
      expect(found.body.changes[0]).toMatchObject({
        kind: 'assignment',
        from: { accountId: feeEarner.id, displayName: 'Pat Fee Earner' },
        to: { accountId: partner.id, displayName: 'Sam Partner' },
      });
      const event = await db.selectFrom('audit_events').select(['action', 'metadata']).where('resource_id', '=', created.body.id).where('action', '=', 'task.reassigned').executeTakeFirstOrThrow();
      expect(event).toEqual({ action: 'task.reassigned', metadata: { matterId, fromAssigneeId: feeEarner.id, toAssigneeId: partner.id } });
    });

    it('lets the assignee or supervising partner complete, reopen and cancel', async () => {
      const created = await createTask();
      const partnerToken = await signedIn(partner);

      expect((await as(token).post(`/tasks/${created.body.id}/complete`, {})).status).toBe(204);
      expect((await as(partnerToken).post(`/tasks/${created.body.id}/reopen`, {})).status).toBe(204);
      expect((await as(partnerToken).post(`/tasks/${created.body.id}/cancel`, {})).status).toBe(204);

      const found = await as(token).get(`/tasks/${created.body.id}`);
      expect(found.body.status).toBe('cancelled');
      expect(found.body.changes.map((change: { kind: string; from: string; to: string }) => [change.kind, change.from, change.to])).toEqual([
        ['status', 'open', 'completed'],
        ['status', 'completed', 'open'],
        ['status', 'open', 'cancelled'],
      ]);
      const events = await db.selectFrom('audit_events').select('action').where('resource_id', '=', created.body.id).where('action', 'in', ['task.completed', 'task.reopened', 'task.cancelled']).orderBy('id').execute();
      expect(events.map((event) => event.action)).toEqual(['task.completed', 'task.reopened', 'task.cancelled']);
    });

    it('refuses status changes by another fee earner on the team', async () => {
      const colleague = await staffWith('fee_earner');
      await db.insertInto('matter_team').values({ matter_id: matterId, account_id: colleague.id, role: 'fee_earner', added_by: partner.id }).execute();
      const created = await createTask();

      expect((await as(await signedIn(colleague)).post(`/tasks/${created.body.id}/complete`, {})).status).toBe(403);
    });

    it('removes supervisor status powers when the recorded supervisor loses the partner role', async () => {
      await grantTestRole(db, partner.id, 'fee_earner');
      const partnerToken = await signedIn(partner);
      const created = await createTask();
      await revokeTestRole(db, partner.id, 'partner');

      const details = await as(partnerToken).get(`/tasks/${created.body.id}`);
      expect(details.status).toBe(200);
      expect(details.body.canChangeStatus).toBe(false);
      expect((await as(partnerToken).post(`/tasks/${created.body.id}/complete`, {})).status).toBe(403);
    });

    it('hides every change route outside the matter team', async () => {
      const created = await createTask();
      const outsider = await staffWith('fee_earner');
      const outsiderApi = as(await signedIn(outsider));

      expect((await outsiderApi.patch(`/tasks/${created.body.id}`, { title: 'Hidden' })).status).toBe(404);
      expect((await outsiderApi.put(`/tasks/${created.body.id}/assignee`, { assigneeId: outsider.id })).status).toBe(404);
      expect((await outsiderApi.post(`/tasks/${created.body.id}/complete`, {})).status).toBe(404);
    });

    it('refuses every change after the matter closes', async () => {
      const created = await createTask();
      await as(token).post(`/tasks/${created.body.id}/cancel`, {});
      await db.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'All work completed and final letter sent' }).execute();

      expect((await as(token).patch(`/tasks/${created.body.id}`, { title: 'Too late' })).status).toBe(409);
      expect((await as(token).put(`/tasks/${created.body.id}/assignee`, { assigneeId: partner.id })).status).toBe(409);
      expect((await as(token).post(`/tasks/${created.body.id}/reopen`, {})).status).toBe(409);
    });

    it('refuses an inactive or outside assignee', async () => {
      const created = await createTask();
      const outsider = await staffWith('fee_earner');
      expect((await as(token).put(`/tasks/${created.body.id}/assignee`, { assigneeId: outsider.id })).status).toBe(409);

      await db.insertInto('matter_team').values({ matter_id: matterId, account_id: outsider.id, role: 'fee_earner', added_by: partner.id }).execute();
      await setAccountStatus(db, outsider.id, 'disabled');
      expect((await as(token).put(`/tasks/${created.body.id}/assignee`, { assigneeId: outsider.id })).status).toBe(409);
    });

    it('requires reopening before switching between completed and cancelled', async () => {
      const created = await createTask();
      await as(token).post(`/tasks/${created.body.id}/complete`, {});

      expect((await as(await signedIn(partner)).post(`/tasks/${created.body.id}/cancel`, {})).status).toBe(409);
    });

    it('rejects empty or unknown edits and unknown assignment fields', async () => {
      const created = await createTask();

      expect((await as(token).patch(`/tasks/${created.body.id}`, {})).status).toBe(400);
      expect((await as(token).patch(`/tasks/${created.body.id}`, { title: 'Valid', unknown: true })).status).toBe(400);
      expect((await as(token).put(`/tasks/${created.body.id}/assignee`, { assigneeId: partner.id, unknown: true })).status).toBe(400);
    });

    it('requires tasks.manage', async () => {
      const created = await createTask();
      const administrator = await staffWith('administrator');

      expect((await as(await signedIn(administrator)).patch(`/tasks/${created.body.id}`, { title: 'No access' })).status).toBe(403);
    });

    it('blocks matter closure until every task is completed or cancelled', async () => {
      const created = await createTask();
      const partnerApi = as(await signedIn(partner));
      const close = () => partnerApi.post(`/matters/${matterId}/close`, { reason: 'All work completed and final letter sent' });

      const refused = await close();
      expect(refused.status).toBe(409);
      expect(refused.body.message).toMatch(/open task/i);

      await as(token).post(`/tasks/${created.body.id}/complete`, {});
      expect((await close()).status).toBe(204);
    });
  });
});
