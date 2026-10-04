import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, setAccountStatus, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { testAppDatabaseUrl } from '../../test/database.js';
import { RolesService } from '../auth/permissions/roles.service.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { createDatabase } from '../database/database.js';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import { StaffModule } from './staff.module.js';
import { StaffService, type StaffActor } from './staff.service.js';

/*
 * "At least one active administrator" and "at least one active compliance
 * holder" are rules about the whole database, so these tests run on their own,
 * after every other test file (see vitest.config.ts). Each test starts by
 * revoking every administrator role in the test database.
 */

const PROTECTED_ROLE_LOCK = sql`hashtextextended('app.protected_roles', 0)`;

describe('The last active holder of a protected role', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let staffService: StaffService;
  let rolesService: RolesService;
  let sessions: SessionsService;
  let first: TestAccount;
  let second: TestAccount;

  const refusalsBy = (account: TestAccount) =>
    db
      .selectFrom('audit_events')
      .select(['action', 'outcome', 'resource_id', 'metadata'])
      .where('actor_id', '=', account.id)
      .where('action', '=', 'staff.change_refused')
      .execute();

  const actor = (account: TestAccount): StaffActor => ({ actor: { type: 'user', id: account.id }, accountId: account.id });

  const activeAdministrators = async () =>
    (
      await db
        .selectFrom('account_roles')
        .innerJoin('accounts', 'accounts.id', 'account_roles.account_id')
        .select('accounts.id')
        .where('account_roles.role', '=', 'administrator')
        .where('account_roles.revoked_at', 'is', null)
        .where('accounts.status', '=', 'active')
        .execute()
    ).map((row) => row.id);

  async function administrator(): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    await grantTestRole(db, account.id, 'administrator');
    return account;
  }

  beforeAll(async () => {
    app = await createTestApp(StaffModule);
    db = app.get(DATABASE);
    staffService = app.get(StaffService);
    rolesService = app.get(RolesService);
    sessions = app.get(SessionsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db
      .updateTable('account_roles')
      .set({ revoked_at: new Date() })
      .where('role', '=', 'administrator')
      .where('revoked_at', 'is', null)
      .execute();
    first = await administrator();
    second = await administrator();
  });

  it('starts each test with exactly two active administrators', async () => {
    expect((await activeAdministrators()).sort()).toEqual([first.id, second.id].sort());
  });

  describe('with one administrator left', () => {
    let someoneElse: TestAccount;

    beforeEach(async () => {
      await staffService.revokeRole(second.id, 'administrator', actor(first));
      someoneElse = await createTestAccount(db, 'staff');
    });

    it('refuses to revoke their administrator role, and records the refusal', async () => {
      expect(await staffService.revokeRole(first.id, 'administrator', actor(someoneElse))).toBe('last_administrator');
      expect(await activeAdministrators()).toEqual([first.id]);
      expect(await refusalsBy(someoneElse)).toEqual([
        {
          action: 'staff.change_refused',
          outcome: 'denied',
          resource_id: first.id,
          metadata: { change: 'revoke_role', role: 'administrator', reason: 'last_administrator' },
        },
      ]);
    });

    it('refuses to disable them, and records the refusal', async () => {
      expect(await staffService.disable(first.id, actor(someoneElse))).toBe('last_administrator');
      expect(await activeAdministrators()).toEqual([first.id]);
      expect(await refusalsBy(someoneElse)).toEqual([
        {
          action: 'staff.change_refused',
          outcome: 'denied',
          resource_id: first.id,
          metadata: { change: 'disable', reason: 'last_administrator' },
        },
      ]);
    });

    it('still lets their other roles be revoked', async () => {
      await grantTestRole(db, first.id, 'partner');

      expect(await rolesService.revoke(first.id, 'partner', actor(someoneElse))).toBe('revoked');
    });

    it('does not count an invited administrator, who cannot sign in yet', async () => {
      const invited = await createTestAccount(db, 'staff', { status: 'invited' });
      await grantTestRole(db, invited.id, 'administrator');

      expect(await staffService.disable(first.id, actor(someoneElse))).toBe('last_administrator');
    });

    it('does not count a disabled administrator', async () => {
      const disabled = await administrator();
      await setAccountStatus(db, disabled.id, 'disabled');

      expect(await rolesService.revoke(first.id, 'administrator', actor(someoneElse))).toBe('last_administrator');
    });
  });

  describe('with one compliance holder left', () => {
    let complianceHolder: TestAccount;

    const complianceHolders = async () =>
      (
        await db
          .selectFrom('account_roles')
          .innerJoin('accounts', 'accounts.id', 'account_roles.account_id')
          .select('accounts.id')
          .where('account_roles.role', '=', 'compliance')
          .where('account_roles.revoked_at', 'is', null)
          .where('accounts.status', '=', 'active')
          .execute()
      ).map((row) => row.id);

    beforeEach(async () => {
      await db
        .updateTable('account_roles')
        .set({ revoked_at: new Date() })
        .where('role', '=', 'compliance')
        .where('revoked_at', 'is', null)
        .execute();
      complianceHolder = await createTestAccount(db, 'staff');
      await grantTestRole(db, complianceHolder.id, 'compliance');
    });

    it('refuses to revoke their compliance role, and records the refusal', async () => {
      expect(await staffService.revokeRole(complianceHolder.id, 'compliance', actor(first))).toBe('last_compliance');
      expect(await complianceHolders()).toEqual([complianceHolder.id]);
      expect(await refusalsBy(first)).toEqual([
        {
          action: 'staff.change_refused',
          outcome: 'denied',
          resource_id: complianceHolder.id,
          metadata: { change: 'revoke_role', role: 'compliance', reason: 'last_compliance' },
        },
      ]);
    });

    it('refuses to disable them, and records the refusal', async () => {
      expect(await staffService.disable(complianceHolder.id, actor(first))).toBe('last_compliance');
      expect(await complianceHolders()).toEqual([complianceHolder.id]);
      expect(await refusalsBy(first)).toEqual([
        {
          action: 'staff.change_refused',
          outcome: 'denied',
          resource_id: complianceHolder.id,
          metadata: { change: 'disable', reason: 'last_compliance' },
        },
      ]);
    });

    it('answers 409 over the API, naming the role', async () => {
      const token = await sessions.start(first, 'authenticated', {});

      const response = await request(app.getHttpServer())
        .delete(`/staff/${complianceHolder.id}/roles/compliance`)
        .set('Cookie', `__Host-session=${token}`);

      expect(response.status).toBe(409);
      expect(response.body.message).toBe('The firm must keep at least one active compliance holder');
    });

    it('lets them go once another active holder exists', async () => {
      const successor = await createTestAccount(db, 'staff');
      await grantTestRole(db, successor.id, 'compliance');

      expect(await staffService.revokeRole(complianceHolder.id, 'compliance', actor(first))).toBe('revoked');
      expect(await complianceHolders()).toEqual([successor.id]);
    });

    it('does not count an invited compliance holder', async () => {
      const invited = await createTestAccount(db, 'staff', { status: 'invited' });
      await grantTestRole(db, invited.id, 'compliance');

      expect(await staffService.disable(complianceHolder.id, actor(first))).toBe('last_compliance');
    });

    it('answers not held, not refused, for someone without the role', async () => {
      const someoneElse = await createTestAccount(db, 'staff');

      expect(await rolesService.revoke(someoneElse.id, 'compliance', actor(first))).toBe('not_held');
    });
  });

  /*
   * Over the API the only way to reach the last administrator is a race: two
   * administrators removing each other at the same moment. Holding the lock
   * makes the race happen every time: both requests pass the permission check,
   * queue on the lock, and run one after the other once it is released.
   */
  it('lets only one of two administrators removing each other succeed', async () => {
    const holder = createDatabase<Database>(testAppDatabaseUrl(), 1);
    try {
      const server = request(app.getHttpServer());
      const firstToken = await sessions.start(first, 'authenticated', {});
      const secondToken = await sessions.start(second, 'authenticated', {});
      await sql`select pg_advisory_lock(${PROTECTED_ROLE_LOCK})`.execute(holder);

      const revoke = server
        .delete(`/staff/${second.id}/roles/administrator`)
        .set('Cookie', `__Host-session=${firstToken}`)
        .then((response) => response);
      const disable = server
        .post(`/staff/${first.id}/disable`)
        .set('Cookie', `__Host-session=${secondToken}`)
        .then((response) => response);

      await expect
        .poll(async () => {
          const { rows } = await sql<{ waiting: string }>`
            select count(*) as waiting from pg_locks where locktype = 'advisory' and not granted`.execute(holder);
          return Number(rows[0]?.waiting);
        })
        .toBe(2);
      await sql`select pg_advisory_unlock(${PROTECTED_ROLE_LOCK})`.execute(holder);

      const statuses = [(await revoke).status, (await disable).status].sort();
      expect(statuses).toEqual([204, 409]);
      expect(await activeAdministrators()).toHaveLength(1);
      const refused = (await revoke).status === 409 ? await revoke : await disable;
      expect(refused.body.message).toBe('The firm must keep at least one active administrator');
    } finally {
      await holder.destroy();
    }
  });
});
