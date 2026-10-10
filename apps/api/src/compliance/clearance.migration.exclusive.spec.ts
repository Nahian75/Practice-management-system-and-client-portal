import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestAccount } from '../../test/accounts.js';
import {
  addTestMeasure, approveAmlFramework, approveTestSenior, createAmlStaff, createTeamMatter, decideTestClearance,
  londonDates, recordTestMeasureResult, recordTestSourceConclusion, submitTestAssessment, submitTestCdd,
} from '../../test/aml.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database } from '../database/schema.js';

describe('clearance and compliance gate database rules', () => {
  let db: Kysely<Database>;
  let owner: Kysely<Database>;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let compliance: TestAccount;
  let today: string;

  const gate = async (matterId: string) => (await sql<{ state: string; due_since: string | null; work_allowed_until: string | null }>`
    select state, due_since::text, work_allowed_until::text from app.aml_gate(${matterId})`.execute(db)).rows[0]!;

  /** A complete in-scope standard assessment whose three required measures are satisfied. */
  async function readyInScope(options: Parameters<typeof submitTestAssessment>[3] = {}, preparerId = feeEarner.id) {
    const { matterId, clientId } = await createTeamMatter(db, feeEarner, partner);
    const cdd = await submitTestCdd(db, clientId, compliance.id);
    const assessmentId = await submitTestAssessment(db, matterId, preparerId, { inScope: true, ...options });
    for (const kind of ['identity', 'beneficial_ownership', 'purpose_nature']) {
      await recordTestMeasureResult(db, await addTestMeasure(db, assessmentId, kind, feeEarner.id), feeEarner.id, 'satisfied', [cdd.evidenceId]);
    }
    return { matterId, clientId, assessmentId, ...cdd };
  }

  beforeAll(async () => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 4);
    owner = createDatabase<Database>(testOwnerDatabaseUrl(), 2);
    ({ today } = await londonDates(db));
    await approveAmlFramework(db);
  });
  afterAll(async () => {
    await owner.destroy();
    await db.destroy();
  });
  beforeEach(async () => {
    partner = await createAmlStaff(db, 'partner');
    feeEarner = await createAmlStaff(db, 'fee_earner');
    compliance = await createAmlStaff(db, 'compliance');
  });

  it('keeps a matter pending until a separate Compliance holder clears complete work', async () => {
    const { matterId, assessmentId } = await readyInScope();
    expect((await gate(matterId)).state).toBe('pending');

    await expect(decideTestClearance(db, assessmentId, partner.id)).rejects.toMatchObject({ code: '42501' });
    // Complete work, so only the rule against clearing one's own assessment can refuse it.
    const preparer = await createAmlStaff(db, 'compliance');
    const own = await readyInScope({}, preparer.id);
    await expect(decideTestClearance(db, own.assessmentId, preparer.id)).rejects.toMatchObject({ code: '23514' });
    await expect(decideTestClearance(db, own.assessmentId, compliance.id)).resolves.toEqual(expect.any(String));

    const { assessmentId: ready, matterId: readyMatter } = await readyInScope();
    const clearanceId = await decideTestClearance(db, ready, compliance.id);
    const clearance = await db.selectFrom('aml_clearances').selectAll().where('id', '=', clearanceId).executeTakeFirstOrThrow();
    expect(clearance).toMatchObject({ decision: 'approved', needs_senior: false });
    expect(clearance.relied_measure_results).toHaveLength(3);
    expect(await gate(readyMatter)).toMatchObject({ state: 'cleared', due_since: null });
  });

  it('refuses unfinished, missing or unsatisfied measures', async () => {
    const { matterId } = await createTeamMatter(db, feeEarner, partner);
    const { clientId } = (await db.selectFrom('matters').select('client_id as clientId').where('id', '=', matterId).executeTakeFirstOrThrow());
    await submitTestCdd(db, clientId, compliance.id);
    const missing = await submitTestAssessment(db, matterId, feeEarner.id, { inScope: true });
    await expect(decideTestClearance(db, missing, compliance.id)).rejects.toMatchObject({ code: '23514' });

    const { assessmentId } = await readyInScope();
    const extra = await addTestMeasure(db, assessmentId, 'other', feeEarner.id);
    await expect(decideTestClearance(db, assessmentId, compliance.id)).rejects.toMatchObject({ code: '23514' });
    await recordTestMeasureResult(db, extra, feeEarner.id, 'not_satisfied');
    await expect(decideTestClearance(db, assessmentId, compliance.id)).rejects.toMatchObject({ code: '23514' });
    await recordTestMeasureResult(db, extra, feeEarner.id, 'satisfied');
    await expect(decideTestClearance(db, assessmentId, compliance.id)).resolves.toEqual(expect.any(String));
  });

  it('requires enhanced measures, source of funds and a different partner for high risk', async () => {
    const { matterId, assessmentId, subjectId, evidenceId } = await readyInScope({ rating: 'high' });
    await expect(decideTestClearance(db, assessmentId, compliance.id)).rejects.toMatchObject({ code: '23514' });

    for (const kind of ['enhanced_monitoring', 'transaction_reasons']) {
      await recordTestMeasureResult(db, await addTestMeasure(db, assessmentId, kind, feeEarner.id), feeEarner.id);
    }
    await expect(decideTestClearance(db, assessmentId, compliance.id)).rejects.toMatchObject({ code: '23514' });
    await recordTestSourceConclusion(db, assessmentId, feeEarner.id, { subjectId, evidenceIds: [evidenceId] });
    const clearanceId = await decideTestClearance(db, assessmentId, compliance.id);
    expect((await gate(matterId)).state).toBe('pending');

    const seniorPartner = await createAmlStaff(db, 'partner', 'compliance');
    await expect(approveTestSenior(db, clearanceId, feeEarner.id)).rejects.toMatchObject({ code: '42501' });
    await expect(approveTestSenior(db, clearanceId, seniorPartner.id)).resolves.toBeUndefined();
    expect((await gate(matterId)).state).toBe('cleared');
    await expect(approveTestSenior(db, clearanceId, partner.id)).rejects.toMatchObject({ code: '23505' });
  });

  it('requires source of wealth for a PEP and refuses senior approval by the Compliance approver', async () => {
    const { assessmentId, subjectId } = await readyInScope({ rating: 'high', pep: true, expectedValue: 'none' });
    for (const kind of ['enhanced_monitoring', 'source_of_wealth']) {
      await recordTestMeasureResult(db, await addTestMeasure(db, assessmentId, kind, feeEarner.id), feeEarner.id);
    }
    const approver = await createAmlStaff(db, 'compliance', 'partner');
    await expect(decideTestClearance(db, assessmentId, approver.id)).rejects.toMatchObject({ code: '23514' });
    await recordTestSourceConclusion(db, assessmentId, feeEarner.id, { kind: 'wealth', subjectId });
    const clearanceId = await decideTestClearance(db, assessmentId, approver.id);
    await expect(approveTestSenior(db, clearanceId, approver.id)).rejects.toMatchObject({ code: '23514' });
  });

  it('becomes review_due from the day a relied-on input changes, with the grace period after it', async () => {
    const edited = await readyInScope({ graceDays: 14 });
    await decideTestClearance(db, edited.assessmentId, compliance.id);
    await db.updateTable('client_individuals').set({ town: 'Leeds' }).where('client_id', '=', edited.clientId).execute();
    const expectedUntil = (await sql<{ day: string }>`select (${today}::date + 14)::text as day`.execute(db)).rows[0]!.day;
    expect(await gate(edited.matterId)).toEqual({ state: 'review_due', due_since: today, work_allowed_until: expectedUntil });

    const reassessed = await readyInScope();
    await decideTestClearance(db, reassessed.assessmentId, compliance.id);
    await submitTestAssessment(db, reassessed.matterId, feeEarner.id, { inScope: true });
    expect((await gate(reassessed.matterId)).state).toBe('review_due');

    const newCdd = await readyInScope();
    await decideTestClearance(db, newCdd.assessmentId, compliance.id);
    await submitTestCdd(db, newCdd.clientId, compliance.id);
    expect((await gate(newCdd.matterId)).state).toBe('review_due');
  });

  it('marks every clearance due when a governing control or the country list is superseded', async () => {
    const control = await readyInScope();
    await decideTestClearance(db, control.assessmentId, compliance.id);
    expect((await gate(control.matterId)).state).toBe('cleared');
    await approveAmlFramework(db, null);
    expect((await gate(control.matterId)).state).toBe('review_due');

    const list = await readyInScope();
    await decideTestClearance(db, list.assessmentId, compliance.id);
    await approveAmlFramework(db, ['QY']);
    expect((await gate(list.matterId)).state).toBe('review_due');
  });

  it('refuses clearing a superseded assessment, a second decision and owner edits', async () => {
    const { matterId, assessmentId } = await readyInScope();
    const refused = await decideTestClearance(db, assessmentId, compliance.id, 'refused');
    expect((await gate(matterId)).state).toBe('pending');
    await expect(decideTestClearance(db, assessmentId, compliance.id)).rejects.toMatchObject({ code: '23505' });

    await submitTestAssessment(db, matterId, feeEarner.id, { inScope: true });
    await expect(decideTestClearance(db, assessmentId, compliance.id)).rejects.toMatchObject({ code: '23514' });
    await expect(owner.updateTable('aml_clearances').set({ decision: 'approved' } as never).where('id', '=', refused).execute())
      .rejects.toMatchObject({ code: '42501' });
    await expect(sql`truncate app.aml_client_changes cascade`.execute(owner)).rejects.toMatchObject({ code: '42501' });
  });
});
