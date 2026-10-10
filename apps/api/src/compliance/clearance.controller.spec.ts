import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestAccount } from '../../test/accounts.js';
import {
  addTestMeasure, createAmlStaff, createTeamMatter, ensureAmlFramework, recordTestMeasureResult,
  recordTestSourceConclusion, submitTestAssessment, submitTestCdd,
} from '../../test/aml.js';
import { createTestApp } from '../../test/create-test-app.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import { ComplianceModule } from './compliance.module.js';

@Module({ imports: [ComplianceModule] })
class ClearanceTestModule {}

describe('clearance and gate API', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let compliance: TestAccount;
  let partnerToken: string;
  let feeToken: string;
  let complianceToken: string;

  const cookie = (token: string) => `__Host-session=${token}`;
  const api = (token: string) => {
    const server = request(app.getHttpServer());
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie(token)),
      post: (path: string, body: object) => server.post(path).set('Cookie', cookie(token)).send(body),
    };
  };
  const clearancePath = (matterId: string, assessmentId: string) => `/matters/${matterId}/aml-risk/${assessmentId}/clearance`;
  const approve = { decision: 'approved', reasoning: 'Identity, ownership and purpose are verified and consistent.' };

  /** An in-scope assessment with its required measures satisfied; `high` adds enhanced work. */
  async function ready(rating: 'standard' | 'high' = 'standard') {
    const { matterId, clientId } = await createTeamMatter(db, feeEarner, partner);
    const cdd = await submitTestCdd(db, clientId, compliance.id);
    const assessmentId = await submitTestAssessment(db, matterId, feeEarner.id, { inScope: true, rating });
    const kinds = ['identity', 'beneficial_ownership', 'purpose_nature', ...(rating === 'high' ? ['enhanced_monitoring', 'additional_sources'] : [])];
    for (const kind of kinds) {
      await recordTestMeasureResult(db, await addTestMeasure(db, assessmentId, kind, feeEarner.id), feeEarner.id);
    }
    if (rating === 'high') await recordTestSourceConclusion(db, assessmentId, feeEarner.id, { subjectId: cdd.subjectId });
    return { matterId, assessmentId };
  }

  beforeAll(async () => {
    app = await createTestApp(ClearanceTestModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
    await ensureAmlFramework(db);
  });
  afterAll(async () => app.close());
  beforeEach(async () => {
    partner = await createAmlStaff(db, 'partner');
    feeEarner = await createAmlStaff(db, 'fee_earner');
    compliance = await createAmlStaff(db, 'compliance');
    [partnerToken, feeToken, complianceToken] = await Promise.all([
      sessions.start(partner, 'authenticated', {}), sessions.start(feeEarner, 'authenticated', {}),
      sessions.start(compliance, 'authenticated', {}),
    ]);
  });

  it('lets only Compliance clear, and shows the gate moving from pending to cleared', async () => {
    const { matterId, assessmentId } = await ready();
    expect((await api(feeToken).get(`/matters/${matterId}/aml-gate`)).body).toMatchObject({ state: 'pending', clearanceId: null });
    expect((await api(feeToken).post(clearancePath(matterId, assessmentId), approve)).status).toBe(403);
    expect((await api(partnerToken).post(clearancePath(matterId, assessmentId), approve)).status).toBe(403);

    const cleared = await api(complianceToken).post(clearancePath(matterId, assessmentId), approve);
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(201);
    expect(cleared.body).toMatchObject({ decision: 'approved', needsSenior: false, decidedBy: { accountId: compliance.id } });
    expect(cleared.body.reliedMeasureResults).toHaveLength(3);

    const gate = await api(feeToken).get(`/matters/${matterId}/aml-gate`);
    expect(gate.body).toEqual({ state: 'cleared', dueSince: null, workAllowedUntil: null, clearanceId: cleared.body.id });
    const shown = await api(feeToken).get(clearancePath(matterId, assessmentId));
    expect(shown.body.clearance.reasoning).toContain('verified and consistent');

    const audit = await db.selectFrom('audit_events').select(['action', 'metadata']).where('resource_id', '=', cleared.body.id).execute();
    expect(audit).toEqual([{ action: 'aml.clearance_approved', metadata: { matterId, assessmentId } }]);
  });

  it('needs a partner’s senior approval for high risk before the gate clears', async () => {
    const { matterId, assessmentId } = await ready('high');
    const cleared = await api(complianceToken).post(clearancePath(matterId, assessmentId), approve);
    expect(cleared.body).toMatchObject({ needsSenior: true, seniorApproval: null });
    expect((await api(feeToken).get(`/matters/${matterId}/aml-gate`)).body.state).toBe('pending');

    const outsidePartner = await createAmlStaff(db, 'partner');
    const outsideToken = await sessions.start(outsidePartner, 'authenticated', {});
    expect((await api(feeToken).post(`${clearancePath(matterId, assessmentId)}/senior-approval`, {})).status).toBe(403);
    const approved = await api(outsideToken).post(`${clearancePath(matterId, assessmentId)}/senior-approval`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body.seniorApproval).toMatchObject({ approvedBy: { accountId: outsidePartner.id } });
    expect((await api(feeToken).get(`/matters/${matterId}/aml-gate`)).body.state).toBe('cleared');
  });

  it('answers 409 for incomplete work and 404 for hidden or mismatched records', async () => {
    const { matterId, clientId } = await createTeamMatter(db, feeEarner, partner);
    await submitTestCdd(db, clientId, compliance.id);
    const incomplete = await submitTestAssessment(db, matterId, feeEarner.id, { inScope: true });
    expect((await api(complianceToken).post(clearancePath(matterId, incomplete), approve)).status).toBe(409);

    const other = await createTeamMatter(db, feeEarner, partner);
    const outsider = await createAmlStaff(db, 'fee_earner');
    const outsiderToken = await sessions.start(outsider, 'authenticated', {});
    expect((await api(complianceToken).post(clearancePath(other.matterId, incomplete), approve)).status).toBe(404);
    expect((await api(outsiderToken).get(`/matters/${matterId}/aml-gate`)).status).toBe(404);
    expect((await api(feeToken).get(`/matters/${randomUUID()}/aml-gate`)).status).toBe(404);
    expect((await api(feeToken).get(clearancePath(matterId, incomplete))).body).toEqual({ clearance: null });
  });
});
