import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestAccount } from '../../test/accounts.js';
import { createAmlStaff, ensureAmlFramework, createTeamMatter, submitTestAssessment, submitTestCdd } from '../../test/aml.js';
import { createTestApp } from '../../test/create-test-app.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import { ComplianceModule } from './compliance.module.js';

@Module({ imports: [ComplianceModule] })
class MeasuresTestModule {}

describe('CDD/EDD measures API', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let compliance: TestAccount;
  let feeToken: string;
  let partnerToken: string;

  const cookie = (token: string) => `__Host-session=${token}`;
  const api = (token: string) => {
    const server = request(app.getHttpServer());
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie(token)),
      post: (path: string, body: object) => server.post(path).set('Cookie', cookie(token)).send(body),
    };
  };
  const workPath = (matterId: string, assessmentId: string) => `/matters/${matterId}/aml-risk/${assessmentId}`;

  async function inScopeAssessment() {
    const { matterId, clientId } = await createTeamMatter(db, feeEarner, partner);
    const cdd = await submitTestCdd(db, clientId, compliance.id);
    const assessmentId = await submitTestAssessment(db, matterId, feeEarner.id, { inScope: true, rating: 'high' });
    return { matterId, assessmentId, ...cdd };
  }

  beforeAll(async () => {
    app = await createTestApp(MeasuresTestModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
    await ensureAmlFramework(db);
  });
  afterAll(async () => app.close());
  beforeEach(async () => {
    partner = await createAmlStaff(db, 'partner');
    feeEarner = await createAmlStaff(db, 'fee_earner');
    compliance = await createAmlStaff(db, 'compliance');
    [feeToken, partnerToken] = await Promise.all([
      sessions.start(feeEarner, 'authenticated', {}), sessions.start(partner, 'authenticated', {}),
    ]);
  });

  it('adds a measure, records its result and a source-of-funds conclusion', async () => {
    const { matterId, assessmentId, evidenceId, subjectId } = await inScopeAssessment();
    const added = await api(feeToken).post(`${workPath(matterId, assessmentId)}/measures`,
      { kind: 'source_of_funds', description: 'Trace the purchase deposit to its originating account.' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.measures[0]).toMatchObject({ kind: 'source_of_funds', enhanced: true, results: [] });

    const measureId = added.body.measures[0].id;
    const result = await api(partnerToken).post(`${workPath(matterId, assessmentId)}/measures/${measureId}/results`,
      { outcome: 'satisfied', evidenceIds: [evidenceId], reasoning: 'Statements show salary savings over six years.' });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.measures[0].results[0]).toMatchObject({ outcome: 'satisfied', evidenceIds: [evidenceId],
      recordedBy: { accountId: partner.id } });

    const conclusion = await api(feeToken).post(`${workPath(matterId, assessmentId)}/sources`, {
      kind: 'funds', subjectId, amountMinPence: '5000000', amountMaxPence: '6000000', outcome: 'satisfied',
      evidenceIds: [evidenceId], reasoning: 'Deposit comes from the client savings account shown on statements.' });
    expect(conclusion.status, JSON.stringify(conclusion.body)).toBe(201);
    expect(conclusion.body.conclusions[0]).toMatchObject({ kind: 'funds', amountMaxPence: '6000000' });

    const audit = await db.selectFrom('audit_events').select(['action', 'metadata']).where('resource_id', '=', assessmentId)
      .where('action', 'like', 'aml.%').orderBy('id').execute();
    expect(audit.map((event) => event.action)).toEqual(['aml.measure_added',
      'aml.measure_result_recorded', 'aml.source_conclusion_recorded']);
    expect(JSON.stringify(audit)).not.toMatch(/source_of_funds|savings|5000000/);
  });

  it('answers 404 for a hidden matter or an assessment named under the wrong matter', async () => {
    const { matterId, assessmentId } = await inScopeAssessment();
    const other = await createTeamMatter(db, feeEarner, partner);
    const outsider = await createAmlStaff(db, 'fee_earner');
    const outsiderToken = await sessions.start(outsider, 'authenticated', {});
    const body = { kind: 'identity', description: 'Check the passport against the electoral roll.' };

    expect((await api(outsiderToken).post(`${workPath(matterId, assessmentId)}/measures`, body)).status).toBe(404);
    expect((await api(feeToken).post(`${workPath(other.matterId, assessmentId)}/measures`, body)).status).toBe(404);
    expect((await api(feeToken).get(`${workPath(other.matterId, assessmentId)}/work`)).status).toBe(404);
    expect((await api(feeToken).post(`${workPath(matterId, assessmentId)}/measures/${randomUUID()}/results`,
      { outcome: 'satisfied', evidenceIds: [], reasoning: 'A result for a measure that does not exist.' })).status).toBe(404);
  });

  it('refuses another case’s evidence and work on a superseded assessment', async () => {
    const { matterId, assessmentId } = await inScopeAssessment();
    const other = await inScopeAssessment();
    const measureId = (await api(feeToken).post(`${workPath(matterId, assessmentId)}/measures`,
      { kind: 'identity', description: 'Check the passport against the electoral roll.' })).body.measures[0].id;

    expect((await api(feeToken).post(`${workPath(matterId, assessmentId)}/measures/${measureId}/results`,
      { outcome: 'satisfied', evidenceIds: [other.evidenceId], reasoning: 'Evidence borrowed from another client.' })).status).toBe(409);

    await submitTestAssessment(db, matterId, feeEarner.id, { inScope: true, rating: 'high' });
    expect((await api(feeToken).post(`${workPath(matterId, assessmentId)}/measures`,
      { kind: 'other', description: 'Work recorded against an outdated version.' })).status).toBe(409);
  });

  it('validates amounts and duplicate evidence at the boundary', async () => {
    const { matterId, assessmentId, evidenceId, subjectId } = await inScopeAssessment();
    const base = { kind: 'wealth', subjectId, outcome: 'satisfied', reasoning: 'Inheritance documented by the grant of probate.' };

    expect((await api(feeToken).post(`${workPath(matterId, assessmentId)}/sources`,
      { ...base, amountMinPence: '10', amountMaxPence: '5', evidenceIds: [] })).status).toBe(400);
    expect((await api(feeToken).post(`${workPath(matterId, assessmentId)}/sources`,
      { ...base, amountMinPence: '1', amountMaxPence: '5', evidenceIds: [evidenceId, evidenceId] })).status).toBe(400);
  });
});
