import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, revokeTestRole, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl, testEnv, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database, StaffRole } from '../database/schema.js';
import { SuspicionDataCipher } from './suspicion-data-cipher.js';

describe('restricted AML report database rules', () => {
  let db: Kysely<Database>, ownerDb: Kysely<Database>, admin: TestAccount, reporter: TestAccount,
    officer: TestAccount, outsider: TestAccount, clientId: string, today: string;
  const cipher = new SuspicionDataCipher(testEnv());
  async function staff(...roles: StaffRole[]) {
    const a = await createTestAccount(db, 'staff');
    for (const role of roles) await grantTestRole(db, a.id, role);
    return a;
  }
  async function submit(actor = reporter.id) {
    const id = randomUUID(), s = cipher.seal({ observedFacts: 'Fixed confidential observed facts for the database test.' }, `suspicion-report:${id}`);
    await sql`select app.submit_aml_internal_report(${id}::uuid, ${clientId}::uuid, null::uuid, null::uuid, ${today}::date,
      ${s.context}, ${s.keyVersion}::smallint, ${s.nonce}, ${s.ciphertext}, ${s.authTag}, ${actor}::uuid)`.execute(db);
    return id;
  }
  beforeAll(() => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 3); ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 2);
  });
  afterAll(async () => { await ownerDb.destroy(); await db.destroy(); });
  afterEach(async () => {
    await ownerDb.transaction().execute(async (trx) => {
      await sql`select set_config('app.aml_appointment_end', '1', true)`.execute(trx);
      await sql`update app.aml_officer_appointments set ended_by = ${admin.id}, ended_at = clock_timestamp(),
        end_reason = 'Restricted database test fixture cleanup' where appointed_by = ${admin.id} and ended_at is null`.execute(trx);
    });
  });
  beforeEach(async () => {
    today = (await sql<{ today: string }>`select app.london_today()::text as today`.execute(db)).rows[0]!.today;
    admin = await staff('administrator'); reporter = await staff('accounts'); officer = await staff('compliance'); outsider = await staff('compliance');
    await sql`select app.appoint_aml_officer(${officer.id}, 'nominated_officer', ${admin.id})`.execute(db);
    clientId = await db.transaction().execute(async (trx) => {
      const client = await trx.insertInto('clients').values({ kind: 'individual', created_by: reporter.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({ client_id: client.id, title: null, given_names: 'Private', family_name: randomUUID(),
        date_of_birth: null, email: null, phone: null, address_line1: '1 Test Street', address_line2: null,
        town: 'London', postcode: null, country: 'GB' }).execute();
      return client.id;
    });
  });

  it('accepts protected submission by active staff but refuses direct app writes and restricted reads', async () => {
    const id = await submit();
    await expect(db.selectFrom('aml_internal_reports').selectAll().execute()).rejects.toMatchObject({ code: '42501' });
    const fake = randomUUID(), s = cipher.seal({ observedFacts: 'Direct insert should never be accepted by the application role.' }, `suspicion-report:${fake}`);
    await expect(sql`insert into app.aml_internal_reports(id,client_id,observed_on,encryption_context,key_version,nonce,ciphertext,auth_tag,submitted_by)
      values(${fake},${clientId},${today},${s.context},${s.keyVersion},${s.nonce},${s.ciphertext},${s.authTag},${reporter.id})`.execute(db))
      .rejects.toMatchObject({ code: '42501' });
    await expect(sql`insert into app.aml_internal_reports(id,client_id,observed_on,encryption_context,key_version,nonce,ciphertext,auth_tag,submitted_by)
      values(${fake},${clientId},${today},${s.context},${s.keyVersion},${s.nonce},${s.ciphertext},${s.authTag},${reporter.id})`.execute(ownerDb))
      .rejects.toMatchObject({ code: '42501' });
    await expect(sql`select * from app.read_aml_internal_report(${id}, ${reporter.id})`.execute(db)).rejects.toMatchObject({ code: '42501' });
    await expect(sql`select * from app.read_aml_internal_report(${id}, ${outsider.id})`.execute(db)).rejects.toMatchObject({ code: '42501' });
    expect((await sql`select * from app.read_aml_internal_report(${id}, ${officer.id})`.execute(db)).rows).toHaveLength(1);
  });

  it('binds ciphertext to its record and refuses inconsistent linked records and future observations', async () => {
    const wrong = randomUUID(), s = cipher.seal({ observedFacts: 'Context belongs to another record.' }, `suspicion-report:${randomUUID()}`);
    await expect(sql`select app.submit_aml_internal_report(${wrong},${clientId},null,null,${today},${s.context},${s.keyVersion},${s.nonce},${s.ciphertext},${s.authTag},${reporter.id})`.execute(db))
      .rejects.toMatchObject({ code: '23514' });
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10), id = randomUUID();
    const f = cipher.seal({ observedFacts: 'Future observed fact.' }, `suspicion-report:${id}`);
    await expect(sql`select app.submit_aml_internal_report(${id},${clientId},null,null,${future},${f.context},${f.keyVersion},${f.nonce},${f.ciphertext},${f.authTag},${reporter.id})`.execute(db))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('keeps reports, decisions and access history immutable even for the owner', async () => {
    const id = await submit();
    await sql`select * from app.read_aml_internal_report(${id}, ${officer.id})`.execute(db);
    const decisionId = randomUUID(), s = cipher.seal({ legalGrounds: 'Protected legal grounds that are fixed once decided.' }, `suspicion-decision:${decisionId}`);
    await sql`select app.decide_aml_internal_report(${decisionId},${id},false,${s.context},${s.keyVersion},${s.nonce},${s.ciphertext},${s.authTag},null,${officer.id})`.execute(db);
    await expect(sql`update app.aml_internal_reports set observed_on = ${today} where id = ${id}`.execute(ownerDb)).rejects.toMatchObject({ code: '42501' });
    await expect(sql`delete from app.aml_internal_report_decisions where id = ${decisionId}`.execute(ownerDb)).rejects.toMatchObject({ code: '42501' });
    await expect(sql`truncate app.aml_restricted_access_log`.execute(ownerDb)).rejects.toMatchObject({ code: '42501' });
  });

  it('requires a current nominated officer for decisions and fixes one decision per report', async () => {
    const id = await submit();
    const first = randomUUID(), s = cipher.seal({ legalGrounds: 'A decision needs a live nominated officer appointment.' }, `suspicion-decision:${first}`);
    await expect(sql`select app.decide_aml_internal_report(${first},${id},false,${s.context},${s.keyVersion},${s.nonce},${s.ciphertext},${s.authTag},null,${outsider.id})`.execute(db))
      .rejects.toMatchObject({ code: '42501' });
    await sql`select app.decide_aml_internal_report(${first},${id},false,${s.context},${s.keyVersion},${s.nonce},${s.ciphertext},${s.authTag},null,${officer.id})`.execute(db);
    const second = randomUUID(), s2 = cipher.seal({ legalGrounds: 'A later decision must not replace the first.' }, `suspicion-decision:${second}`);
    await expect(sql`select app.decide_aml_internal_report(${second},${id},true,${s2.context},${s2.keyVersion},${s2.nonce},${s2.ciphertext},${s2.authTag},null,${officer.id})`.execute(db))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('serializes a sensitive read against loss of the live Compliance role', async () => {
    const id = await submit();
    await sql`select app.appoint_aml_officer(${outsider.id}, 'nominated_officer', ${admin.id})`.execute(db);
    const blocker = db.transaction().execute(async (trx) => {
      const read = await sql`select * from app.read_aml_internal_report(${id}, ${officer.id})`.execute(trx);
      await new Promise((resolve) => setTimeout(resolve, 120));
      return read;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    let revoked = false;
    const removal = revokeTestRole(db, officer.id, 'compliance').then(() => { revoked = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(revoked).toBe(false);
    expect((await blocker).rows).toHaveLength(1);
    await removal;
    await expect(sql`select * from app.read_aml_internal_report(${id}, ${officer.id})`.execute(db)).rejects.toMatchObject({ code: '42501' });
  });
});
