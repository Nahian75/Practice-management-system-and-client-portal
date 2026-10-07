import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, revokeTestRole, setAccountStatus, type TestAccount } from '../../test/accounts.js';
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

  /** A name no other test uses, so a conflict check for it finds nothing unless a test adds a match. */
  const uniqueName = () => randomUUID().replaceAll('-', '').slice(0, 16);

  const createClient = (createdBy: string, executor: Kysely<Database> = db) =>
    executor.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto('clients')
        .values({ kind: 'individual', created_by: createdBy })
        .returning(['id', 'reference'])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('client_individuals')
        .values({ client_id: created.id, given_names: uniqueName(), family_name: uniqueName() })
        .execute();
      return created;
    });

  const runCheck = (trx: Kysely<Database>, clientId: string, requestedBy: string, names: string[] = []) =>
    trx
      .insertInto('conflict_checks')
      .values({ client_id: clientId, requested_by: requestedBy, names })
      .returning(['id', 'names', 'matches'])
      .executeTakeFirstOrThrow();

  /** Runs a conflict check and opens a matter on it, with the given team, in one transaction, as the app does. */
  const openMatter = (
    team: [string, MatterTeamRole][] = [[partner.id, 'supervising_partner']],
    overrides: { clientId?: string; title?: string; openedBy?: string; checkNames?: string[] } = {},
    executor: Kysely<Database> = db,
  ) =>
    executor.transaction().execute(async (trx) => {
      const clientId = overrides.clientId ?? client.id;
      const openedBy = overrides.openedBy ?? feeEarner.id;
      const check = await runCheck(trx, clientId, openedBy, overrides.checkNames);
      const matter = await trx
        .insertInto('matters')
        .values({
          client_id: clientId,
          title: overrides.title ?? 'Purchase of 12 High Street',
          matter_type: 'residential_property',
          opened_by: openedBy,
          conflict_check_id: check.id,
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

  describe('conflict checks', () => {
    const check = (names: string[], clientId = client.id, requestedBy = feeEarner.id) =>
      db.transaction().execute((trx) => runCheck(trx, clientId, requestedBy, names));

    async function clientNamed(givenNames: string, familyName: string) {
      return db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto('clients')
          .values({ kind: 'individual', created_by: feeEarner.id })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx.insertInto('client_individuals').values({ client_id: created.id, given_names: givenNames, family_name: familyName }).execute();
        return created.id;
      });
    }

    it("adds the client's own name, and does not report the client against itself", async () => {
      const result = await check([]);

      expect(result.names).toHaveLength(1);
      expect(result.matches).toEqual([]);
    });

    it('finds a client whose name is spelt differently', async () => {
      const token = uniqueName();
      const existing = await clientNamed(`John ${token}`, 'Smith');

      const result = await check([`Jon ${token} Smyth`]);

      expect(result.matches).toContainEqual(
        expect.objectContaining({ relation: 'client', clientId: existing, matterId: null, checkedName: `Jon ${token} Smyth` }),
      );
    });

    it('finds the opponent on another matter, ignoring accents and punctuation', async () => {
      const opponent = `Zoë O'Brien-${uniqueName()}`;
      const matterId = (await openMatter(undefined, { checkNames: [opponent] })).id;
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('matter_parties')
          .values({ matter_id: matterId, role: 'opponent', kind: 'individual', name: opponent, added_by: feeEarner.id })
          .execute();
      });
      const otherClient = await createClient(feeEarner.id);

      const result = await check([opponent.normalize('NFD').replace(/[^A-Za-z0-9 ]/g, ' ')], otherClient.id);

      expect(result.matches).toContainEqual(expect.objectContaining({ relation: 'opponent', clientId: client.id, matterId }));
    });

    it('finds a short stored name inside a longer checked name, through the indexed search (review M1)', async () => {
      const token = uniqueName();
      const existing = await clientNamed(token, 'Ng');

      const result = await check([`${token} Ng Trading International`]);

      expect(result.matches).toContainEqual(expect.objectContaining({ relation: 'client', clientId: existing }));
    });

    // The indexed search must find exactly what comparing every name in full would (review M1).
    it('finds the same matches as comparing every stored name in full', async () => {
      const token = uniqueName();
      await clientNamed(`Jane ${token}`, 'Doe');
      await clientNamed(`Acme ${token}`, 'Trading Ltd');
      const names = [`Jane ${token} Doe`, `Acme ${token} Trading Ltd`];

      expect((await check(names)).matches.length).toBeGreaterThan(0);
      // One snapshot for every count: other test files add similar names while this runs.
      const { indexed, full, missed } = await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx) => {
          const { rows: [found] } = await sql<{ total: string }>`
            select (app.find_possible_conflicts(${names}::text[], ${client.id}) ->> 'total') as total`.execute(trx);
          // The same settings as the function, for its index condition below.
          await sql`set local pg_trgm.similarity_threshold = 0.1`.execute(trx);
          await sql`set local pg_trgm.word_similarity_threshold = 0.8`.execute(trx);
          const { rows } = await sql<{ checked: string; name: string; indexable: boolean }>`
            select checked, k.name,
                   app.normalise_name(k.name) operator(extensions.%) app.normalise_name(checked)
                     or app.normalise_name(k.name) operator(extensions.%>) app.normalise_name(checked) as indexable
            from unnest(${names}::text[]) as checked
            cross join lateral (
              select i.client_id, i.given_names || ' ' || i.family_name as name, 'client' as relation from client_individuals i
              union all select o.client_id, o.legal_name, 'client' from client_organisations o
              union all select c.client_id, c.given_names || ' ' || c.family_name, 'contact' from client_contacts c
              union all select m.client_id, p.name, 'party' from matter_parties p join matters m on m.id = p.matter_id
            ) k
            where app.name_likeness(app.normalise_name(checked), app.normalise_name(k.name)) >= 0.3
              and not (k.client_id = ${client.id} and k.relation in ('client', 'contact'))`.execute(trx);
          return {
            indexed: Number(found?.total),
            full: rows.length,
            missed: rows.filter((row) => !row.indexable).map(({ checked, name }) => ({ checked, name })),
          };
        });

      // A name here is one the index condition skips although it is a possible conflict.
      expect(missed).toEqual([]);
      expect(indexed).toBe(full);
    });

    it('opens the matter as awaiting clearance when the check found a possible match', async () => {
      const token = uniqueName();
      await clientNamed(token, 'Existing');

      expect((await openMatter(undefined, { checkNames: [`${token} Existing`] })).status).toBe('awaiting_clearance');
    });

    it.each([
      ['write the matches itself', () =>
        sql`insert into conflict_checks (client_id, requested_by, names, matches) values (${client.id}, ${feeEarner.id}, '{}', '[]')`],
      ['change a check', () => sql`update conflict_checks set matches = '[]' where client_id = ${client.id}`],
      ['delete a check', () => sql`delete from conflict_checks where client_id = ${client.id}`],
    ])('does not let the app %s', async (_case, statement) => {
      await check([]);

      await expect(statement().execute(db)).rejects.toThrow(/permission denied/);
    });

    it.each<[string, () => Promise<{ clientId: string; openedBy: string }>]>([
      ['for another client', async () => ({ clientId: (await createClient(feeEarner.id)).id, openedBy: feeEarner.id })],
      ['by someone else', async () => ({ clientId: client.id, openedBy: (await staffWith('fee_earner')).id })],
    ])('refuses a matter opened on a check made %s', async (_case, opening) => {
      const { id: checkId } = await check([]);
      const { clientId, openedBy } = await opening();

      await expect(
        db
          .insertInto('matters')
          .values({ client_id: clientId, title: 'T', matter_type: 'other', opened_by: openedBy, conflict_check_id: checkId })
          .execute(),
      ).rejects.toThrow(/needs a conflict check/);
    });

    it('refuses a second matter on the same check', async () => {
      const first = await openMatter();
      const { conflict_check_id: checkId } = await db
        .selectFrom('matters')
        .select('conflict_check_id')
        .where('id', '=', first.id)
        .executeTakeFirstOrThrow();

      await expect(
        db
          .insertInto('matters')
          .values({ client_id: client.id, title: 'T', matter_type: 'other', opened_by: feeEarner.id, conflict_check_id: checkId })
          .execute(),
      ).rejects.toThrow(/matters_conflict_check_key/);
    });

    it('refuses a party who was not in the check, and accepts one who was, however written', async () => {
      const checked = `Mary-Ann O'Neil ${uniqueName()}`;
      const matterId = (await openMatter(undefined, { checkNames: [checked] })).id;
      const addParty = (name: string) =>
        db
          .insertInto('matter_parties')
          .values({ matter_id: matterId, role: 'opponent', kind: 'individual', name, added_by: feeEarner.id })
          .execute();

      await expect(addParty(`Someone ${uniqueName()}`)).rejects.toThrow(/was not in the matter's conflict check/);
      await expect(addParty(checked.toUpperCase().replace("'", ''))).resolves.toBeDefined();
    });
  });

  describe('conflict clearance', () => {
    let matterId: string;

    const statusOf = async (id: string) =>
      (await db.selectFrom('matters').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;
    const clear = (clearedBy: string, reason = 'Different person: other date of birth and address') =>
      db.insertInto('conflict_clearances').values({ matter_id: matterId, cleared_by: clearedBy, reason }).returning('id').executeTakeFirstOrThrow();

    beforeEach(async () => {
      const token = uniqueName();
      await db.transaction().execute(async (trx) => {
        const created = await trx.insertInto('clients').values({ kind: 'individual', created_by: feeEarner.id }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('client_individuals').values({ client_id: created.id, given_names: token, family_name: 'Existing' }).execute();
      });
      const matter = await openMatter(
        [
          [partner.id, 'supervising_partner'],
          [feeEarner.id, 'fee_earner'],
        ],
        { checkNames: [`${token} Existing`] },
      );
      matterId = matter.id;
      expect(matter.status).toBe('awaiting_clearance');
    });

    it('opens the matter when its supervising partner records a clearance', async () => {
      await clear(partner.id);

      expect(await statusOf(matterId)).toBe('open');
    });

    it.each<[string, () => Promise<string>]>([
      ['a fee earner on the team', async () => feeEarner.id],
      ['a partner not on the team', async () => (await staffWith('partner')).id],
      ['the supervising partner after losing the partner role', async () => {
        await revokeTestRole(db, partner.id, 'partner');
        return partner.id;
      }],
    ])('refuses a clearance by %s', async (_case, clearer) => {
      await expect(clear(await clearer())).rejects.toThrow(/only by the matter's active supervising partner/);
      expect(await statusOf(matterId)).toBe('awaiting_clearance');
    });

    it('refuses a second clearance, and one for a matter that is already open', async () => {
      await clear(partner.id);

      await expect(clear(partner.id)).rejects.toThrow(/not awaiting conflict clearance/);
      const openMatterId = (await openMatter()).id;
      await expect(
        db.insertInto('conflict_clearances').values({ matter_id: openMatterId, cleared_by: partner.id, reason: 'Nothing to clear here' }).execute(),
      ).rejects.toThrow(/not awaiting conflict clearance/);
    });

    it('refuses a short reason', async () => {
      await expect(clear(partner.id, 'fine')).rejects.toThrow(/violates check constraint/);
    });

    it('keeps every clearance as it was', async () => {
      const { id } = await clear(partner.id);

      await expect(sql`update conflict_clearances set reason = 'Rewritten afterwards' where id = ${id}`.execute(db)).rejects.toThrow(/permission denied/);
      await expect(sql`delete from conflict_clearances where id = ${id}`.execute(db)).rejects.toThrow(/permission denied/);
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

  describe('team changes (step 8d)', () => {
    let matterId: string;

    const membership = (accountId: string) =>
      db
        .selectFrom('matter_team')
        .select(['id', 'role'])
        .where('matter_id', '=', matterId)
        .where('account_id', '=', accountId)
        .where('removed_at', 'is', null)
        .executeTakeFirstOrThrow();
    const end = (id: string, executor: Kysely<Database> = db) =>
      executor.updateTable('matter_team').set({ removed_at: new Date(), removed_by: partner.id }).where('id', '=', id).execute();

    beforeEach(async () => {
      matterId = (
        await openMatter([
          [partner.id, 'supervising_partner'],
          [feeEarner.id, 'fee_earner'],
        ])
      ).id;
    });

    it('ends a membership once, and keeps it ended', async () => {
      const { id } = await membership(feeEarner.id);

      await end(id);

      await expect(end(id)).rejects.toThrow(/already ended/);
      await expect(
        db.updateTable('matter_team').set({ removed_at: null, removed_by: null }).where('id', '=', id).execute(),
      ).rejects.toThrow(/already ended/);
    });

    it('refuses to leave a matter without a supervising partner, when the transaction commits', async () => {
      const { id } = await membership(partner.id);

      await expect(end(id)).rejects.toThrow(/would have no supervising partner/);
      expect((await membership(partner.id)).role).toBe('supervising_partner');
    });

    it('lets supervision pass to another partner within one transaction', async () => {
      const successor = await staffWith('partner');
      const { id } = await membership(partner.id);

      await db.transaction().execute(async (trx) => {
        await end(id, trx);
        await trx
          .insertInto('matter_team')
          .values({ matter_id: matterId, account_id: successor.id, role: 'supervising_partner', added_by: partner.id })
          .execute();
      });

      expect((await membership(successor.id)).role).toBe('supervising_partner');
    });
  });

  describe('supervision takeover (step 8e)', () => {
    let matterId: string;
    let taker: TestAccount;

    const takeOver = (overrides: Record<string, unknown> = {}) =>
      db
        .insertInto('matter_supervision_takeovers')
        .values({
          matter_id: matterId,
          from_account_id: partner.id,
          to_account_id: taker.id,
          reason: 'Supervising partner has left the firm',
          ...overrides,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    const supervisorOf = async (id: string) =>
      (
        await db
          .selectFrom('matter_team')
          .select('account_id')
          .where('matter_id', '=', id)
          .where('role', '=', 'supervising_partner')
          .where('removed_at', 'is', null)
          .executeTakeFirstOrThrow()
      ).account_id;

    beforeEach(async () => {
      matterId = (await openMatter()).id;
      taker = await staffWith('partner');
    });

    it('moves supervision when the supervising partner is disabled', async () => {
      await setAccountStatus(db, partner.id, 'disabled');

      await takeOver();

      expect(await supervisorOf(matterId)).toBe(taker.id);
    });

    it('moves supervision when the supervising partner no longer holds the partner role', async () => {
      await revokeTestRole(db, partner.id, 'partner');

      await takeOver();

      expect(await supervisorOf(matterId)).toBe(taker.id);
    });

    it('refuses while the supervising partner can still act', async () => {
      await expect(takeOver()).rejects.toThrow(/can no longer act/);
      expect(await supervisorOf(matterId)).toBe(partner.id);
    });

    it('refuses a taker who is not a partner', async () => {
      await setAccountStatus(db, partner.id, 'disabled');
      const notPartner = await staffWith('fee_earner');

      await expect(takeOver({ to_account_id: notPartner.id })).rejects.toThrow(/by an active partner/);
    });

    it('keeps every takeover as it was', async () => {
      await setAccountStatus(db, partner.id, 'disabled');
      const { id } = await takeOver();

      await expect(sql`update matter_supervision_takeovers set reason = 'Rewritten afterwards' where id = ${id}`.execute(db)).rejects.toThrow(
        /permission denied/,
      );
      await expect(sql`delete from matter_supervision_takeovers where id = ${id}`.execute(db)).rejects.toThrow(/permission denied/);
    });
  });

  describe('editing and closing (step 8f)', () => {
    let matterId: string;

    const close = (closedBy: string, id = matterId) =>
      db
        .insertInto('matter_closures')
        .values({ matter_id: id, closed_by: closedBy, reason: 'Completion took place on 1 October' })
        .returning('id')
        .executeTakeFirstOrThrow();
    const statusOf = async (id: string) =>
      (await db.selectFrom('matters').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;

    beforeEach(async () => {
      matterId = (
        await openMatter([
          [partner.id, 'supervising_partner'],
          [feeEarner.id, 'fee_earner'],
        ])
      ).id;
    });

    it('lets the title and type be corrected', async () => {
      await db.updateTable('matters').set({ title: 'Sale of 12 High Street', matter_type: 'commercial_property' }).where('id', '=', matterId).execute();

      expect(
        await db.selectFrom('matters').select(['title', 'matter_type']).where('id', '=', matterId).executeTakeFirstOrThrow(),
      ).toEqual({ title: 'Sale of 12 High Street', matter_type: 'commercial_property' });
    });

    it('closes the matter when its supervising partner records a closure', async () => {
      await close(partner.id);

      expect(await statusOf(matterId)).toBe('closed');
    });

    it.each<[string, () => Promise<string>]>([
      ['a fee earner on the team', async () => feeEarner.id],
      ['a partner not on the team', async () => (await staffWith('partner')).id],
    ])('refuses a closure by %s', async (_case, closer) => {
      await expect(close(await closer())).rejects.toThrow(/only by its active supervising partner/);
      expect(await statusOf(matterId)).toBe('open');
    });

    describe('once closed', () => {
      beforeEach(async () => {
        await close(partner.id);
      });

      it.each<[string, () => Promise<unknown>]>([
        ['its title', () => db.updateTable('matters').set({ title: 'Changed' }).where('id', '=', matterId).execute()],
        ['a second closure', () => close(partner.id)],
        ['a new team member', async () =>
          db.insertInto('matter_team').values({ matter_id: matterId, account_id: (await staffWith('fee_earner')).id, role: 'fee_earner', added_by: partner.id }).execute()],
        ['a removal from the team', async () => {
          const { id } = await db
            .selectFrom('matter_team')
            .select('id')
            .where('matter_id', '=', matterId)
            .where('account_id', '=', feeEarner.id)
            .executeTakeFirstOrThrow();
          return db.updateTable('matter_team').set({ removed_at: new Date(), removed_by: partner.id }).where('id', '=', id).execute();
        }],
      ])('refuses a change to %s', async (_case, change) => {
        await expect(change()).rejects.toThrow(/closed/);
        expect(await statusOf(matterId)).toBe('closed');
      });
    });

    it('keeps every closure as it was', async () => {
      const { id } = await close(partner.id);

      await expect(sql`update matter_closures set reason = 'Rewritten afterwards' where id = ${id}`.execute(db)).rejects.toThrow(/permission denied/);
      await expect(sql`delete from matter_closures where id = ${id}`.execute(db)).rejects.toThrow(/permission denied/);
    });
  });

  describe('compliance access (step 8g)', () => {
    let matterId: string;

    const access = (accessedBy: string) =>
      db
        .insertInto('matter_compliance_accesses')
        .values({ matter_id: matterId, accessed_by: accessedBy, reason: 'Quarterly file review of property matters' })
        .returning('id')
        .executeTakeFirstOrThrow();

    beforeEach(async () => {
      matterId = (await openMatter()).id;
    });

    it('records an access by someone holding the compliance role', async () => {
      await expect(access((await staffWith('compliance')).id)).resolves.toBeDefined();
    });

    it.each<[string, () => Promise<string>]>([
      ['a partner', async () => (await staffWith('partner')).id],
      ['a disabled compliance holder', async () => {
        const account = await staffWith('compliance');
        await setAccountStatus(db, account.id, 'disabled');
        return account.id;
      }],
    ])('refuses an access by %s', async (_case, accessor) => {
      await expect(access(await accessor())).rejects.toThrow(/only by active compliance staff/);
    });

    it('keeps every access as it was', async () => {
      const { id } = await access((await staffWith('compliance')).id);

      await expect(sql`update matter_compliance_accesses set reason = 'Rewritten afterwards' where id = ${id}`.execute(db)).rejects.toThrow(
        /permission denied/,
      );
      await expect(sql`delete from matter_compliance_accesses where id = ${id}`.execute(db)).rejects.toThrow(/permission denied/);
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
