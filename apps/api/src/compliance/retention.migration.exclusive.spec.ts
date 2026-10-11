import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { createAmlStaff, createTeamMatter, ensureAmlFramework, submitTestCdd } from '../../test/aml.js';
import { testAppDatabaseUrl, testEnv, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database } from '../database/schema.js';
import { ComplianceDataCipher } from './compliance-data-cipher.js';
import { SuspicionDataCipher } from './suspicion-data-cipher.js';

describe('AML retention and disposal database rules', () => {
  let db: Kysely<Database>, ownerDb: Kysely<Database>, compliance: TestAccount, admin: TestAccount;
  let clientId: string, dueOn: string, reviewOn: string;
  const cipher = new ComplianceDataCipher(testEnv());
  const suspicion = new SuspicionDataCipher(testEnv());

  beforeAll(async () => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 3);
    ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 2);
    await ensureAmlFramework(db);
  });
  afterAll(async () => { await ownerDb.destroy(); await db.destroy(); });
  afterEach(async () => {
    await ownerDb.transaction().execute(async (trx) => {
      await sql`select set_config('app.aml_appointment_end','1',true)`.execute(trx);
      await sql`update app.aml_officer_appointments set ended_by=${admin.id},ended_at=clock_timestamp(),
        end_reason='Retention database test cleanup' where appointed_by=${admin.id} and ended_at is null`.execute(trx);
    });
  });
  beforeEach(async () => {
    compliance = await createAmlStaff(db, 'compliance');
    admin = await createAmlStaff(db, 'administrator');
    const dates = (await sql<{ due: string; review: string }>`select (app.london_today()-interval '5 years')::date::text due,
      (app.london_today()+30)::text review`.execute(db)).rows[0]!;
    dueOn = dates.due; reviewOn = dates.review;
    clientId = await newClient();
  });

  async function newClient() {
    return db.transaction().execute(async (trx) => {
      const client = await trx.insertInto('clients').values({ kind: 'individual', created_by: compliance.id })
        .returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({ client_id: client.id, given_names: 'Retention', family_name: randomUUID() }).execute();
      return client.id;
    });
  }

  async function schedule(actorId = compliance.id) {
    const id = randomUUID();
    const sealed = cipher.seal({ evidence: 'The engagement-end letter was checked against the closed file.' }, `aml-retention-schedule:${id}`);
    await sql`select app.record_aml_retention_schedule(${id},${clientId},${dueOn}::date,5::smallint,
      'MLR 2017 regulation 40 five-year retention rule',${sealed.context},${sealed.keyVersion}::smallint,
      ${sealed.nonce},${sealed.ciphertext},${sealed.authTag},${actorId})`.execute(db);
    return id;
  }

  async function hold(scheduleId: string, action: 'imposed' | 'reviewed' | 'released') {
    const id = randomUUID();
    const sealed = cipher.seal({ authority: 'Court proceedings file', reason: 'Evidence is needed for current proceedings.' }, `aml-legal-hold:${id}`);
    await sql`select app.record_aml_legal_hold_event(${id},${scheduleId},${action},
      ${action === 'released' ? null : reviewOn}::date,${sealed.context},${sealed.keyVersion}::smallint,
      ${sealed.nonce},${sealed.ciphertext},${sealed.authTag},${compliance.id})`.execute(db);
    return id;
  }

  it('archives only a client with closed work and keeps schedules protected from direct writes', async () => {
    const partner = await createAmlStaff(db, 'partner');
    const feeEarner = await createAmlStaff(db, 'fee_earner');
    clientId = (await createTeamMatter(db, feeEarner, partner)).clientId;
    await expect(schedule()).rejects.toMatchObject({ code: '23514' });
    clientId = await newClient();
    const id = await schedule();
    expect((await db.selectFrom('clients').select('status').where('id','=',clientId).executeTakeFirstOrThrow()).status).toBe('archived');
    await expect(db.selectFrom('aml_retention_schedules').selectAll().execute()).rejects.toMatchObject({ code: '42501' });
    await expect(sql`delete from app.aml_retention_schedules where id=${id}`.execute(ownerDb)).rejects.toMatchObject({ code: '42501' });
  });

  it('blocks disposal under a legal hold and accepts only a permanent release event', async () => {
    const scheduleId = await schedule();
    await hold(scheduleId, 'imposed');
    await expect(sql`select * from app.prepare_aml_disposal(${randomUUID()},${scheduleId},${compliance.id})`.execute(db))
      .rejects.toMatchObject({ code: '23514' });
    await expect(hold(scheduleId, 'imposed')).rejects.toMatchObject({ code: '23514' });
    await hold(scheduleId, 'reviewed');
    await hold(scheduleId, 'released');
    const prepared = await sql<{ id: string }>`select * from app.prepare_aml_disposal(${randomUUID()},${scheduleId},${compliance.id})`.execute(db);
    expect(prepared.rows).toHaveLength(1);
  });

  it('returns encrypted-object keys, erases client AML rows and leaves content-free tombstones', async () => {
    const cdd = await submitTestCdd(db, clientId, compliance.id);
    const storageKey = (await db.selectFrom('aml_cdd_evidence').select('storage_key').where('id','=',cdd.evidenceId).executeTakeFirstOrThrow()).storage_key;
    const scheduleId = await schedule(), runId = randomUUID();
    const prepared = (await sql<{ id: string; object_keys: string[] }>`select * from app.prepare_aml_disposal(
      ${runId},${scheduleId},${compliance.id})`.execute(db)).rows[0]!;
    expect(prepared.object_keys).toEqual([storageKey]);
    const count = (await sql<{ count: number }>`select app.finalize_aml_disposal(${runId},${compliance.id}) count`.execute(db)).rows[0]!.count;
    expect(count).toBeGreaterThanOrEqual(3);
    expect(await ownerDb.selectFrom('aml_cdd_cases').select('id').where('client_id','=',clientId).execute()).toEqual([]);
    expect(await ownerDb.selectFrom('aml_retention_schedules').select('id').where('id','=',scheduleId).execute()).toEqual([]);
    const run = await ownerDb.selectFrom('aml_disposal_runs').select(['state','object_keys','record_count']).where('id','=',runId).executeTakeFirstOrThrow();
    expect(run).toMatchObject({ state: 'completed', object_keys: [], record_count: count });
    expect(await ownerDb.selectFrom('aml_disposed_records').select(['record_id','record_kind']).where('run_id','=',runId).execute())
      .toEqual(expect.arrayContaining([{ record_id: cdd.caseId, record_kind: 'aml_cdd_case' },
        { record_id: cdd.subjectId, record_kind: 'aml_cdd_subject' }, { record_id: cdd.evidenceId, record_kind: 'aml_cdd_evidence' }]));
  });

  it('requires a live nominated officer before any restricted material can enter disposal', async () => {
    const reporter = await createTestAccount(db, 'staff');
    await grantTestRole(db, reporter.id, 'accounts');
    const reportId = randomUUID();
    const sealed = suspicion.seal({ observedFacts: 'A restricted report prevents ordinary-only disposal.' }, `suspicion-report:${reportId}`);
    await sql`select app.submit_aml_internal_report(${reportId},${clientId},null,null,${dueOn}::date,
      ${sealed.context},${sealed.keyVersion}::smallint,${sealed.nonce},${sealed.ciphertext},${sealed.authTag},${reporter.id})`.execute(db);
    const scheduleId = await schedule();
    await expect(sql`select * from app.prepare_aml_disposal(${randomUUID()},${scheduleId},${compliance.id})`.execute(db))
      .rejects.toMatchObject({ code: '42501' });
    await sql`select app.appoint_aml_officer(${compliance.id},'nominated_officer',${admin.id})`.execute(db);
    expect((await sql`select * from app.prepare_aml_disposal(${randomUUID()},${scheduleId},${compliance.id})`.execute(db)).rows).toHaveLength(1);
  });

  it('holds the client lock through finalization so a concurrent report is retained after disposal', async () => {
    const scheduleId = await schedule();
    const reporter = await createTestAccount(db, 'staff');
    await grantTestRole(db, reporter.id, 'fee_earner');
    const reportId = randomUUID();
    const sealed = suspicion.seal({ observedFacts: 'A report racing disposal must not be silently erased.' }, `suspicion-report:${reportId}`);
    let submitted = false;
    let pending: Promise<void> | undefined;
    await db.transaction().execute(async (trx) => {
      const runId = randomUUID();
      await sql`select * from app.prepare_aml_disposal(${runId},${scheduleId},${compliance.id})`.execute(trx);
      pending = sql`select app.submit_aml_internal_report(${reportId},${clientId},null,null,${dueOn}::date,
        ${sealed.context},${sealed.keyVersion}::smallint,${sealed.nonce},${sealed.ciphertext},${sealed.authTag},${reporter.id})`
        .execute(db).then(() => { submitted = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(submitted).toBe(false);
      await sql`select app.finalize_aml_disposal(${runId},${compliance.id})`.execute(trx);
    });
    await pending;
    expect(submitted).toBe(true);
    expect(await ownerDb.selectFrom('aml_internal_reports').select('id').where('id','=',reportId).executeTakeFirst()).toEqual({ id: reportId });
  });
});
