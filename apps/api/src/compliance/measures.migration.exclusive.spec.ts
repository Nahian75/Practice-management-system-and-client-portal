import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestAccount } from '../../test/accounts.js';
import {
  addTestMeasure, approveAmlFramework, createAmlStaff, createTeamMatter, recordTestMeasureResult,
  recordTestSourceConclusion, submitTestAssessment, submitTestCdd,
} from '../../test/aml.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database } from '../database/schema.js';

describe('CDD/EDD measure database rules', () => {
  let db: Kysely<Database>;
  let owner: Kysely<Database>;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let compliance: TestAccount;

  beforeAll(async () => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 4);
    owner = createDatabase<Database>(testOwnerDatabaseUrl(), 2);
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

  async function inScopeAssessment() {
    const { matterId, clientId } = await createTeamMatter(db, feeEarner, partner);
    const cdd = await submitTestCdd(db, clientId, compliance.id);
    const assessmentId = await submitTestAssessment(db, matterId, feeEarner.id, { inScope: true });
    return { matterId, clientId, assessmentId, ...cdd };
  }

  it('records append-only measures, results and conclusions linked to the relied-on CDD case', async () => {
    const { assessmentId, evidenceId, subjectId } = await inScopeAssessment();
    const measureId = await addTestMeasure(db, assessmentId, 'identity', feeEarner.id);
    await recordTestMeasureResult(db, measureId, feeEarner.id, 'not_satisfied');
    await recordTestMeasureResult(db, measureId, partner.id, 'satisfied', [evidenceId]);
    await recordTestSourceConclusion(db, assessmentId, feeEarner.id, { subjectId, evidenceIds: [evidenceId] });

    const results = await db.selectFrom('aml_measure_results').select(['outcome', 'recorded_by']).where('measure_id', '=', measureId)
      .orderBy('recorded_at').execute();
    expect(results).toEqual([
      { outcome: 'not_satisfied', recorded_by: feeEarner.id },
      { outcome: 'satisfied', recorded_by: partner.id },
    ]);
  });

  it('refuses evidence and people from another CDD case', async () => {
    const { assessmentId } = await inScopeAssessment();
    const other = await inScopeAssessment();
    const measureId = await addTestMeasure(db, assessmentId, 'identity', feeEarner.id);

    await expect(recordTestMeasureResult(db, measureId, feeEarner.id, 'satisfied', [other.evidenceId]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(recordTestSourceConclusion(db, assessmentId, feeEarner.id, { subjectId: other.subjectId }))
      .rejects.toMatchObject({ code: '23514' });
    await expect(recordTestSourceConclusion(db, assessmentId, feeEarner.id, { subjectId: null }))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('allows no evidence links when the assessment relies on no CDD case', async () => {
    const { matterId } = await createTeamMatter(db, feeEarner, partner);
    const assessmentId = await submitTestAssessment(db, matterId, feeEarner.id);
    const measureId = await addTestMeasure(db, assessmentId, 'purpose_nature', feeEarner.id);

    await expect(recordTestMeasureResult(db, measureId, feeEarner.id, 'satisfied', [randomUUID()]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(recordTestMeasureResult(db, measureId, feeEarner.id)).resolves.toEqual(expect.any(String));
  });

  it('works only on the latest assessment of an open matter the actor can see', async () => {
    const { matterId, assessmentId } = await inScopeAssessment();
    const outsider = await createAmlStaff(db, 'fee_earner');
    await expect(addTestMeasure(db, assessmentId, 'identity', outsider.id)).rejects.toMatchObject({ code: '42501' });

    const measureId = await addTestMeasure(db, assessmentId, 'identity', feeEarner.id);
    await submitTestAssessment(db, matterId, feeEarner.id, { inScope: true });
    await expect(addTestMeasure(db, assessmentId, 'identity', feeEarner.id)).rejects.toMatchObject({ code: '23514' });
    await expect(recordTestMeasureResult(db, measureId, feeEarner.id)).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses direct writes and keeps every row immutable for the owner', async () => {
    const { assessmentId } = await inScopeAssessment();
    const measureId = await addTestMeasure(db, assessmentId, 'identity', feeEarner.id);
    await expect(sql`insert into app.aml_measures(id, assessment_id, kind, encryption_context, key_version, nonce, ciphertext, auth_tag, recorded_by)
      values (${randomUUID()}, ${assessmentId}, 'identity', 'x', 1, ${Buffer.alloc(12)}, ${Buffer.alloc(2)}, ${Buffer.alloc(16)}, ${feeEarner.id})`
      .execute(owner)).rejects.toMatchObject({ code: '42501' });
    await expect(owner.updateTable('aml_measures').set({ kind: 'other' } as never).where('id', '=', measureId).execute())
      .rejects.toMatchObject({ code: '42501' });
    await expect(owner.deleteFrom('aml_measures').where('id', '=', measureId).execute()).rejects.toMatchObject({ code: '42501' });
    await expect(sql`truncate app.aml_source_conclusions cascade`.execute(owner)).rejects.toMatchObject({ code: '42501' });
  });
});
