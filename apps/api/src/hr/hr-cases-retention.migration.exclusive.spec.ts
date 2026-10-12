import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl, testEnv, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database } from '../database/schema.js';
import { HrDataCipher } from './hr-data-cipher.js';

describe('HR case and retention database serialization', () => {
  let db: Kysely<Database>, ownerDb: Kysely<Database>, hr: TestAccount, worker: TestAccount;
  let personId: string, caseId: string, membershipId: string, today: string;
  const cipher = new HrDataCipher(testEnv());

  beforeAll(() => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 3);
    ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 2);
  });
  afterAll(async () => { await ownerDb.destroy(); await db.destroy(); });
  beforeEach(async () => {
    hr = await createTestAccount(db, 'staff'); await grantTestRole(db, hr.id, 'hr');
    worker = await createTestAccount(db, 'staff'); await grantTestRole(db, worker.id, 'fee_earner');
    personId = (await sql<{ id: string }>`select app.create_hr_person(${worker.id},${hr.id}) id`.execute(db)).rows[0]!.id;
    today = (await sql<{ today: string }>`select app.london_today()::text today`.execute(db)).rows[0]!.today;
    caseId = randomUUID(); const issue = cipher.seal({ issue: 'Protected concurrency fixture.' }, `hr-case:${caseId}`);
    await sql`select app.create_hr_case(${caseId},${personId},'grievance',${personId},'Policy 2026.1',null::date,
      ${issue.context},${issue.keyVersion}::smallint,${issue.nonce},${issue.ciphertext},${issue.authTag},${hr.id})`.execute(db);
    membershipId = (await ownerDb.selectFrom('hr_case_memberships').select('id').where('case_id','=',caseId)
      .where('account_id','=',hr.id).executeTakeFirstOrThrow()).id;
  });

  it('holds a detail read ahead of concurrent membership revocation', async () => {
    const otherHr = await createTestAccount(db, 'staff'); await grantTestRole(db, otherHr.id, 'hr');
    await sql`select app.add_hr_case_member(${randomUUID()},${caseId},${otherHr.id},'hr_member',
      null,null::smallint,null::bytea,null::bytea,null::bytea,${hr.id})`.execute(db);
    let ended = false; let pending: Promise<unknown> | undefined;
    await db.transaction().execute(async (trx) => {
      await sql`select * from app.read_hr_case(${caseId},${hr.id},'view')`.execute(trx);
      const endingId = randomUUID(), reason = cipher.seal({ reason: 'Concurrent revocation.' }, `hr-case-membership-ending:${endingId}`);
      pending = sql`select app.end_hr_case_member(${endingId},${membershipId},${reason.context},
        ${reason.keyVersion}::smallint,${reason.nonce},${reason.ciphertext},${reason.authTag},${hr.id})`.execute(db)
        .then(() => { ended = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(ended).toBe(false);
    });
    await pending; expect(ended).toBe(true);
  });

  it('serializes a new legal hold behind disposal eligibility and refuses it after disposal', async () => {
    const scheduleId = await dueSchedule(); let settled = false; let code: string | undefined; let pending: Promise<void> | undefined;
    await db.transaction().execute(async (trx) => {
      const runId = randomUUID(); await sql`select * from app.prepare_hr_disposal(${runId},${scheduleId},${hr.id})`.execute(trx);
      const holdId = randomUUID(), sealed = cipher.seal({ authority: 'Court', reason: 'Late legal hold.' }, `hr-legal-hold:${holdId}`);
      pending = sql`select app.record_hr_legal_hold(${holdId},${scheduleId},'imposed','2099-01-01'::date,
        ${sealed.context},${sealed.keyVersion}::smallint,${sealed.nonce},${sealed.ciphertext},${sealed.authTag},${hr.id})`
        .execute(db).then(() => { settled = true; }).catch((error: unknown) => {
          settled = true; code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
        });
      await new Promise((resolve) => setTimeout(resolve, 100)); expect(settled).toBe(false);
      await sql`select app.finalize_hr_disposal(${runId},${hr.id})`.execute(trx);
    });
    await pending;
    expect(code).toBe('P0002');
  });

  it('locks a due case so a racing event cannot survive the disposal tombstone', async () => {
    const scheduleId = await dueSchedule(); let settled = false; let code: string | undefined; let pending: Promise<void> | undefined;
    await db.transaction().execute(async (trx) => {
      const runId = randomUUID(); await sql`select * from app.prepare_hr_disposal(${runId},${scheduleId},${hr.id})`.execute(trx);
      const eventId = randomUUID(), sealed = cipher.seal({ summary: 'Late', details: 'Late event', evidenceReference: null },
        `hr-case-event:${eventId}`);
      pending = sql`select app.record_hr_case_event(${eventId},${caseId},'status','closed',${today}::date,null::uuid,
        ${sealed.context},${sealed.keyVersion}::smallint,${sealed.nonce},${sealed.ciphertext},${sealed.authTag},${hr.id})`
        .execute(db).then(() => { settled = true; }).catch((error: unknown) => {
          settled = true; code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
        });
      await new Promise((resolve) => setTimeout(resolve, 100)); expect(settled).toBe(false);
      await sql`select app.finalize_hr_disposal(${runId},${hr.id})`.execute(trx);
    });
    await pending;
    expect(code).toBe('P0002');
    expect(await ownerDb.selectFrom('hr_case_events').select('id').where('case_id','=',caseId).execute()).toEqual([]);
  });

  async function dueSchedule() {
    const closeId = randomUUID(), close = cipher.seal({ summary: 'Closed', details: 'Closed for retention.', evidenceReference: null },
      `hr-case-event:${closeId}`);
    await sql`select app.record_hr_case_event(${closeId},${caseId},'status','closed','2000-01-01'::date,null::uuid,
      ${close.context},${close.keyVersion}::smallint,${close.nonce},${close.ciphertext},${close.authTag},${hr.id})`.execute(db);
    const ruleId = randomUUID(), rationale = cipher.seal({ rationale: 'Approved minimum test rule.' }, `hr-retention-rule:${ruleId}`);
    await sql`select app.create_hr_retention_rule(${ruleId},'case','1999-01-01'::date,1::smallint,1::smallint,
      'Approved case retention test rule',${rationale.context},${rationale.keyVersion}::smallint,
      ${rationale.nonce},${rationale.ciphertext},${rationale.authTag},${hr.id})`.execute(db);
    const scheduleId = randomUUID(), evidence = cipher.seal({ evidence: 'Closure checked.' }, `hr-retention-schedule:${scheduleId}`);
    await sql`select app.create_hr_retention_schedule(${scheduleId},${personId},${ruleId},${caseId},'2000-01-01'::date,
      ${evidence.context},${evidence.keyVersion}::smallint,${evidence.nonce},${evidence.ciphertext},${evidence.authTag},${hr.id})`.execute(db);
    return scheduleId;
  }
});
