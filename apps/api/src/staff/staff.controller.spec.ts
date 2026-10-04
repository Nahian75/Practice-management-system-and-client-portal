import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { FakeClock } from '../../test/fake-clock.js';
import { waitForEmails } from '../../test/mailpit.js';
import { authenticatorCode, enrolTwoFactor } from '../../test/two-factor.js';
import { InvitationsService } from '../auth/invitations/invitations.service.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { TwoFactorService } from '../auth/two-factor/two-factor.service.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { StaffModule } from './staff.module.js';

describe('Staff management', () => {
  const clock = new FakeClock();
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let admin: TestAccount;
  let adminToken: string;

  const as = (token: string) => {
    const server = request(app.getHttpServer());
    const cookie = `__Host-session=${token}`;
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie),
      post: (path: string, body?: object) => server.post(path).set('Cookie', cookie).send(body),
      put: (path: string) => server.put(path).set('Cookie', cookie),
      delete: (path: string) => server.delete(path).set('Cookie', cookie),
    };
  };
  const signedIn = (account: TestAccount) => sessions.start(account, 'authenticated', {});

  async function staffWith(...roles: StaffRole[]): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) {
      await grantTestRole(db, account.id, role);
    }
    return account;
  }

  const rolesOf = async (accountId: string) =>
    (
      await db
        .selectFrom('account_roles')
        .select('role')
        .where('account_id', '=', accountId)
        .where('revoked_at', 'is', null)
        .orderBy('role')
        .execute()
    ).map((row) => row.role);

  const eventsBy = (actorId: string) =>
    db
      .selectFrom('audit_events')
      .select(['action', 'resource_id', 'metadata'])
      .where('actor_id', '=', actorId)
      .where('action', 'like', 'staff.%')
      .orderBy('id')
      .execute();

  const statusOf = async (accountId: string) =>
    (await db.selectFrom('accounts').select('status').where('id', '=', accountId).executeTakeFirstOrThrow()).status;

  beforeAll(async () => {
    app = await createTestApp(StaffModule, { clock });
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    admin = await staffWith('administrator');
    adminToken = await signedIn(admin);
  });

  describe('GET /staff', () => {
    it('lists staff accounts with their active roles, and no clients', async () => {
      const partner = await staffWith('partner', 'compliance');
      const client = await createTestAccount(db, 'client');

      const response = await as(adminToken).get('/staff');

      expect(response.status).toBe(200);
      const ids = response.body.staff.map((member: { id: string }) => member.id);
      expect(ids).not.toContain(client.id);
      expect(response.body.staff).toContainEqual({
        id: partner.id,
        email: partner.email,
        displayName: 'Test staff',
        status: 'active',
        roles: ['compliance', 'partner'],
      });
    });

    it('never includes password hashes or other account fields', async () => {
      const response = await as(adminToken).get('/staff');

      for (const member of response.body.staff) {
        expect(Object.keys(member).sort()).toEqual(['displayName', 'email', 'id', 'roles', 'status']);
      }
    });

    it.each(['partner', 'compliance'] as const)('is open to a %s', async (role) => {
      expect((await as(await signedIn(await staffWith(role))).get('/staff')).status).toBe(200);
    });

    it.each(['fee_earner', 'accounts'] as const)('is closed to a %s', async (role) => {
      expect((await as(await signedIn(await staffWith(role))).get('/staff')).status).toBe(403);
    });

    it('is closed to clients', async () => {
      expect((await as(await signedIn(await createTestAccount(db, 'client'))).get('/staff')).status).toBe(403);
    });

    it('asks for sign-in when there is no session', async () => {
      expect((await request(app.getHttpServer()).get('/staff')).status).toBe(401);
    });
  });

  describe('POST /staff/invitations', () => {
    const newEmail = () => `new.staff-${randomUUID()}@example.com`;

    it('creates an invited staff account and emails the link', async () => {
      const email = newEmail();

      const response = await as(adminToken).post('/staff/invitations', { email, displayName: 'New Person' });

      expect(response.status).toBe(201);
      const account = await db
        .selectFrom('accounts')
        .select(['id', 'kind', 'status'])
        .where('email', '=', email)
        .executeTakeFirstOrThrow();
      expect(account).toEqual({ id: response.body.accountId, kind: 'staff', status: 'invited' });
      expect(await waitForEmails(email, 1)).toHaveLength(1);
      expect(await db.selectFrom('audit_events').select(['action', 'actor_id']).where('resource_id', '=', account.id).execute()).toEqual([
        { action: 'account.invited', actor_id: admin.id },
      ]);
    });

    it('sends a fresh link when the person is already invited', async () => {
      const email = newEmail();
      const first = await as(adminToken).post('/staff/invitations', { email, displayName: 'New Person' });

      const second = await as(adminToken).post('/staff/invitations', { email, displayName: 'New Person' });

      expect(second.status).toBe(201);
      expect(second.body.accountId).toBe(first.body.accountId);
    });

    it('refuses an address that already has an active account', async () => {
      const existing = await staffWith();

      const response = await as(adminToken).post('/staff/invitations', { email: existing.email, displayName: 'Again' });

      expect(response.status).toBe(409);
    });

    it('refuses to turn a client account into a staff account', async () => {
      const client = await createTestAccount(db, 'client', { status: 'invited' });

      const response = await as(adminToken).post('/staff/invitations', { email: client.email, displayName: 'Client' });

      expect(response.status).toBe(409);
      expect(await db.selectFrom('accounts').select('kind').where('id', '=', client.id).executeTakeFirstOrThrow()).toEqual({ kind: 'client' });
    });

    it('refuses extra fields, so roles cannot be smuggled into an invitation', async () => {
      const response = await as(adminToken).post('/staff/invitations', {
        email: newEmail(),
        displayName: 'New Person',
        roles: ['administrator'],
      });

      expect(response.status).toBe(400);
    });

    it.each([
      ['an invalid email', { email: 'not-an-email', displayName: 'New Person' }],
      ['a blank name', { email: 'blank.name@example.com', displayName: '   ' }],
    ])('refuses %s', async (_case, body) => {
      expect((await as(adminToken).post('/staff/invitations', body)).status).toBe(400);
    });

    it('is administrator only', async () => {
      const partner = await signedIn(await staffWith('partner'));

      expect((await as(partner).post('/staff/invitations', { email: newEmail(), displayName: 'X' })).status).toBe(403);
    });
  });

  describe('granting and revoking roles', () => {
    let staff: TestAccount;

    beforeEach(async () => {
      staff = await staffWith();
    });

    it('grants a role, which takes effect at once', async () => {
      const response = await as(adminToken).put(`/staff/${staff.id}/roles/partner`);

      expect(response.status).toBe(204);
      expect(await rolesOf(staff.id)).toEqual(['partner']);
      expect((await as(await signedIn(staff)).get('/staff')).status).toBe(200);
      expect(await eventsBy(admin.id)).toEqual([
        { action: 'staff.role_granted', resource_id: staff.id, metadata: { role: 'partner' } },
      ]);
    });

    it('treats granting a role already held as done', async () => {
      await as(adminToken).put(`/staff/${staff.id}/roles/partner`);

      expect((await as(adminToken).put(`/staff/${staff.id}/roles/partner`)).status).toBe(204);
      expect(await eventsBy(admin.id)).toHaveLength(1);
    });

    it('can grant a role to someone still invited', async () => {
      const invited = await createTestAccount(db, 'staff', { status: 'invited' });

      expect((await as(adminToken).put(`/staff/${invited.id}/roles/fee_earner`)).status).toBe(204);
      expect(await rolesOf(invited.id)).toEqual(['fee_earner']);
    });

    it('revokes a role, which takes effect at once, and keeps the history', async () => {
      await grantTestRole(db, staff.id, 'partner');
      const staffToken = await signedIn(staff);
      expect((await as(staffToken).get('/staff')).status).toBe(200);

      const response = await as(adminToken).delete(`/staff/${staff.id}/roles/partner`);

      expect(response.status).toBe(204);
      expect(await rolesOf(staff.id)).toEqual([]);
      expect((await as(staffToken).get('/staff')).status).toBe(403);
      const row = await db.selectFrom('account_roles').select(['revoked_by']).where('account_id', '=', staff.id).executeTakeFirstOrThrow();
      expect(row.revoked_by).toBe(admin.id);
      expect(await eventsBy(admin.id)).toEqual([
        { action: 'staff.role_revoked', resource_id: staff.id, metadata: { role: 'partner' } },
      ]);
    });

    it('treats revoking a role not held as done, without a record', async () => {
      expect((await as(adminToken).delete(`/staff/${staff.id}/roles/partner`)).status).toBe(204);
      expect(await eventsBy(admin.id)).toEqual([]);
    });

    it('can remove another administrator while one remains', async () => {
      const other = await staffWith('administrator');

      expect((await as(adminToken).delete(`/staff/${other.id}/roles/administrator`)).status).toBe(204);
      expect(await rolesOf(other.id)).toEqual([]);
    });

    it('refuses to let an administrator grant themselves a role', async () => {
      const response = await as(adminToken).put(`/staff/${admin.id}/roles/compliance`);

      expect(response.status).toBe(403);
      expect(await rolesOf(admin.id)).toEqual(['administrator']);
      expect((await as(adminToken).get('/staff')).status).toBe(200);
      expect(await eventsBy(admin.id)).toEqual([
        {
          action: 'staff.change_refused',
          resource_id: admin.id,
          metadata: { change: 'grant_role', role: 'compliance', reason: 'own_account' },
        },
      ]);
    });

    it('refuses to let an administrator remove their own role', async () => {
      expect((await as(adminToken).delete(`/staff/${admin.id}/roles/administrator`)).status).toBe(403);
      expect(await rolesOf(admin.id)).toEqual(['administrator']);
      expect(await eventsBy(admin.id)).toEqual([
        {
          action: 'staff.change_refused',
          resource_id: admin.id,
          metadata: { change: 'revoke_role', role: 'administrator', reason: 'own_account' },
        },
      ]);
    });

    it('refuses a role for a disabled account', async () => {
      const disabled = await createTestAccount(db, 'staff', { status: 'disabled' });

      expect((await as(adminToken).put(`/staff/${disabled.id}/roles/partner`)).status).toBe(409);
      expect(await rolesOf(disabled.id)).toEqual([]);
    });

    it.each(['put', 'delete'] as const)('does not find a client account (%s)', async (method) => {
      const client = await createTestAccount(db, 'client');

      expect((await as(adminToken)[method](`/staff/${client.id}/roles/partner`)).status).toBe(404);
    });

    it('does not find an account that does not exist', async () => {
      expect((await as(adminToken).put(`/staff/${randomUUID()}/roles/partner`)).status).toBe(404);
    });

    it.each([
      ['an id that is not a UUID', () => '/staff/1/roles/partner'],
      ['an unknown role', () => `/staff/${staff.id}/roles/superuser`],
    ])('refuses %s', async (_case, path) => {
      expect((await as(adminToken).put(path())).status).toBe(400);
      expect(await rolesOf(staff.id)).toEqual([]);
    });

    it.each(['partner', 'compliance'] as const)('is closed to a %s', async (role) => {
      const token = await signedIn(await staffWith(role));

      expect((await as(token).put(`/staff/${staff.id}/roles/fee_earner`)).status).toBe(403);
      expect((await as(token).delete(`/staff/${admin.id}/roles/administrator`)).status).toBe(403);
      expect(await rolesOf(staff.id)).toEqual([]);
      expect(await rolesOf(admin.id)).toEqual(['administrator']);
    });
  });

  it('records the network address and browser of every change', async () => {
    const staff = await staffWith('partner');
    const from = (call: request.Test) => call.set('X-Forwarded-For', '198.18.7.7').set('User-Agent', 'staff-admin-test');

    await from(as(adminToken).post('/staff/invitations', { email: `traced-${randomUUID()}@example.com`, displayName: 'T' }));
    await from(as(adminToken).put(`/staff/${staff.id}/roles/fee_earner`));
    await from(as(adminToken).delete(`/staff/${staff.id}/roles/partner`));
    await from(as(adminToken).put(`/staff/${admin.id}/roles/compliance`));
    await from(as(adminToken).post(`/staff/${staff.id}/disable`));
    await from(as(adminToken).post(`/staff/${staff.id}/enable`));

    const events = await db
      .selectFrom('audit_events')
      .select(['action', 'ip_address', 'user_agent'])
      .where('actor_id', '=', admin.id)
      .orderBy('id')
      .execute();
    expect(events).toEqual(
      [
        'account.invited',
        'staff.role_granted',
        'staff.role_revoked',
        'staff.change_refused',
        'staff.disabled',
        'staff.enabled',
        'account.invited',
      ].map(
        (action) => ({ action, ip_address: '198.18.7.7', user_agent: 'staff-admin-test' }),
      ),
    );
  });

  describe('POST /staff/:accountId/disable', () => {
    it('disables the account and signs it out everywhere', async () => {
      const staff = await staffWith('partner');
      const tokens = [await signedIn(staff), await signedIn(staff)];

      const response = await as(adminToken).post(`/staff/${staff.id}/disable`);

      expect(response.status).toBe(204);
      expect(await statusOf(staff.id)).toBe('disabled');
      for (const token of tokens) {
        expect((await as(token).get('/staff')).status).toBe(401);
      }
      expect(await eventsBy(admin.id)).toEqual([
        { action: 'staff.disabled', resource_id: staff.id, metadata: { sessionsEnded: 2 } },
      ]);
    });

    it('keeps the roles, as a record of what the account could do', async () => {
      const staff = await staffWith('partner');

      await as(adminToken).post(`/staff/${staff.id}/disable`);

      expect(await rolesOf(staff.id)).toEqual(['partner']);
    });

    it('stops an invited person from accepting their invitation', async () => {
      const email = `disabled.invitee-${randomUUID()}@example.com`;
      const invited = await as(adminToken).post('/staff/invitations', { email, displayName: 'Invitee' });
      const [invitation] = await waitForEmails(email, 1);
      const token = /#token=([A-Za-z0-9_-]{43})/.exec(invitation?.text ?? '')?.[1];

      await as(adminToken).post(`/staff/${invited.body.accountId}/disable`);

      const inspect = await request(app.getHttpServer()).post('/auth/invitations/inspect').send({ token });
      expect(inspect.status).toBe(404);
    });

    it('treats disabling a disabled account as done, without a second record', async () => {
      const staff = await staffWith();
      await as(adminToken).post(`/staff/${staff.id}/disable`);

      expect((await as(adminToken).post(`/staff/${staff.id}/disable`)).status).toBe(204);
      expect(await eventsBy(admin.id)).toHaveLength(1);
    });

    it('can disable another administrator while one remains', async () => {
      const other = await staffWith('administrator');

      expect((await as(adminToken).post(`/staff/${other.id}/disable`)).status).toBe(204);
      expect(await statusOf(other.id)).toBe('disabled');
    });

    it('refuses to let anyone disable themselves', async () => {
      expect((await as(adminToken).post(`/staff/${admin.id}/disable`)).status).toBe(403);
      expect(await statusOf(admin.id)).toBe('active');
      expect(await eventsBy(admin.id)).toEqual([
        { action: 'staff.change_refused', resource_id: admin.id, metadata: { change: 'disable', reason: 'own_account' } },
      ]);
    });

    it('does not find a client account', async () => {
      const client = await createTestAccount(db, 'client');

      expect((await as(adminToken).post(`/staff/${client.id}/disable`)).status).toBe(404);
      expect(await statusOf(client.id)).toBe('active');
    });

    it.each(['partner', 'compliance'] as const)('is closed to a %s', async (role) => {
      const staff = await staffWith();

      expect((await as(await signedIn(await staffWith(role))).post(`/staff/${staff.id}/disable`)).status).toBe(403);
      expect(await statusOf(staff.id)).toBe('active');
    });
  });

  describe('POST /staff/:accountId/enable', () => {
    async function disabledStaff(...roles: StaffRole[]): Promise<TestAccount> {
      const staff = await staffWith(...roles);
      await as(adminToken).post(`/staff/${staff.id}/disable`);
      return staff;
    }

    const passwordOf = (accountId: string) =>
      db
        .selectFrom('accounts')
        .select(['password_hash', 'password_changed_at'])
        .where('id', '=', accountId)
        .executeTakeFirstOrThrow();

    const tokenIn = (text: string | undefined) => /#token=([A-Za-z0-9_-]{43})/.exec(text ?? '')?.[1];
    const inspect = (token: string | undefined) =>
      request(app.getHttpServer()).post('/auth/invitations/inspect').send({ token });

    it('reopens the account as invited, removes its password and emails a new invitation', async () => {
      const staff = await disabledStaff();

      const response = await as(adminToken).post(`/staff/${staff.id}/enable`);

      expect(response.status).toBe(200);
      expect(Object.keys(response.body)).toEqual(['expiresAt']);
      expect(await statusOf(staff.id)).toBe('invited');
      expect(await passwordOf(staff.id)).toEqual({ password_hash: null, password_changed_at: null });
      const [invitation] = await waitForEmails(staff.email, 1);
      expect((await inspect(tokenIn(invitation?.text))).status).toBe(200);
      expect(
        await db.selectFrom('audit_events').select(['action', 'actor_id']).where('resource_id', '=', staff.id).orderBy('id').execute(),
      ).toEqual([
        { action: 'staff.disabled', actor_id: admin.id },
        { action: 'staff.enabled', actor_id: admin.id },
        { action: 'account.invited', actor_id: admin.id },
      ]);
    });

    it('lets the person back in with a new password and their existing authenticator app', async () => {
      const staff = await staffWith('partner');
      const secret = await enrolTwoFactor(app.get(TwoFactorService), staff, clock);
      await as(adminToken).post(`/staff/${staff.id}/disable`);

      await as(adminToken).post(`/staff/${staff.id}/enable`);

      const [invitation] = await waitForEmails(staff.email, 1);
      const token = tokenIn(invitation?.text);
      const server = request(app.getHttpServer());
      const passwordStep = await server.post('/auth/invitations/password').send({ token, password: 'tidy-otter-quartz-lantern' });
      expect(passwordStep.body).toEqual({ twoFactor: null });
      const complete = await server.post('/auth/invitations/complete').send({ token, code: authenticatorCode(secret, clock) });
      expect(complete.status).toBe(200);
      expect(await statusOf(staff.id)).toBe('active');
    });

    it('keeps the earlier sessions ended', async () => {
      const staff = await staffWith('partner');
      const token = await signedIn(staff);
      await as(adminToken).post(`/staff/${staff.id}/disable`);

      await as(adminToken).post(`/staff/${staff.id}/enable`);

      expect((await as(token).get('/staff')).status).toBe(401);
    });

    it('does not bring back an invitation sent before the account was disabled', async () => {
      const email = `reenabled.invitee-${randomUUID()}@example.com`;
      const invited = await as(adminToken).post('/staff/invitations', { email, displayName: 'Invitee' });
      const [first] = await waitForEmails(email, 1);
      await as(adminToken).post(`/staff/${invited.body.accountId}/disable`);

      await as(adminToken).post(`/staff/${invited.body.accountId}/enable`);

      const [, second] = await waitForEmails(email, 2);
      expect((await inspect(tokenIn(first?.text))).status).toBe(404);
      expect((await inspect(tokenIn(second?.text))).status).toBe(200);
    });

    it('closes the earlier invitation even when the new one cannot be sent', async () => {
      const email = `unsent.invitee-${randomUUID()}@example.com`;
      const invited = await as(adminToken).post('/staff/invitations', { email, displayName: 'Invitee' });
      const [first] = await waitForEmails(email, 1);
      await as(adminToken).post(`/staff/${invited.body.accountId}/disable`);
      vi.spyOn(app.get(InvitationsService), 'invite').mockRejectedValueOnce(new Error('mail server down'));

      expect((await as(adminToken).post(`/staff/${invited.body.accountId}/enable`)).status).toBe(500);

      expect(await statusOf(invited.body.accountId)).toBe('invited');
      expect((await inspect(tokenIn(first?.text))).status).toBe(404);
    });

    it('keeps the roles, which apply again once the invitation is accepted', async () => {
      const staff = await disabledStaff('partner');

      await as(adminToken).post(`/staff/${staff.id}/enable`);

      expect(await rolesOf(staff.id)).toEqual(['partner']);
    });

    it('refuses an account that is not disabled, and leaves its password alone', async () => {
      const staff = await staffWith();
      const before = await passwordOf(staff.id);

      const response = await as(adminToken).post(`/staff/${staff.id}/enable`);

      expect(response.status).toBe(409);
      expect(await statusOf(staff.id)).toBe('active');
      expect(await passwordOf(staff.id)).toEqual(before);
      expect(await eventsBy(admin.id)).toEqual([]);
    });

    it('refuses to let anyone enable themselves', async () => {
      expect((await as(adminToken).post(`/staff/${admin.id}/enable`)).status).toBe(403);
      expect(await eventsBy(admin.id)).toEqual([
        { action: 'staff.change_refused', resource_id: admin.id, metadata: { change: 'enable', reason: 'own_account' } },
      ]);
    });

    it('does not find a client account', async () => {
      const client = await createTestAccount(db, 'client', { status: 'disabled' });

      expect((await as(adminToken).post(`/staff/${client.id}/enable`)).status).toBe(404);
      expect(await statusOf(client.id)).toBe('disabled');
    });

    it.each(['partner', 'compliance'] as const)('is closed to a %s', async (role) => {
      const staff = await disabledStaff();

      expect((await as(await signedIn(await staffWith(role))).post(`/staff/${staff.id}/enable`)).status).toBe(403);
      expect(await statusOf(staff.id)).toBe('disabled');
    });
  });
});
