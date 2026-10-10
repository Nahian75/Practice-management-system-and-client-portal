import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearMatterForTests } from '../../test/aml.js';
import { createTestAccount, grantTestRole, revokeTestRole, setAccountStatus, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database, StaffRole } from '../database/schema.js';

interface RateRow {
  id: string;
  hourly_rate_pence: string;
  effective_from: string;
  created_at: Date;
}

interface TimeRow {
  id: string;
  matter_id: string;
  worker_id: string;
  worked_on: string;
  minutes: number;
  description: string;
  hourly_rate_pence: string;
  voided: boolean;
  recorded_at: Date;
}

describe('finance time database rules', () => {
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let accounts: TestAccount;
  let matterId: string;
  let today: string;

  const uniqueName = () => randomUUID().replaceAll('-', '').slice(0, 16);

  async function staffWith(...roles: StaffRole[]): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) {
      await grantTestRole(db, account.id, role);
    }
    return account;
  }

  async function openMatter(): Promise<string> {
    const client = await db.transaction().execute(async (trx) => {
      const row = await trx.insertInto('clients').values({ kind: 'individual', created_by: feeEarner.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({ client_id: row.id, given_names: uniqueName(), family_name: uniqueName() }).execute();
      return row;
    });
    const check = await db.insertInto('conflict_checks').values({ client_id: client.id, requested_by: feeEarner.id, names: [uniqueName()] }).returning('id').executeTakeFirstOrThrow();
    return db.transaction().execute(async (trx) => {
      const matter = await trx.insertInto('matters').values({
        client_id: client.id,
        title: 'Finance test matter',
        matter_type: 'other',
        opened_by: feeEarner.id,
        conflict_check_id: check.id,
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('matter_team').values([
        { matter_id: matter.id, account_id: feeEarner.id, role: 'fee_earner', added_by: feeEarner.id },
        { matter_id: matter.id, account_id: partner.id, role: 'supervising_partner', added_by: feeEarner.id },
      ]).execute();
      return matter.id;
    }).then(async (matterId) => {
      await clearMatterForTests(db, matterId);
      return matterId;
    });
  }

  async function addRate(
    accountId = feeEarner.id,
    rate = '25000',
    effectiveFrom = today,
    createdBy = accounts.id,
  ): Promise<RateRow> {
    return (await sql<RateRow>`
      insert into staff_rates (account_id, hourly_rate_pence, effective_from, created_by)
      values (${accountId}, ${rate}::bigint, ${effectiveFrom}::date, ${createdBy})
      returning id, hourly_rate_pence, effective_from, created_at
    `.execute(db)).rows[0]!;
  }

  async function addTime(overrides: {
    matterId?: string;
    workerId?: string;
    recordedBy?: string;
    workedOn?: string;
    minutes?: number;
    description?: string;
  } = {}): Promise<TimeRow> {
    return (await sql<TimeRow>`
      insert into time_entries (matter_id, worker_id, worked_on, minutes, description, recorded_by)
      values (
        ${overrides.matterId ?? matterId}, ${overrides.workerId ?? feeEarner.id},
        ${overrides.workedOn ?? today}::date, ${overrides.minutes ?? 60},
        ${overrides.description ?? 'Prepared the completion statement'},
        ${overrides.recordedBy ?? feeEarner.id}
      )
      returning id, matter_id, worker_id, worked_on, minutes, description,
        hourly_rate_pence, voided, recorded_at
    `.execute(db)).rows[0]!;
  }

  async function correct(
    timeEntryId: string,
    replacement: { workedOn: string; minutes: number; description: string } | null,
    correctedBy = feeEarner.id,
    reason = 'Correcting the posted time record',
  ) {
    return (await sql<{
      id: string;
      from_minutes: number;
      to_minutes: number | null;
      from_hourly_rate_pence: string;
      to_hourly_rate_pence: string | null;
      corrected_at: Date;
    }>`
      insert into time_entry_corrections (
        time_entry_id, to_worked_on, to_minutes, to_description, reason, corrected_by
      ) values (
        ${timeEntryId}, ${replacement?.workedOn ?? null}::date,
        ${replacement?.minutes ?? null}, ${replacement?.description ?? null},
        ${reason}, ${correctedBy}
      )
      returning id, from_minutes, to_minutes, from_hourly_rate_pence,
        to_hourly_rate_pence, corrected_at
    `.execute(db)).rows[0];
  }

  beforeAll(() => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 2);
    ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 2);
  });

  afterAll(async () => {
    await ownerDb.destroy();
    await db.destroy();
  });

  beforeEach(async () => {
    today = (await sql<{ today: string }>`select (clock_timestamp() at time zone 'Europe/London')::date::text as today`.execute(db)).rows[0]!.today;
    partner = await staffWith('partner');
    feeEarner = await staffWith('fee_earner');
    accounts = await staffWith('accounts');
    matterId = await openMatter();
  });

  describe('staff rates', () => {
    it('stores integer pence with database-owned identity and time', async () => {
      expect(await addRate()).toEqual({
        id: expect.any(String),
        hourly_rate_pence: '25000',
        effective_from: today,
        created_at: expect.any(Date),
      });
    });

    it('requires an active accounts creator and an active time-recording member of staff', async () => {
      const outsider = await staffWith('fee_earner');
      const administrator = await staffWith('administrator');
      await expect(addRate(outsider.id, '25000', today, administrator.id)).rejects.toThrow(/active accounts/i);

      const noTimeRole = await staffWith('administrator');
      await expect(addRate(noTimeRole.id)).rejects.toThrow(/partner or fee earner/i);
      await setAccountStatus(db, outsider.id, 'disabled');
      await expect(addRate(outsider.id)).rejects.toThrow(/active partner or fee earner/i);
    });

    it('refuses duplicate effective dates and invalid values', async () => {
      await addRate();
      await expect(addRate()).rejects.toThrow(/duplicate key/i);
      await expect(addRate(partner.id, '-1')).rejects.toThrow(/check constraint/i);
      await expect(addRate(partner.id, '1000001')).rejects.toThrow(/check constraint/i);
      await expect(addRate(partner.id, '10000', '1899-12-31')).rejects.toThrow(/check constraint/i);
    });

    it('keeps every rate immutable for the app and owner', async () => {
      const rate = await addRate();
      await expect(sql`update staff_rates set hourly_rate_pence = 1 where id = ${rate.id}`.execute(db)).rejects.toThrow(/permission denied/i);
      await expect(sql`delete from staff_rates where id = ${rate.id}`.execute(db)).rejects.toThrow(/permission denied/i);
      await expect(sql`update staff_rates set hourly_rate_pence = 1 where id = ${rate.id}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
      await expect(sql`delete from staff_rates where id = ${rate.id}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
      await expect(sql`truncate staff_rates`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
    });
  });

  describe('time entries', () => {
    it('uses the latest effective rate and database-owned trusted values', async () => {
      await addRate(feeEarner.id, '20000', '2026-01-01');
      await addRate(feeEarner.id, '25000', today);

      expect(await addTime()).toEqual({
        id: expect.any(String),
        matter_id: matterId,
        worker_id: feeEarner.id,
        worked_on: today,
        minutes: 60,
        description: 'Prepared the completion statement',
        hourly_rate_pence: '25000',
        voided: false,
        recorded_at: expect.any(Date),
      });
    });

    it('refuses missing rates, another recorder, invalid values and a future date', async () => {
      await expect(addTime()).rejects.toThrow(/effective staff rate/i);
      await addRate();
      await expect(addTime({ recordedBy: partner.id })).rejects.toThrow(/own time/i);
      await expect(addTime({ minutes: 0 })).rejects.toThrow(/check constraint/i);
      await expect(addTime({ minutes: 1_441 })).rejects.toThrow(/check constraint/i);
      await expect(addTime({ description: '' })).rejects.toThrow(/check constraint/i);
      const tomorrow = new Date(`${today}T12:00:00Z`);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      await expect(addTime({ workedOn: tomorrow.toISOString().slice(0, 10) })).rejects.toThrow(/future/i);
    });

    it('requires an open matter, current team membership, active account and time-recording role', async () => {
      await addRate();
      const outsider = await staffWith('fee_earner');
      await addRate(outsider.id);
      await expect(addTime({ workerId: outsider.id, recordedBy: outsider.id })).rejects.toThrow(/active matter team/i);

      await setAccountStatus(db, feeEarner.id, 'disabled');
      await expect(addTime()).rejects.toThrow(/active matter team/i);
      await setAccountStatus(db, feeEarner.id, 'active');
      await revokeTestRole(db, feeEarner.id, 'fee_earner');
      await expect(addTime()).rejects.toThrow(/time-recording role/i);
    });

    it('refuses time on an awaiting-clearance or closed matter', async () => {
      await addRate();
      const matching = uniqueName();
      await db.transaction().execute(async (trx) => {
        const client = await trx.insertInto('clients').values({ kind: 'individual', created_by: feeEarner.id }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('client_individuals').values({ client_id: client.id, given_names: 'Conflict', family_name: matching }).execute();
      });
      const client = await db.transaction().execute(async (trx) => {
        const row = await trx.insertInto('clients').values({ kind: 'individual', created_by: feeEarner.id }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('client_individuals').values({ client_id: row.id, given_names: 'Another', family_name: uniqueName() }).execute();
        return row;
      });
      const check = await db.insertInto('conflict_checks').values({ client_id: client.id, requested_by: feeEarner.id, names: [`Conflict ${matching}`] }).returning('id').executeTakeFirstOrThrow();
      const awaiting = await db.transaction().execute(async (trx) => {
        const matter = await trx.insertInto('matters').values({ client_id: client.id, title: 'Awaiting matter', matter_type: 'other', opened_by: feeEarner.id, conflict_check_id: check.id }).returning(['id', 'status']).executeTakeFirstOrThrow();
        await trx.insertInto('matter_team').values([
          { matter_id: matter.id, account_id: feeEarner.id, role: 'fee_earner', added_by: feeEarner.id },
          { matter_id: matter.id, account_id: partner.id, role: 'supervising_partner', added_by: feeEarner.id },
        ]).execute();
        return matter;
      });
      expect(awaiting.status).toBe('awaiting_clearance');
      await expect(addTime({ matterId: awaiting.id })).rejects.toThrow(/open matters/i);

      await db.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'All work is complete' }).execute();
      await expect(addTime()).rejects.toThrow(/open matters/i);
    });

    it('orders closure against a new time entry', async () => {
      await addRate();
      let closureStarted!: () => void;
      let finishClosure!: () => void;
      const started = new Promise<void>((resolve) => (closureStarted = resolve));
      const finish = new Promise<void>((resolve) => (finishClosure = resolve));
      const closing = ownerDb.transaction().execute(async (trx) => {
        await trx.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'All work is complete' }).execute();
        closureStarted();
        await finish;
      });
      await started;
      const creating = addTime();
      expect(await Promise.race([
        creating.then(() => 'finished', () => 'finished'),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50)),
      ])).toBe('waiting');
      finishClosure();
      await closing;
      await expect(creating).rejects.toThrow(/open matters/i);
    });

    it('does not let callers choose trusted values or rewrite records', async () => {
      await addRate();
      const entry = await addTime();
      await expect(sql`insert into time_entries (id, matter_id, worker_id, worked_on, minutes, description, hourly_rate_pence, recorded_by) values (${randomUUID()}, ${matterId}, ${feeEarner.id}, ${today}::date, 60, 'Chosen', 1, ${feeEarner.id})`.execute(db)).rejects.toThrow(/permission denied/i);
      await expect(sql`update time_entries set minutes = 1 where id = ${entry.id}`.execute(db)).rejects.toThrow(/permission denied/i);
      await expect(sql`delete from time_entries where id = ${entry.id}`.execute(db)).rejects.toThrow(/permission denied/i);
      await expect(sql`update time_entries set minutes = 1 where id = ${entry.id}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
      await expect(sql`delete from time_entries where id = ${entry.id}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
      await expect(sql`truncate time_entry_corrections, time_entries cascade`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
    });
  });

  describe('corrections', () => {
    it('records before and after values and refreshes the rate snapshot', async () => {
      await addRate(feeEarner.id, '20000', '2026-01-01');
      const entry = await addTime();
      await addRate(feeEarner.id, '25000', today);

      expect(await correct(entry.id, { workedOn: today, minutes: 90, description: 'Prepared and checked the statement' })).toEqual({
        id: expect.any(String),
        from_minutes: 60,
        to_minutes: 90,
        from_hourly_rate_pence: '20000',
        to_hourly_rate_pence: '25000',
        corrected_at: expect.any(Date),
      });
      expect(await sql<TimeRow>`select * from time_entries where id = ${entry.id}`.execute(db).then((result) => result.rows[0])).toMatchObject({
        minutes: 90,
        description: 'Prepared and checked the statement',
        hourly_rate_pence: '25000',
        voided: false,
      });
    });

    it('can void an entry and treats an identical replacement as no change', async () => {
      await addRate();
      const unchanged = await addTime();
      expect(await correct(unchanged.id, { workedOn: today, minutes: 60, description: 'Prepared the completion statement' })).toBeUndefined();

      const entry = await addTime();
      expect(await correct(entry.id, null)).toMatchObject({ to_minutes: null });
      expect(await sql<{ voided: boolean }>`select voided from time_entries where id = ${entry.id}`.execute(db).then((result) => result.rows[0]?.voided)).toBe(true);
      await expect(correct(entry.id, null)).rejects.toThrow(/voided time/i);
    });

    it('refuses incomplete, invalid, unsafe, future and unrated replacements', async () => {
      await addRate();
      const entry = await addTime();
      await expect(correct(entry.id, { workedOn: today, minutes: 0, description: 'Corrected' })).rejects.toThrow(/check constraint/i);
      await expect(correct(entry.id, { workedOn: today, minutes: 30, description: '' })).rejects.toThrow(/check constraint/i);
      await expect(correct(entry.id, { workedOn: today, minutes: 30, description: 'Corrected' }, feeEarner.id, '')).rejects.toThrow(/check constraint/i);
      await expect(correct(entry.id, { workedOn: today, minutes: 30, description: `Unsafe${String.fromCharCode(1)}text` })).rejects.toThrow(/check constraint/i);

      const tomorrow = new Date(`${today}T12:00:00Z`);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      await expect(correct(entry.id, { workedOn: tomorrow.toISOString().slice(0, 10), minutes: 30, description: 'Future' })).rejects.toThrow(/future/i);
      await expect(correct(entry.id, { workedOn: '1900-01-01', minutes: 30, description: 'Before the first rate' })).rejects.toThrow(/effective staff rate/i);
      await expect(sql`
        insert into time_entry_corrections (time_entry_id, to_worked_on, to_minutes, to_description, reason, corrected_by)
        values (${entry.id}, ${today}::date, null, 'Partial', 'Incomplete replacement', ${feeEarner.id})
      `.execute(db)).rejects.toThrow(/replacement needs a date, minutes and description/i);
    });

    it('allows correction after closure but only by the active worker who remains on the team', async () => {
      await addRate();
      const entry = await addTime();
      await db.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'All work is complete' }).execute();
      expect(await correct(entry.id, { workedOn: today, minutes: 30, description: 'Corrected after closure' })).toBeDefined();

      const outsider = await staffWith('fee_earner');
      await expect(correct(entry.id, null, outsider.id)).rejects.toThrow(/own time/i);
      await setAccountStatus(db, feeEarner.id, 'disabled');
      await expect(correct(entry.id, null)).rejects.toThrow(/active matter team/i);
      await setAccountStatus(db, feeEarner.id, 'active');
      await revokeTestRole(db, feeEarner.id, 'fee_earner');
      await expect(correct(entry.id, null)).rejects.toThrow(/time-recording role/i);
    });

    it('refuses correction after the worker leaves the matter team', async () => {
      await addRate();
      const entry = await addTime();
      await db.updateTable('matter_team').set({ removed_at: new Date(), removed_by: partner.id }).where('matter_id', '=', matterId).where('account_id', '=', feeEarner.id).execute();
      await expect(correct(entry.id, null)).rejects.toThrow(/active matter team/i);
    });

    it('keeps correction history immutable and database-owned', async () => {
      await addRate();
      const entry = await addTime();
      const correction = await correct(entry.id, null);
      await expect(sql`insert into time_entry_corrections (id, time_entry_id, reason, corrected_by) values (${randomUUID()}, ${entry.id}, 'Chosen', ${feeEarner.id})`.execute(db)).rejects.toThrow(/permission denied/i);
      await expect(sql`update time_entry_corrections set reason = 'Changed' where id = ${correction!.id}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
      await expect(sql`delete from time_entry_corrections where id = ${correction!.id}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
      await expect(sql`truncate time_entry_corrections`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
    });
  });
});
