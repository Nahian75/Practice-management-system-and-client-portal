import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { testOwnerDatabaseUrl } from '../../test/database.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { createDatabase } from '../database/database.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { StaffModule } from '../staff/staff.module.js';
import { ComplianceModule } from './compliance.module.js';

@Module({ imports: [ComplianceModule, StaffModule] })
class ComplianceTestModule {}

describe('Compliance foundations API', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let sessions: SessionsService;
  let administrator: TestAccount;
  let compliance: TestAccount;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let administratorToken: string;
  let complianceToken: string;
  let partnerToken: string;
  let feeEarnerToken: string;
  let today: string;

  const cookie = (token: string) => `__Host-session=${token}`;
  const api = (token: string) => {
    const server = request(app.getHttpServer());
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie(token)),
      post: (path: string, body: object) => server.post(path).set('Cookie', cookie(token)).send(body),
      delete: (path: string) => server.delete(path).set('Cookie', cookie(token)),
    };
  };
  const signedIn = (account: TestAccount) => sessions.start(account, 'authenticated', {});
  async function staffWith(...roles: StaffRole[]) {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) await grantTestRole(db, account.id, role);
    return account;
  }
  const controlBody = (kind = 'training_material') => ({
    kind, title: `Annual AML material ${Date.now()}`, content: 'Line one of the tailored material.\nLine two records the firm evidence.',
    source: 'SRA guidance and the firm risk assessment', effectiveFrom: today, reviewDueOn: '2099-12-31',
  });

  beforeAll(async () => {
    app = await createTestApp(ComplianceTestModule);
    db = app.get(DATABASE);
    ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 1);
    sessions = app.get(SessionsService);
  });
  afterAll(async () => {
    await ownerDb.transaction().execute(async (trx) => {
      await sql`select set_config('app.aml_appointment_end', '1', true)`.execute(trx);
      await sql`update app.aml_officer_appointments
        set ended_by = ${administrator.id}, ended_at = clock_timestamp(), end_reason = 'HTTP test fixture cleanup'
        where ended_at is null`.execute(trx);
    });
    await ownerDb.destroy();
    await app.close();
  });

  beforeEach(async () => {
    today = (await sql<{ today: string }>`select (clock_timestamp() at time zone 'Europe/London')::date::text as today`.execute(db)).rows[0]!.today;
    administrator = await staffWith('administrator');
    compliance = await staffWith('compliance');
    partner = await staffWith('partner');
    feeEarner = await staffWith('fee_earner');
    [administratorToken, complianceToken, partnerToken, feeEarnerToken] = await Promise.all([
      signedIn(administrator), signedIn(compliance), signedIn(partner), signedIn(feeEarner),
    ]);
  });

  it('keeps appointment administration separate from AML content', async () => {
    expect((await api(complianceToken).get('/compliance/officers')).status).toBe(403);
    expect((await api(administratorToken).get('/compliance/controls')).status).toBe(403);
    const appointed = await api(administratorToken).post('/compliance/officers', {
      accountId: compliance.id, kind: 'nominated_officer',
    });
    expect(appointed.status, JSON.stringify(appointed.body)).toBe(201);
    expect(appointed.body).toMatchObject({ account: { accountId: compliance.id }, kind: 'nominated_officer', endedAt: null });
    expect((await api(administratorToken).post('/compliance/officers', {
      accountId: feeEarner.id, kind: 'nominated_officer',
    })).status).toBe(409);
    const successor = await staffWith('compliance');
    const second = await api(administratorToken).post('/compliance/officers', {
      accountId: successor.id, kind: 'nominated_officer',
    });
    expect(second.status).toBe(201);
    const ended = await api(administratorToken).post(`/compliance/officers/${appointed.body.id}/end`, {
      reason: 'Appointment transferred to the successor',
    });
    expect(ended.status).toBe(201);
    expect(ended.body.endedAt).toEqual(expect.any(String));
    const repeated = await api(administratorToken).post(`/compliance/officers/${appointed.body.id}/end`, {
      reason: 'Trying to end the same appointment twice',
    });
    expect(repeated.status).toBe(409);
    expect(repeated.body.message).toBe('This appointment cannot be ended');
  });

  it('protects the sole nominated officer from role removal and account disable', async () => {
    const holder = await staffWith('compliance');
    const appointed = await api(administratorToken).post('/compliance/officers', {
      accountId: holder.id, kind: 'nominated_officer',
    });
    expect(appointed.status).toBe(201);
    // End all other current appointments so this account is the sole eligible holder.
    const all = await api(administratorToken).get('/compliance/officers');
    for (const item of all.body.appointments.filter((value: { id: string; account: { accountId: string }; kind: string; endedAt: string | null }) =>
      value.account.accountId !== holder.id && value.kind === 'nominated_officer' && value.endedAt === null)) {
      expect((await api(administratorToken).post(`/compliance/officers/${item.id}/end`, { reason: 'Test transfer' })).status).toBe(201);
    }
    expect((await api(administratorToken).delete(`/staff/${holder.id}/roles/compliance`)).status).toBe(409);
    expect((await api(administratorToken).post(`/staff/${holder.id}/disable`, {})).status).toBe(409);
  });

  it('publishes immutable numbered controls and requires a different Partner approval', async () => {
    expect((await api(partnerToken).post('/compliance/controls', controlBody())).status).toBe(403);
    const first = await api(complianceToken).post('/compliance/controls', controlBody());
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ version: expect.any(Number), approval: null, contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const second = await api(complianceToken).post('/compliance/controls', controlBody());
    expect(second.status).toBe(201);
    expect(second.body.version).toBe(first.body.version + 1);
    const olderPage = await api(complianceToken).get(`/compliance/controls?before=${second.body.id}`);
    expect(olderPage.status).toBe(200);
    expect(olderPage.body.controls.map((item: { id: string }) => item.id)).toContain(first.body.id);
    expect(olderPage.body.controls.map((item: { id: string }) => item.id)).not.toContain(second.body.id);
    expect(olderPage.body).toHaveProperty('next');
    expect((await api(complianceToken).get('/compliance/controls?before=not-a-uuid')).status).toBe(400);
    expect((await api(feeEarnerToken).get('/compliance/controls/pending-approval')).status).toBe(403);
    const pending = await api(partnerToken).get('/compliance/controls/pending-approval');
    expect(pending.status).toBe(200);
    expect(pending.body.controls.map((item: { id: string }) => item.id)).toContain(first.body.id);
    const approved = await api(partnerToken).post(`/compliance/controls/${first.body.id}/approval`, {});
    expect(approved.status).toBe(201);
    expect(approved.body.approval.approvedBy.accountId).toBe(partner.id);
    expect((await api(partnerToken).post(`/compliance/controls/${first.body.id}/approval`, {})).status).toBe(409);

    const both = await staffWith('compliance', 'partner');
    const bothToken = await signedIn(both);
    const own = await api(bothToken).post('/compliance/controls', controlBody('aml_policy'));
    expect(own.status).toBe(201);
    expect((await api(bothToken).post(`/compliance/controls/${own.body.id}/approval`, {})).status).toBe(409);
  });

  it('publishes owned policies and records each staff acknowledgement once', async () => {
    const policy = await api(complianceToken).post('/compliance/controls', {
      ...controlBody('client_care_policy'), ownerAccountId: compliance.id,
      requiresAcknowledgement: true, acknowledgementDueDays: 14,
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(201);
    expect(policy.body).toMatchObject({ kind: 'client_care_policy', owner: { accountId: compliance.id },
      requiresAcknowledgement: true, acknowledgementDueDays: 14, approval: null });

    expect((await api(feeEarnerToken).post(`/compliance/policies/${policy.body.id}/acknowledgement`, {})).status).toBe(409);
    expect((await api(partnerToken).post(`/compliance/controls/${policy.body.id}/approval`, {})).status).toBe(201);

    const own = await api(feeEarnerToken).get('/compliance/policies/me');
    expect(own.status).toBe(200);
    expect(own.body.policies).toEqual(expect.arrayContaining([expect.objectContaining({
      id: policy.body.id, acknowledgement: null, acknowledgementDueOn: expect.any(String),
    })]));

    const acknowledged = await api(feeEarnerToken)
      .post(`/compliance/policies/${policy.body.id}/acknowledgement`, {});
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(201);
    expect(acknowledged.body).toMatchObject({ controlVersionId: policy.body.id,
      account: { accountId: feeEarner.id } });
    expect((await api(feeEarnerToken)
      .post(`/compliance/policies/${policy.body.id}/acknowledgement`, {})).status).toBe(409);
    expect((await api(feeEarnerToken)
      .get(`/compliance/policies/${policy.body.id}/acknowledgements`)).status).toBe(403);

    const report = await api(complianceToken)
      .get(`/compliance/policies/${policy.body.id}/acknowledgements`);
    expect(report.status).toBe(200);
    expect(report.body.acknowledgements).toEqual([expect.objectContaining({
      controlVersionId: policy.body.id, account: { accountId: feeEarner.id, displayName: expect.any(String) },
    })]);
    const refreshed = await api(feeEarnerToken).get('/compliance/policies/me');
    expect(refreshed.body.policies.find((item: { id: string }) => item.id === policy.body.id).acknowledgement)
      .toMatchObject({ account: { accountId: feeEarner.id } });
  });

  it('rejects unknown fields, unsafe document characters, and unsupported dates', async () => {
    expect((await api(complianceToken).post('/compliance/controls', {
      ...controlBody(), unexpectedApproval: true,
    })).status).toBe(400);
    expect((await api(complianceToken).post('/compliance/controls', {
      ...controlBody(), content: 'Apparently ordinary text\u202Ewith a hidden direction override',
    })).status).toBe(400);
    expect((await api(complianceToken).post('/compliance/controls', {
      ...controlBody(), effectiveFrom: '0001-01-01',
    })).status).toBe(400);
  });

  it('records only approved training material, permits self-attestation, and limits firm-wide lists', async () => {
    const draft = await api(complianceToken).post('/compliance/controls', controlBody());
    expect((await api(feeEarnerToken).post('/compliance/training', {
      materialId: draft.body.id, provider: 'Internal learning team', completedOn: today, evidenceReference: 'Certificate 104',
    })).status).toBe(409);
    expect((await api(partnerToken).post(`/compliance/controls/${draft.body.id}/approval`, {})).status).toBe(201);
    expect((await api(feeEarnerToken).post('/compliance/training', {
      materialId: draft.body.id, provider: 'Internal learning team', completedOn: '2000-01-01', evidenceReference: 'Impossible chronology',
    })).status).toBe(409);
    const completion = await api(feeEarnerToken).post('/compliance/training', {
      materialId: draft.body.id, provider: 'Internal learning team', completedOn: today, evidenceReference: 'Certificate 104',
    });
    expect(completion.status).toBe(201);
    expect(completion.body).toMatchObject({ account: { accountId: feeEarner.id }, recordedBy: { accountId: feeEarner.id } });
    expect((await api(partnerToken).post('/compliance/training', {
      accountId: feeEarner.id, materialId: draft.body.id, provider: 'Partner', completedOn: today, evidenceReference: 'Not allowed',
    })).status).toBe(409);
    expect((await api(feeEarnerToken).get('/compliance/training/me')).body.completions).toHaveLength(1);
    expect((await api(feeEarnerToken).get('/compliance/training')).status).toBe(403);
    expect((await api(complianceToken).get('/compliance/training')).status).toBe(200);
  });

  it('fixes independent-review evidence and audits every successful change', async () => {
    const created = await api(complianceToken).post('/compliance/independent-reviews', {
      periodStart: today, periodEnd: today, completedOn: today, reviewerName: 'External reviewer',
      reviewerOrganisation: 'Independent AML Ltd', independenceBasis: 'No role in designing or operating the reviewed controls',
      scope: 'Firm AML governance and training.\nSampled completed files.', findings: 'The sampled controls operated effectively.',
      recommendations: 'Refresh the geographic risk examples.', managementResponse: 'Accepted for the next policy version.',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await api(partnerToken).get('/compliance/independent-reviews')).status).toBe(403);
    const actions = await db.selectFrom('audit_events').select('action').where('resource_id', '=', created.body.id).execute();
    expect(actions.map((row) => row.action)).toContain('aml.independent_review_recorded');
  });
});
