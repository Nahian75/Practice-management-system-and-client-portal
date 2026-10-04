import { Test } from '@nestjs/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../../test/accounts.js';
import { testEnv, testOwnerDatabaseUrl } from '../../../test/database.js';
import { ConfigModule } from '../../config/config.module.js';
import { createDatabase } from '../../database/database.js';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/schema.js';
import { AuthModule } from '../auth.module.js';
import { OwnRoleChangeError, RolesService } from './roles.service.js';

describe('Roles', () => {
  let roles: RolesService;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let close: () => Promise<void>;
  let admin: TestAccount;
  let staff: TestAccount;

  const byAdmin = () => ({ actor: { type: 'user' as const, id: admin.id }, accountId: admin.id });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot(testEnv()), AuthModule] }).compile();
    await moduleRef.init();
    roles = moduleRef.get(RolesService);
    db = moduleRef.get(DATABASE);
    ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 1);
    close = () => moduleRef.close();
  });

  afterAll(async () => {
    await ownerDb.destroy();
    await close();
  });

  beforeEach(async () => {
    admin = await createTestAccount(db, 'staff');
    await grantTestRole(db, admin.id, 'administrator');
    staff = await createTestAccount(db, 'staff');
  });

  describe('granting', () => {
    it('grants a role and records who granted it', async () => {
      await roles.grant(staff.id, 'partner', byAdmin());

      expect(await roles.activeRoles(staff.id)).toEqual(['partner']);
      const row = await db.selectFrom('account_roles').selectAll().where('account_id', '=', staff.id).executeTakeFirstOrThrow();
      expect(row.granted_by).toBe(admin.id);
      const event = await db.selectFrom('audit_events').select(['action', 'metadata', 'resource_id']).where('actor_id', '=', admin.id).executeTakeFirstOrThrow();
      expect(event).toEqual({ action: 'staff.role_granted', metadata: { role: 'partner' }, resource_id: staff.id });
    });

    it('treats granting a role already held as done, without a second record', async () => {
      await roles.grant(staff.id, 'partner', byAdmin());
      await roles.grant(staff.id, 'partner', byAdmin());

      const rows = await db.selectFrom('account_roles').select('id').where('account_id', '=', staff.id).execute();
      const events = await db.selectFrom('audit_events').select('id').where('actor_id', '=', admin.id).execute();
      expect(rows).toHaveLength(1);
      expect(events).toHaveLength(1);
    });

    it('refuses to let anyone grant themselves a role', async () => {
      await expect(roles.grant(admin.id, 'compliance', byAdmin())).rejects.toThrow(OwnRoleChangeError);
      expect(await roles.activeRoles(admin.id)).toEqual(['administrator']);
    });

    it('allows the system (command line) to grant the first administrator', async () => {
      await roles.grant(staff.id, 'administrator', { actor: { type: 'system' }, accountId: null });

      expect(await roles.activeRoles(staff.id)).toEqual(['administrator']);
    });
  });

  describe('database rules', () => {
    it('refuses roles for client accounts', async () => {
      const client = await createTestAccount(db, 'client');

      await expect(grantTestRole(db, client.id, 'partner')).rejects.toThrow(/only staff accounts can hold roles/);
    });

    it('refuses a self-granted role even if the code check were bypassed', async () => {
      await expect(
        db.insertInto('account_roles').values({ account_id: staff.id, role: 'compliance', granted_by: staff.id, granted_at: new Date() }).execute(),
      ).rejects.toThrow(/account_roles_not_self_granted/);
    });

    it('refuses an unknown role', async () => {
      await expect(
        sql`insert into account_roles (account_id, role, granted_at) values (${staff.id}, 'superuser', now())`.execute(db),
      ).rejects.toThrow(/account_roles_role_valid/);
    });

    it('keeps a revoked role revoked, even for the table owner', async () => {
      await grantTestRole(db, staff.id, 'partner');
      await db.updateTable('account_roles').set({ revoked_at: new Date(), revoked_by: admin.id }).where('account_id', '=', staff.id).execute();

      await expect(
        sql`update app.account_roles set revoked_at = null, revoked_by = null where account_id = ${staff.id}`.execute(ownerDb),
      ).rejects.toThrow(/is revoked and cannot change/);
    });

    it('does not let the app delete role history', async () => {
      await grantTestRole(db, staff.id, 'partner');

      await expect(sql`delete from account_roles where account_id = ${staff.id}`.execute(db)).rejects.toThrow(/permission denied/);
    });

    it('does not let the app move a role to another account', async () => {
      await grantTestRole(db, staff.id, 'partner');

      await expect(
        sql`update account_roles set account_id = ${admin.id} where account_id = ${staff.id}`.execute(db),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
