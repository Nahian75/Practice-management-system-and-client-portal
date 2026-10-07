import { Test } from '@nestjs/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { testEnv } from '../../test/database.js';
import type { AuditEvent } from '../audit/audit-event.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { ConfigModule } from '../config/config.module.js';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import { StaffModule } from './staff.module.js';
import { StaffService, type StaffActor } from './staff.service.js';

class AuditUnavailableError extends Error {}

/** Stands in for the audit log: remembers each call, and can be made to fail. */
class FakeAudit {
  failing = false;
  calls: { action: string; inTransaction: boolean }[] = [];

  async record(event: AuditEvent, transaction?: Kysely<Database>): Promise<void> {
    this.calls.push({ action: event.action, inTransaction: transaction?.isTransaction === true });
    if (this.failing) {
      throw new AuditUnavailableError();
    }
  }
}

/** A change to staff accounts must never happen without its audit record. */
describe('Auditing staff changes', () => {
  const audit = new FakeAudit();
  let staffService: StaffService;
  let sessions: SessionsService;
  let db: Kysely<Database>;
  let close: () => Promise<void>;
  let staff: TestAccount;
  let by: StaffActor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot(testEnv()), StaffModule] })
      .overrideProvider(AuditService)
      .useValue(audit)
      .compile();
    await moduleRef.init();
    staffService = moduleRef.get(StaffService);
    sessions = moduleRef.get(SessionsService);
    db = moduleRef.get(DATABASE);
    close = () => moduleRef.close();
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    audit.failing = false;
    audit.calls = [];
    const admin = await createTestAccount(db, 'staff');
    await grantTestRole(db, admin.id, 'administrator');
    staff = await createTestAccount(db, 'staff');
    by = { actor: { type: 'user', id: admin.id }, accountId: admin.id };
  });

  const roles = async (accountId: string) =>
    (
      await db.selectFrom('account_roles').select('role').where('account_id', '=', accountId).where('revoked_at', 'is', null).execute()
    ).map((row) => row.role);

  describe('records each change in the same transaction as the change', () => {
    it('granting a role', async () => {
      await staffService.grantRole(staff.id, 'partner', by);

      expect(audit.calls).toEqual([
        { action: 'staff.role_granted', inTransaction: true },
        { action: 'email.queued', inTransaction: true },
      ]);
    });

    it('revoking a role', async () => {
      await grantTestRole(db, staff.id, 'partner');

      await staffService.revokeRole(staff.id, 'partner', by);

      expect(audit.calls).toEqual([
        { action: 'staff.role_revoked', inTransaction: true },
        { action: 'email.queued', inTransaction: true },
      ]);
    });

    it('disabling an account', async () => {
      await staffService.disable(staff.id, by);

      expect(audit.calls).toEqual([{ action: 'staff.disabled', inTransaction: true }]);
    });
  });

  describe('when the audit record cannot be written', () => {
    beforeEach(() => {
      audit.failing = true;
    });

    it('does not grant the role', async () => {
      await expect(staffService.grantRole(staff.id, 'partner', by)).rejects.toThrow(AuditUnavailableError);
      expect(await roles(staff.id)).toEqual([]);
    });

    it('does not revoke the role', async () => {
      await grantTestRole(db, staff.id, 'partner');

      await expect(staffService.revokeRole(staff.id, 'partner', by)).rejects.toThrow(AuditUnavailableError);
      expect(await roles(staff.id)).toEqual(['partner']);
    });

    it('does not disable the account or end its sessions', async () => {
      const token = await sessions.start(staff, 'authenticated', {});

      await expect(staffService.disable(staff.id, by)).rejects.toThrow(AuditUnavailableError);
      const { status } = await db.selectFrom('accounts').select('status').where('id', '=', staff.id).executeTakeFirstOrThrow();
      expect(status).toBe('active');
      expect(await sessions.resolve(token)).toBeDefined();
    });
  });
});
