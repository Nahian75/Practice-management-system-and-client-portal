import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, setAccountStatus, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl } from '../../test/database.js';
import { permissionsFor, STAFF_ROLES } from '../auth/permissions/permissions.js';
import { createDatabase } from '../database/database.js';
import type { Database, MatterTeamRole, StaffRole } from '../database/schema.js';

describe('matters tables', () => {
  let db: Kysely<Database>;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let client: { id: string; reference: string };

  async function staffWith(...roles: StaffRole[]): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) {
      await grantTestRole(db, account.id, role);
    }
    return account;
  }

  const createClient = (createdBy: string, executor: Kysely<Database> = db) =>
    executor.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto('clients')
        .values({ kind: 'individual', created_by: createdBy })
        .returning(['id', 'reference'])
        .executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({ client_id: created.id, given_names: 'Jane', family_name: 'Doe' }).execute();
      return created;
    });

  /** Opens a matter with the given team in one transaction, as the app does. */
  const openMatter = (
    team: [string, MatterTeamRole][] = [[partner.id, 'supervising_partner']],
    overrides: { clientId?: string; title?: string; openedBy?: string } = {},
    executor: Kysely<Database> = db,
  ) =>
    executor.transaction().execute(async (trx) => {
      const matter = await trx
        .insertInto('matters')
        .values({
          client_id: overrides.clientId ?? client.id,
          title: overrides.title ?? 'Purchase of 12 High Street',
          matter_type: 'residential_property',
          opened_by: overrides.openedBy ?? feeEarner.id,
        })
        .returning(['id', 'number', 'reference', 'status'])
        .executeTakeFirstOrThrow();
      for (const [accountId, role] of team) {
        await trx.insertInto('matter_team').values({ matter_id: matter.id, account_id: accountId, role, added_by: feeEarner.id }).execute();
      }
      return matter;
    });

  beforeAll(async () => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 1);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    partner = await staffWith('partner');
    feeEarner = await staffWith('fee_earner');
    client = await createClient(feeEarner.id);
  });

  describe('numbering', () => {
    it("numbers each client's matters from 1, with the client's reference", async () => {
      const first = await openMatter();
      const second = await openMatter();
      const otherClient = await createClient(feeEarner.id);
      const elsewhere = await openMatter(undefined, { clientId: otherClient.id });

      expect([first.number, second.number, elsewhere.number]).toEqual([1, 2, 1]);
      expect(first.reference).toBe(`${client.reference}/001`);
      expect(second.reference).toBe(`${client.reference}/002`);
      expect(elsewhere.reference).toBe(`${otherClient.reference}/001`);
      expect(first.status).toBe('open');
    });

    it('gives ten matters opened at the same moment for one client ten different numbers', async () => {
      const pool = createDatabase<Database>(testAppDatabaseUrl(), 10);
      try {
        const matters = await Promise.all(Array.from({ length: 10 }, () => openMatter(undefined, {}, pool)));

        expect(matters.map((matter) => matter.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      } finally {
        await pool.destroy();
      }
    });
  });

  describe('opening', () => {
    it('refuses a matter without a supervising partner, when the transaction commits', async () => {
      await expect(openMatter([[feeEarner.id, 'fee_earner']])).rejects.toThrow(/has no supervising partner/);
    });

    it('refuses a matter opened by a client account', async () => {
      const clientAccount = await createTestAccount(db, 'client');

      await expect(openMatter(undefined, { openedBy: clientAccount.id })).rejects.toThrow(/opened by staff accounts/);
    });

    it('refuses a title with a line break', async () => {
      await expect(openMatter(undefined, { title: 'Purchase\nof a house' })).rejects.toThrow(/matters_title_safe/);
    });

    it('does not let the app choose the number, reference or status', async () => {
      await expect(
        sql`insert into matters (client_id, title, matter_type, opened_by, number, reference, status)
            values (${client.id}, 'T', 'other', ${feeEarner.id}, 99, 'X', 'open')`.execute(db),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('team', () => {
    it.each<[string, () => Promise<TestAccount>, MatterTeamRole, RegExp]>([
      ['a fee earner as supervising partner', () => staffWith('fee_earner'), 'supervising_partner', /must hold a role/],
      ['someone from accounts as fee earner', () => staffWith('accounts'), 'fee_earner', /must hold a role/],
      ['a disabled partner', async () => {
        const account = await staffWith('partner');
        await setAccountStatus(db, account.id, 'disabled');
        return account;
      }, 'supervising_partner', /active staff accounts/],
      ['a client account', () => createTestAccount(db, 'client'), 'fee_earner', /active staff accounts/],
    ])('refuses %s', async (_case, makeAccount, role) => {
      const account = await makeAccount();
      const team: [string, MatterTeamRole][] =
        role === 'supervising_partner' ? [[account.id, role]] : [[partner.id, 'supervising_partner'], [account.id, role]];

      await expect(openMatter(team)).rejects.toThrow();
    });

    it('refuses two supervising partners', async () => {
      const other = await staffWith('partner');

      await expect(
        openMatter([
          [partner.id, 'supervising_partner'],
          [other.id, 'supervising_partner'],
        ]),
      ).rejects.toThrow(/matter_team_one_supervising_partner/);
    });

    it('refuses the same person twice', async () => {
      await expect(
        openMatter([
          [partner.id, 'supervising_partner'],
          [partner.id, 'fee_earner'],
        ]),
      ).rejects.toThrow(/matter_team_one_active_membership/);
    });

    // The trigger keeps its own role lists; this keeps them in step with permissions.ts.
    it.each(STAFF_ROLES)('agrees with the permission table about a %s', async (role) => {
      const member = await staffWith(role);

      const asFeeEarner = openMatter([
        [partner.id, 'supervising_partner'],
        [member.id, 'fee_earner'],
      ]);
      const asSupervisor = openMatter([[member.id, 'supervising_partner']]);

      if (permissionsFor([role]).has('matters.view')) {
        await expect(asFeeEarner).resolves.toBeDefined();
      } else {
        await expect(asFeeEarner).rejects.toThrow(/must hold a role/);
      }
      if (role === 'partner') {
        await expect(asSupervisor).resolves.toBeDefined();
      } else {
        await expect(asSupervisor).rejects.toThrow(/must hold a role/);
      }
    });
  });

  describe('app role restrictions', () => {
    let matterId: string;

    beforeEach(async () => {
      matterId = (await openMatter()).id;
    });

    it.each([
      ['change the status', (id: string) => sql`update matters set status = 'closed' where id = ${id}`],
      ['move a matter to another client', (id: string) => sql`update matters set client_id = client_id where id = ${id}`],
      ['change the reference', (id: string) => sql`update matters set reference = 'X' where id = ${id}`],
      ['delete a matter', (id: string) => sql`delete from matters where id = ${id}`],
      ['change a team role', (id: string) => sql`update matter_team set role = 'fee_earner' where matter_id = ${id}`],
      ['delete a team member', (id: string) => sql`delete from matter_team where matter_id = ${id}`],
    ])('may not %s', async (_case, statement) => {
      await expect(statement(matterId).execute(db)).rejects.toThrow(/permission denied/);
    });
  });
});
