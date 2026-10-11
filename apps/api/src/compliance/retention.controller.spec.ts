import { createHash, randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { testOwnerDatabaseUrl } from '../../test/database.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { DATABASE } from '../database/database.module.js';
import { createDatabase } from '../database/database.js';
import type { Database, StaffRole } from '../database/schema.js';
import { ComplianceModule } from './compliance.module.js';

@Module({ imports: [ComplianceModule] })
class RetentionTestModule {}

const ADDRESS = { address_line1: '1 Test Street', address_line2: null, town: 'London', postcode: 'SW1A 1AA', country: 'GB' };

describe('AML retention and regulatory export API', () => {
  let app: NestExpressApplication, db: Kysely<Database>, ownerDb: Kysely<Database>, sessions: SessionsService;
  let admin: TestAccount, compliance: TestAccount, feeEarner: TestAccount, officer: TestAccount;
  let complianceToken: string, feeToken: string, officerToken: string;
  const cookie = (token: string) => `__Host-session=${token}`;
  const api = (token: string) => ({
    get: (path: string) => request(app.getHttpServer()).get(path).set('Cookie', cookie(token)),
    post: (path: string, body: object) => request(app.getHttpServer()).post(path).set('Cookie', cookie(token)).send(body),
  });

  async function staff(...roles: StaffRole[]) {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) await grantTestRole(db, account.id, role);
    return account;
  }

  async function client() {
    return db.transaction().execute(async (trx) => {
      const created = await trx.insertInto('clients').values({ kind: 'individual', created_by: compliance.id })
        .returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({ client_id: created.id, title: null, given_names: 'Retention',
        family_name: randomUUID(), date_of_birth: '1980-01-01', email: null, phone: null, ...ADDRESS }).execute();
      return created.id;
    });
  }

  const schedule = (clientId: string) => api(complianceToken).post('/compliance/retention', {
    clientId, relationshipEndedOn: '2016-01-01', retentionYears: 5,
    governingRule: 'MLR 2017 regulation 40 five-year retention rule',
    evidence: 'The signed engagement-end letter was checked against the closed client file.',
  });

  beforeAll(async () => {
    app = await createTestApp(RetentionTestModule); db = app.get(DATABASE); sessions = app.get(SessionsService);
    ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 1);
  });
  afterAll(async () => { await ownerDb.destroy(); await app.close(); });
  afterEach(async () => {
    await ownerDb.transaction().execute(async (trx) => {
      await sql`select set_config('app.aml_appointment_end', '1', true)`.execute(trx);
      await sql`update app.aml_officer_appointments set ended_by=${admin.id},ended_at=clock_timestamp(),
        end_reason='Retention HTTP test fixture cleanup' where appointed_by=${admin.id} and ended_at is null`.execute(trx);
    });
  });
  beforeEach(async () => {
    admin = await staff('administrator'); compliance = await staff('compliance');
    feeEarner = await staff('fee_earner'); officer = await staff('compliance');
    await sql`select app.appoint_aml_officer(${officer.id},'nominated_officer',${admin.id})`.execute(db);
    [complianceToken, feeToken, officerToken] = await Promise.all([
      sessions.start(compliance, 'authenticated', {}), sessions.start(feeEarner, 'authenticated', {}),
      sessions.start(officer, 'authenticated', {}),
    ]);
  });

  it('limits retention work to Compliance and archives a client only when the relationship can end', async () => {
    const clientId = await client();
    expect((await api(feeToken).get('/compliance/retention')).status).toBe(403);
    expect((await api(feeToken).get('/compliance/clients')).status).toBe(403);
    const choices = await api(complianceToken).get('/compliance/clients');
    expect(choices.status, JSON.stringify(choices.body)).toBe(200);
    expect(choices.body.clients).toContainEqual(expect.objectContaining({ id: clientId, kind: 'individual' }));
    expect((await api(feeToken).post('/compliance/retention', {
      clientId, relationshipEndedOn: '2016-01-01', retentionYears: 5,
      governingRule: 'MLR 2017 regulation 40 five-year retention rule',
      evidence: 'The relationship end is evidenced in the closed client file.',
    })).status).toBe(403);
    expect((await api(complianceToken).post('/compliance/retention', {
      clientId, relationshipEndedOn: '2016-01-01', retentionYears: 6,
      governingRule: 'An unsupported extension must not retain the whole AML file',
      evidence: 'The ordinary five-year period cannot be lengthened by this free-text assertion.',
    })).status).toBe(400);

    const created = await schedule(clientId);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ clientId, relationshipEndedOn: '2016-01-01',
      disposeAfter: '2021-01-01', retentionYears: 5, holds: [] });
    expect((await db.selectFrom('clients').select('status').where('id', '=', clientId)
      .executeTakeFirstOrThrow()).status).toBe('archived');
    const raw = await ownerDb.selectFrom('aml_retention_schedules').select('evidence_ciphertext')
      .where('id', '=', created.body.id).executeTakeFirstOrThrow();
    expect(raw.evidence_ciphertext.toString('utf8')).not.toContain('engagement-end letter');
    expect((await api(complianceToken).get('/compliance/access')).body.attentionCount).toBeGreaterThanOrEqual(1);
  });

  it('keeps legal holds as permanent events and refuses disposal until release', async () => {
    const created = await schedule(await client());
    const path = `/compliance/retention/${created.body.id}`;
    const imposed = await api(complianceToken).post(`${path}/legal-holds`, { action: 'imposed', reviewOn: '2030-01-01',
      authority: 'Court proceedings file', reason: 'The evidence remains necessary for live proceedings.' });
    expect(imposed.status, JSON.stringify(imposed.body)).toBe(201);
    expect(imposed.body.holds).toHaveLength(1);
    expect((await api(complianceToken).post(`${path}/dispose`, {})).status).toBe(409);
    expect((await api(complianceToken).post(`${path}/legal-holds`, { action: 'released', reviewOn: null,
      authority: 'Court proceedings file', reason: 'The proceedings ended and the hold authority confirmed release.' })).status).toBe(201);
    const disposed = await api(complianceToken).post(`${path}/dispose`, {});
    expect(disposed.status, JSON.stringify(disposed.body)).toBe(201);
    expect(disposed.body).toMatchObject({ scheduleId: created.body.id, state: 'completed' });
  });

  it('creates an encrypted, fixed ordinary export with restrictive and verifiable download headers', async () => {
    const clientId = await client();
    const created = await api(complianceToken).post('/compliance/exports', { clientId,
      reason: 'Respond to a documented request from the firm AML supervisor.' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const raw = await ownerDb.selectFrom('aml_exports').select(['ciphertext', 'sha256'])
      .where('id', '=', created.body.id).executeTakeFirstOrThrow();
    expect(raw.ciphertext.toString('utf8')).not.toContain('ordinary_aml');

    const downloaded = await api(complianceToken).get(`/compliance/exports/${created.body.id}/content`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['cache-control']).toContain('no-store');
    expect(downloaded.headers['content-disposition']).toContain('attachment');
    const body = Buffer.from(downloaded.text, 'utf8');
    expect(createHash('sha256').update(body).digest('hex')).toBe(created.body.sha256);
    expect(JSON.parse(downloaded.text)).toMatchObject({ schemaVersion: 1, kind: 'ordinary_aml', clientId });
  });

  it('never mixes a restricted report into the ordinary export and restricts its separate export to an officer', async () => {
    const clientId = await client();
    const beforeAttention = (await api(complianceToken).get('/compliance/access')).body.attentionCount;
    const report = await api(feeToken).post('/compliance/restricted-reports', { clientId, matterId: null,
      financeTransactionId: null, observedOn: '2026-01-01',
      observedFacts: 'Restricted facts that must never appear in an ordinary AML export.' });
    expect(report.status).toBe(201);
    expect((await api(complianceToken).get('/compliance/access')).body.attentionCount).toBe(beforeAttention);
    const ordinary = await api(complianceToken).post('/compliance/exports', { clientId,
      reason: 'Provide ordinary due-diligence records to the AML supervisor.' });
    const ordinaryBody = await api(complianceToken).get(`/compliance/exports/${ordinary.body.id}/content`);
    expect(ordinaryBody.text).not.toContain('Restricted facts');
    expect(ordinaryBody.text).not.toContain(report.body.receiptId);

    expect((await api(complianceToken).post(`/compliance/restricted-reports/${report.body.receiptId}/exports`, {
      reason: 'Provide the protected report to the competent authority.',
    })).status).toBe(404);
    const restricted = await api(officerToken).post(`/compliance/restricted-reports/${report.body.receiptId}/exports`, {
      reason: 'Provide the protected report to the competent authority.',
    });
    expect(restricted.status, JSON.stringify(restricted.body)).toBe(201);
    const downloaded = await api(officerToken).get(`/compliance/restricted-reports/${report.body.receiptId}/exports/${restricted.body.id}/content`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.text).toContain('Restricted facts');
    const accesses = await api(officerToken).get(`/compliance/restricted-reports/${report.body.receiptId}/accesses`);
    expect(accesses.body.accesses).toContainEqual(expect.objectContaining({ action: 'export', accessedBy: officer.id }));
  });
});
