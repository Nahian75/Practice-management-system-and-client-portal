import { createHash, randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { ComplianceModule } from './compliance.module.js';

@Module({ imports: [ComplianceModule] })
class RiskTestModule {}

const CONTROL_KINDS = ['ml_tf_risk_assessment', 'proliferation_financing_risk_assessment',
  'sanctions_risk_assessment', 'aml_policy', 'sanctions_policy'];

/** Ten distinct, specific answers: copied text is refused. */
const narrative = (overrides: Record<string, string | null> = {}) => ({
  scopeReason: 'Advice on an employment dispute is not a regulated-sector service.',
  clientRisk: 'Long-standing individual client resident in England with no controllers.',
  serviceRisk: 'Face-to-face litigation advice with no property or company formation.',
  purposeAndNature: 'Single employment tribunal claim expected to last about six months.',
  fundingRisk: 'Fees paid from the client salary account; no third-party funding.',
  sanctionsExposure: 'No counterparties or funds connected with a designated person.',
  rationale: 'Ordinary contentious work for a known client with transparent funding.',
  mitigations: 'Payments accepted only from the verified client account.',
  requiredChecks: 'Standard identity verification already held on the CDD record.',
  monitoringPlan: 'Fee earner reviews funding at each bill and on any change of purpose.',
  loweringGrounds: null,
  ...overrides,
});
const factors = (overrides: Record<string, boolean> = {}) => ({
  pep: false, unusualTransactions: false, complexStructure: false, cash: false,
  remoteInstruction: false, adverseInformation: false, sanctionsExposure: false, thirdPartyFunding: false, ...overrides,
});

describe('AML risk assessment API', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let compliance: TestAccount;
  let accounts: TestAccount;
  let partnerToken: string;
  let feeToken: string;
  let complianceToken: string;
  let accountsToken: string;
  let today: string;
  let inAYear: string;

  const cookie = (token: string) => `__Host-session=${token}`;
  const api = (token: string) => {
    const server = request(app.getHttpServer());
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie(token)),
      post: (path: string, body: object) => server.post(path).set('Cookie', cookie(token)).send(body),
    };
  };

  async function staffWith(...roles: StaffRole[]) {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) await grantTestRole(db, account.id, role);
    return account;
  }

  async function matter() {
    return db.transaction().execute(async (trx) => {
      const client = await trx.insertInto('clients').values({ kind: 'individual', created_by: feeEarner.id })
        .returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({
        client_id: client.id, given_names: randomUUID(), family_name: randomUUID(), date_of_birth: '1980-01-02',
        address_line1: '1 Test Street', town: 'London', postcode: 'SW1A 1AA', country: 'GB',
      }).execute();
      const check = await trx.insertInto('conflict_checks').values({ client_id: client.id, requested_by: feeEarner.id, names: [randomUUID()] })
        .returning('id').executeTakeFirstOrThrow();
      const created = await trx.insertInto('matters').values({ client_id: client.id, title: 'Risk', matter_type: 'employment',
        opened_by: feeEarner.id, conflict_check_id: check.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('matter_team').values([
        { matter_id: created.id, account_id: feeEarner.id, role: 'fee_earner', added_by: feeEarner.id },
        { matter_id: created.id, account_id: partner.id, role: 'supervising_partner', added_by: feeEarner.id },
      ]).execute();
      return created.id;
    });
  }

  const assessment = (overrides: Record<string, unknown> = {}) => ({
    inScope: false, rating: 'standard', factors: factors(), jurisdictions: ['GB'], expectedValue: 'under_10k',
    reviewDueOn: inAYear, reviewGraceDays: 30, narrative: narrative(), ...overrides,
  });
  /** Makes `countries` the latest approved list, which is the one an assessment uses. */
  async function currentCountryList(countries: string[], preparer = compliance, approver = partner) {
    const id = (await sql<{ id: string }>`select app.create_aml_country_list(
      ${countries}::text[], 'Test list', ${today}::date, ${preparer.id}) as id`.execute(db)).rows[0]!.id;
    await sql`select app.approve_aml_country_list(${id}, ${approver.id})`.execute(db);
  }
  const submit = (token: string, matterId: string, body: object = assessment()) =>
    api(token).post(`/matters/${matterId}/aml-risk`, body);

  beforeAll(async () => {
    app = await createTestApp(RiskTestModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
    ({ today, inAYear } = (await sql<{ today: string; inAYear: string }>`select app.london_today()::text as today,
      (app.london_today() + 365)::text as "inAYear"`.execute(db)).rows[0]!);
    const preparer = await staffWith('compliance');
    const approver = await staffWith('partner');
    for (const kind of CONTROL_KINDS) {
      const content = `Risk API ${kind} ${randomUUID()}`;
      const id = (await sql<{ id: string }>`select app.create_aml_control_version(
        ${kind}, 'Current control', ${content}, ${createHash('sha256').update(content).digest()},
        'Test source', ${today}::date, '2099-12-31'::date, ${preparer.id}
      ) as id`.execute(db)).rows[0]!.id;
      await sql`select app.approve_aml_control_version(${id}, ${approver.id})`.execute(db);
    }
    await currentCountryList(['QZ'], preparer, approver);
  });
  afterAll(async () => app.close());
  beforeEach(async () => {
    partner = await staffWith('partner');
    feeEarner = await staffWith('fee_earner');
    compliance = await staffWith('compliance');
    accounts = await staffWith('accounts');
    [partnerToken, feeToken, complianceToken, accountsToken] = await Promise.all([
      sessions.start(partner, 'authenticated', {}), sessions.start(feeEarner, 'authenticated', {}),
      sessions.start(compliance, 'authenticated', {}), sessions.start(accounts, 'authenticated', {}),
    ]);
  });

  it('lets Compliance publish a sorted country list and a different partner approve it', async () => {
    expect((await api(accountsToken).post('/compliance/country-lists', { countries: ['IR'], source: 'FATF', effectiveFrom: today })).status).toBe(403);
    expect((await api(complianceToken).post('/compliance/country-lists', { countries: ['IR', 'IR'], source: 'FATF', effectiveFrom: today })).status).toBe(400);

    const created = await api(complianceToken).post('/compliance/country-lists',
      { countries: ['MM', 'IR', 'KP'], source: 'FATF high-risk jurisdictions subject to a call for action', effectiveFrom: today });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ countries: ['IR', 'KP', 'MM'], approval: null });

    const pending = await api(partnerToken).get('/compliance/country-lists/pending-approval');
    expect(pending.body.countryLists.map((list: { id: string }) => list.id)).toContain(created.body.id);
    expect((await api(feeToken).post(`/compliance/country-lists/${created.body.id}/approval`, {})).status).toBe(403);
    const approved = await api(partnerToken).post(`/compliance/country-lists/${created.body.id}/approval`, {});
    expect(approved.status).toBe(201);
    expect(approved.body.approval).toMatchObject({ approvedBy: { accountId: partner.id } });
    expect((await api(partnerToken).post(`/compliance/country-lists/${created.body.id}/approval`, {})).status).toBe(409);
  });

  it('records an assessment for a team member and shows narratives only in detail', async () => {
    const matterId = await matter();
    const created = await submit(feeToken, matterId);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ version: 1, inScope: false, rating: 'standard',
      factors: { highRiskCountry: false }, preparedBy: { accountId: feeEarner.id } });
    expect(created.body.controls).toHaveLength(5);

    const listed = await api(partnerToken).get(`/matters/${matterId}/aml-risk`);
    expect(listed.status).toBe(200);
    expect(listed.body.assessments[0]).not.toHaveProperty('narrative');
    expect(JSON.stringify(listed.body)).not.toContain('employment dispute');
    const detail = await api(complianceToken).get(`/matters/${matterId}/aml-risk/${created.body.id}`);
    expect(detail.body.narrative.scopeReason).toContain('employment dispute');

    const raw = await db.selectFrom('aml_risk_assessments').select('ciphertext').where('id', '=', created.body.id).executeTakeFirstOrThrow();
    expect(raw.ciphertext.toString('utf8')).not.toContain('employment dispute');
    const audit = await db.selectFrom('audit_events').select(['action', 'metadata']).where('resource_id', '=', created.body.id).execute();
    expect(audit).toEqual([{ action: 'aml.risk_submitted', metadata: { matterId, version: 1 } }]);
  });

  it('hides matters outside the caller’s team and refuses roles without the permission', async () => {
    const matterId = await matter();
    const outsider = await staffWith('fee_earner');
    const outsiderToken = await sessions.start(outsider, 'authenticated', {});

    expect((await submit(outsiderToken, matterId)).status).toBe(404);
    expect((await api(outsiderToken).get(`/matters/${matterId}/aml-risk`)).status).toBe(404);
    expect((await submit(feeToken, randomUUID())).status).toBe(404);
    expect((await submit(accountsToken, matterId)).status).toBe(403);
    expect((await submit(complianceToken, matterId)).status).toBe(201);
  });

  it('refuses copied answers and a non-high rating for mandatory high-risk factors', async () => {
    const matterId = await matter();
    await currentCountryList(['QZ']);
    const copied = narrative({ mitigations: 'Ordinary contentious work for a known client with transparent funding.' });

    expect((await submit(feeToken, matterId, assessment({ narrative: copied }))).status).toBe(400);
    expect((await submit(feeToken, matterId, assessment({ factors: factors({ pep: true }) }))).status).toBe(400);
    expect((await submit(feeToken, matterId, assessment({ jurisdictions: ['GB', 'QZ'] }))).status).toBe(409);
    const listed = await submit(feeToken, matterId, assessment({ jurisdictions: ['GB', 'QZ'], rating: 'high' }));
    expect(listed.status).toBe(201);
    expect(listed.body.factors.highRiskCountry).toBe(true);
  });

  it('needs submitted CDD for in-scope work and grounds to lower a rating', async () => {
    const matterId = await matter();
    expect((await submit(feeToken, matterId, assessment({ inScope: true }))).status).toBe(409);

    expect((await submit(feeToken, matterId, assessment({ rating: 'high' }))).status).toBe(201);
    expect((await submit(feeToken, matterId, assessment({ rating: 'low' }))).status).toBe(409);
    const lowered = await submit(feeToken, matterId, assessment({ rating: 'low',
      narrative: narrative({ loweringGrounds: 'The suspected third-party payer was confirmed to be the client.' }) }));
    expect(lowered.status).toBe(201);
    expect(lowered.body).toMatchObject({ version: 2, lowersPrevious: true });
  });
});
