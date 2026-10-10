import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database, StaffRole } from '../database/schema.js';

describe('Compliance foundations database rules', () => {
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let administrator: TestAccount;
  let compliance: TestAccount;
  let partner: TestAccount;
  let today: string;

  async function staffWith(...roles: StaffRole[]) {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) await grantTestRole(db, account.id, role);
    return account;
  }
  async function control(actorId = compliance.id, kind = 'aml_policy') {
    const content = `Fixed control content ${randomUUID()}`;
    return (await sql<{ id: string }>`select app.create_aml_control_version(
      ${kind}, 'Tailored firm control', ${content}, ${createHash('sha256').update(content).digest()},
      'Firm evidence and SRA guidance', ${today}::date, '2099-12-31'::date, ${actorId}
    ) as id`.execute(db)).rows[0]!.id;
  }

  beforeAll(() => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 2);
    ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 2);
  });
  afterAll(async () => {
    // These owner-only integration probes intentionally create permanent
    // appointments. End the final live fixture so the later protected-role
    // suite can establish its own whole-database starting condition.
    await ownerDb.transaction().execute(async (trx) => {
      await sql`select set_config('app.aml_appointment_end', '1', true)`.execute(trx);
      await sql`update app.aml_officer_appointments
        set ended_by = ${administrator.id}, ended_at = clock_timestamp(), end_reason = 'Exclusive test fixture cleanup'
        where ended_at is null`.execute(trx);
    });
    await ownerDb.destroy();
    await db.destroy();
  });
  beforeEach(async () => {
    today = (await sql<{ today: string }>`select (clock_timestamp() at time zone 'Europe/London')::date::text as today`.execute(db)).rows[0]!.today;
    administrator = await staffWith('administrator');
    compliance = await staffWith('compliance');
    partner = await staffWith('partner');
  });

  it('denies direct application writes and requires the active role again in each function', async () => {
    await expect(sql`insert into app.aml_control_versions (
      kind, version, title, content, content_sha256, source, effective_from, review_due_on, prepared_by
    ) values ('aml_policy', 1, 'Direct', 'Direct content', ${Buffer.alloc(32)}, 'Direct source',
      ${today}::date, '2099-12-31'::date, ${compliance.id})`.execute(db)).rejects.toMatchObject({ code: '42501' });
    const outsider = await staffWith('fee_earner');
    await expect(control(outsider.id)).rejects.toMatchObject({ code: '42501' });
    await expect(sql`select app.create_aml_control_version(
      'aml_policy', 'False digest', 'Content whose digest does not match', ${Buffer.alloc(32)},
      'Firm source', ${today}::date, '2099-12-31'::date, ${compliance.id}
    )`.execute(db)).rejects.toMatchObject({ code: '23514' });
    await expect(sql`select app.appoint_aml_officer(${compliance.id}, 'nominated_officer', ${outsider.id})`.execute(db))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('keeps published controls and evidence immutable even for the owner role', async () => {
    const id = await control();
    const materialId = await control(compliance.id, 'training_material');
    await sql`select app.approve_aml_control_version(${materialId}, ${partner.id})`.execute(db);
    const approval = await db.selectFrom('aml_control_approvals').select('id').where('control_version_id', '=', materialId).executeTakeFirstOrThrow();
    const training = await sql<{ id: string }>`select app.record_aml_training(
      ${compliance.id}, ${materialId}, 'Internal trainer', ${today}::date, 'Certificate 27', ${compliance.id}
    ) as id`.execute(db);
    const review = await sql<{ id: string }>`select app.record_aml_independent_review(
      ${today}::date, ${today}::date, ${today}::date, 'Independent reviewer', 'Review Ltd',
      'No role in the controls', 'Firm AML controls', 'Controls operated as designed',
      'Retain the evidence', 'Accepted', ${compliance.id}
    ) as id`.execute(db);
    await expect(ownerDb.updateTable('aml_control_versions').set({ title: 'Rewritten title' } as never).where('id', '=', id).execute())
      .rejects.toMatchObject({ code: '42501' });
    await expect(ownerDb.updateTable('aml_control_approvals').set({ approved_by: compliance.id } as never).where('id', '=', approval.id).execute())
      .rejects.toMatchObject({ code: '42501' });
    await expect(ownerDb.updateTable('aml_training_completions').set({ provider: 'Rewritten provider' } as never)
      .where('id', '=', training.rows[0]!.id).execute()).rejects.toMatchObject({ code: '42501' });
    await expect(ownerDb.updateTable('aml_independent_reviews').set({ findings: 'Rewritten findings' } as never)
      .where('id', '=', review.rows[0]!.id).execute()).rejects.toMatchObject({ code: '42501' });
    await expect(ownerDb.deleteFrom('aml_control_versions').where('id', '=', id).execute())
      .rejects.toMatchObject({ code: '42501' });
    await expect(sql`truncate app.aml_control_versions cascade`.execute(ownerDb)).rejects.toMatchObject({ code: '42501' });
  });

  it('prevents owner-level edits to appointment history and protects the last live appointment', async () => {
    const id = (await sql<{ id: string }>`select app.appoint_aml_officer(
      ${compliance.id}, 'nominated_officer', ${administrator.id}
    ) as id`.execute(db)).rows[0]!.id;
    const others = await db.selectFrom('aml_officer_appointments').select('id')
      .where('kind', '=', 'nominated_officer').where('ended_at', 'is', null)
      .where('id', '<>', id).execute();
    for (const other of others) {
      await sql`select app.end_aml_officer_appointment(${other.id}, 'Test appointment transfer', ${administrator.id})`.execute(db);
    }
    await expect(ownerDb.updateTable('aml_officer_appointments')
      .set({ end_reason: 'Bypassing the protected function' } as never).where('id', '=', id).execute())
      .rejects.toMatchObject({ code: '42501' });
    await expect(sql`select app.end_aml_officer_appointment(${id}, 'No replacement', ${administrator.id})`.execute(db))
      .rejects.toMatchObject({ code: '23514' });
    await expect(ownerDb.updateTable('accounts').set({ status: 'disabled' }).where('id', '=', compliance.id).execute())
      .rejects.toMatchObject({ code: '23514' });
  });

  it('requires a different active partner and an approved training-material version', async () => {
    const both = await staffWith('compliance', 'partner');
    const own = await control(both.id, 'training_material');
    await expect(sql`select app.approve_aml_control_version(${own}, ${both.id})`.execute(db))
      .rejects.toMatchObject({ code: '23514' });
    await sql`select app.approve_aml_control_version(${own}, ${partner.id})`.execute(db);
    await expect(sql`select app.record_aml_training(
      ${both.id}, ${own}, 'Internal trainer', '2000-01-01'::date, 'Impossible chronology', ${both.id}
    )`.execute(db)).rejects.toMatchObject({ code: '23514' });
    const completion = await sql<{ id: string }>`select app.record_aml_training(
      ${both.id}, ${own}, 'Internal trainer', ${today}::date, 'Certificate 22', ${both.id}
    ) as id`.execute(db);
    expect(completion.rows[0]!.id).toEqual(expect.any(String));
    await expect(sql`select app.record_aml_training(
      ${both.id}, ${own}, 'Internal trainer', ${today}::date, 'Duplicate', ${both.id}
    )`.execute(db)).rejects.toMatchObject({ code: '23505' });
  });

  it('serializes concurrent version allocation for one control kind', async () => {
    const holder = createDatabase<Database>(testAppDatabaseUrl(), 1);
    const controlLock = sql`hashtextextended('app.aml_control.sanctions_policy', 0)`;
    const create = (suffix: string) => {
      const content = `Concurrent fixed content ${suffix} ${randomUUID()}`;
      return sql<{ id: string }>`select app.create_aml_control_version(
        'sanctions_policy', ${`Concurrent ${suffix}`}, ${content}, ${createHash('sha256').update(content).digest()},
        'Firm source', ${today}::date, '2099-12-31'::date, ${compliance.id}
      ) as id`.execute(db);
    };
    try {
      await sql`select pg_advisory_lock(${controlLock})`.execute(holder);
      const first = create('A');
      const second = create('B');
      await expect.poll(async () => {
        const { rows } = await sql<{ waiting: string }>`
          select count(*) as waiting from pg_locks where locktype = 'advisory' and not granted
        `.execute(holder);
        return Number(rows[0]?.waiting);
      }).toBeGreaterThanOrEqual(2);
      await sql`select pg_advisory_unlock(${controlLock})`.execute(holder);
      const created = await Promise.all([first, second]);
      const ids = created.map((result) => result.rows[0]!.id);
      const rows = await db.selectFrom('aml_control_versions').select('version').where('id', 'in', ids).orderBy('version').execute();
      expect(rows).toHaveLength(2);
      expect(rows[1]!.version).toBe(rows[0]!.version + 1);
    } finally {
      await sql`select pg_advisory_unlock(${controlLock})`.execute(holder).catch(() => undefined);
      await holder.destroy();
    }
  });

  it('lets only one of two concurrent last-officer endings succeed', async () => {
    const first = await staffWith('compliance');
    const second = await staffWith('compliance');
    const firstId = (await sql<{ id: string }>`select app.appoint_aml_officer(
      ${first.id}, 'nominated_officer', ${administrator.id}
    ) as id`.execute(db)).rows[0]!.id;
    const secondId = (await sql<{ id: string }>`select app.appoint_aml_officer(
      ${second.id}, 'nominated_officer', ${administrator.id}
    ) as id`.execute(db)).rows[0]!.id;
    const older = await db.selectFrom('aml_officer_appointments').select('id')
      .where('kind', '=', 'nominated_officer').where('ended_at', 'is', null)
      .where('id', 'not in', [firstId, secondId]).execute();
    for (const appointment of older) {
      await sql`select app.end_aml_officer_appointment(
        ${appointment.id}, 'Replaced for the concurrency test', ${administrator.id}
      )`.execute(db);
    }

    const endings = await Promise.allSettled([
      sql`select app.end_aml_officer_appointment(${firstId}, 'Concurrent transfer', ${administrator.id})`.execute(db),
      sql`select app.end_aml_officer_appointment(${secondId}, 'Concurrent transfer', ${administrator.id})`.execute(db),
    ]);
    expect(endings.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = endings.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejection?.reason).toMatchObject({ code: '23514' });
    const active = await db.selectFrom('aml_officer_appointments').select('id')
      .where('id', 'in', [firstId, secondId]).where('ended_at', 'is', null).execute();
    expect(active).toHaveLength(1);
  });
});
