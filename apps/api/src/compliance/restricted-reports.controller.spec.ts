import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, revokeTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { testOwnerDatabaseUrl } from '../../test/database.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { DATABASE } from '../database/database.module.js';
import { createDatabase } from '../database/database.js';
import type { Database, StaffRole } from '../database/schema.js';
import { ComplianceModule } from './compliance.module.js';

@Module({ imports: [ComplianceModule] })
class RestrictedTestModule {}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
const ADDRESS = { address_line1: '1 Test Street', address_line2: null, town: 'London', postcode: 'SW1A 1AA', country: 'GB' };

describe('restricted AML reports API', () => {
  let app: NestExpressApplication, db: Kysely<Database>, ownerDb: Kysely<Database>, sessions: SessionsService;
  let admin: TestAccount, reporter: TestAccount, officer: TestAccount, compliance: TestAccount;
  let reporterToken: string, officerToken: string, complianceToken: string, today: string;
  const cookie = (token: string) => `__Host-session=${token}`;
  const api = (token: string) => ({
    get: (path: string) => request(app.getHttpServer()).get(path).set('Cookie', cookie(token)),
    post: (path: string, body: object) => request(app.getHttpServer()).post(path).set('Cookie', cookie(token)).send(body),
    upload: (path: string) => request(app.getHttpServer()).post(path).set('Cookie', cookie(token)),
  });
  async function staff(...roles: StaffRole[]) {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) await grantTestRole(db, account.id, role);
    return account;
  }
  async function client() {
    return db.transaction().execute(async (trx) => {
      const c = await trx.insertInto('clients').values({ kind: 'individual', created_by: reporter.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({ client_id: c.id, title: null, given_names: 'Restricted',
        family_name: randomUUID(), date_of_birth: '1980-01-01', email: null, phone: null, ...ADDRESS }).execute();
      return c.id;
    });
  }
  const body = (clientId: string) => ({ clientId, matterId: null, financeTransactionId: null, observedOn: today,
    observedFacts: 'I observed facts that may indicate suspicious movement of client money.' });
  const submit = (clientId: string, token = reporterToken) => api(token).post('/compliance/restricted-reports', body(clientId));

  beforeAll(async () => {
    app = await createTestApp(RestrictedTestModule); db = app.get(DATABASE); sessions = app.get(SessionsService);
    ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 1);
  });
  afterAll(async () => { await ownerDb.destroy(); await app.close(); });
  afterEach(async () => {
    await ownerDb.transaction().execute(async (trx) => {
      await sql`select set_config('app.aml_appointment_end', '1', true)`.execute(trx);
      await sql`update app.aml_officer_appointments set ended_by = ${admin.id}, ended_at = clock_timestamp(),
        end_reason = 'Restricted HTTP test fixture cleanup' where appointed_by = ${admin.id} and ended_at is null`.execute(trx);
    });
  });
  beforeEach(async () => {
    today = (await sql<{ today: string }>`select app.london_today()::text as today`.execute(db)).rows[0]!.today;
    admin = await staff('administrator'); reporter = await staff('fee_earner'); officer = await staff('compliance'); compliance = await staff('compliance');
    await sql`select app.appoint_aml_officer(${officer.id}, 'nominated_officer', ${admin.id})`.execute(db);
    [reporterToken, officerToken, complianceToken] = await Promise.all([
      sessions.start(reporter, 'authenticated', {}), sessions.start(officer, 'authenticated', {}), sessions.start(compliance, 'authenticated', {}),
    ]);
  });

  it('lets ordinary active staff submit but gives only a neutral non-readable receipt', async () => {
    const clientId = await client();
    const response = await submit(clientId);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toEqual({ receiptId: expect.any(String), received: true });
    expect(JSON.stringify(response.body)).not.toMatch(/suspicious|client|matter/i);
    expect((await api(reporterToken).get(`/compliance/restricted-reports/${response.body.receiptId}`)).status).toBe(404);
    expect((await api(complianceToken).get('/compliance/restricted-reports')).status).toBe(404);
  });

  it('gives a live nominated officer the separate queue, decrypted detail and access history', async () => {
    const submitted = await submit(await client());
    const listed = await api(officerToken).get('/compliance/restricted-reports');
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toContain('no-store');
    expect(listed.body.reports).toContainEqual(expect.objectContaining({ id: submitted.body.receiptId, decided: false }));
    const detail = await api(officerToken).get(`/compliance/restricted-reports/${submitted.body.receiptId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.observedFacts).toContain('suspicious movement');
    const access = await api(officerToken).get(`/compliance/restricted-reports/${submitted.body.receiptId}/accesses`);
    expect(access.body.accesses).toContainEqual(expect.objectContaining({ action: 'view', accessedBy: officer.id }));
  });

  it('records one permanent decision, external SAR and append-only DAML events', async () => {
    const clientId = await client();
    const reportId = (await submit(clientId)).body.receiptId;
    const decision = await api(officerToken).post(`/compliance/restricted-reports/${reportId}/decision`, {
      externalReportRequired: true, legalGrounds: 'The observed facts create knowledge or suspicion under the applicable reporting duty.', imposeHold: true,
    });
    expect(decision.status, JSON.stringify(decision.body)).toBe(201);
    expect(decision.body.decision).toMatchObject({ externalReportRequired: true, decidedBy: officer.id });
    expect((await api(officerToken).post(`/compliance/restricted-reports/${reportId}/decision`, {
      externalReportRequired: false, legalGrounds: 'A second decision must not replace the first permanent decision.', imposeHold: false,
    })).status).toBe(409);
    const holds = await api(complianceToken).get('/compliance/holds');
    const restrictedHold = holds.body.holds.find((hold: { clientId: string }) => hold.clientId === clientId);
    expect(restrictedHold.reason).toBe('Protected compliance review');
    expect((await api(complianceToken).post(`/compliance/holds/${restrictedHold.id}/lift`, {
      reason: 'An ordinary Compliance holder must not release a restricted hold',
    })).status).toBe(409);
    const external = await api(officerToken).post(`/compliance/restricted-reports/${reportId}/external-report`, {
      kind: 'sar', reference: 'NCA-REF-RESTRICTED', submittedAt: new Date(Date.now() - 1000).toISOString(), damlDatfRequested: true,
    });
    expect(external.status).toBe(201);
    const externalId = external.body.externalReport.id;
    const event = await api(officerToken).post(`/compliance/restricted-reports/${reportId}/external-report/${externalId}/events`, {
      outcome: 'granted', receivedAt: new Date(Date.now() - 500).toISOString(), expiresAt: null,
      externalReference: 'DAML-REF-1', permittedActivity: 'Complete the specifically described transfer only',
      legalBasis: 'Actual consent was recorded by the nominated officer from the NCA response.',
    });
    expect(event.status).toBe(201);
    expect(event.body.externalReport.events).toContainEqual(expect.objectContaining({ outcome: 'granted', externalReference: 'DAML-REF-1' }));
  });

  it('scans, separately encrypts and restricts an attached fixed copy', async () => {
    const clientId = await client();
    const submitted = await api(reporterToken).upload('/compliance/restricted-reports')
      .field('clientId', clientId).field('matterId', '').field('financeTransactionId', '')
      .field('observedOn', today).field('observedFacts', 'Observed facts requiring confidential nominated officer consideration.')
      .attach('file', PDF, 'internal-note.pdf');
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    const detail = await api(officerToken).get(`/compliance/restricted-reports/${submitted.body.receiptId}`);
    const attachment = detail.body.attachments[0];
    expect(attachment).toMatchObject({ fileName: 'internal-note.pdf', mediaType: 'application/pdf' });
    expect((await api(reporterToken).get(`/compliance/restricted-reports/${submitted.body.receiptId}/attachments/${attachment.id}/content`)).status).toBe(404);
    const download = await api(officerToken).get(`/compliance/restricted-reports/${submitted.body.receiptId}/attachments/${attachment.id}/content`);
    expect(download.status).toBe(200);
    expect(download.headers['cache-control']).toContain('no-store');
    expect(Buffer.from(download.body).equals(PDF)).toBe(true);
  });

  it('refuses an external filing without a report-required decision and DAML events without a request', async () => {
    const reportId = (await submit(await client())).body.receiptId;
    const filing = { kind: 'sar', reference: 'NCA-NOT-YET-AUTHORISED',
      submittedAt: new Date(Date.now() - 1000).toISOString(), damlDatfRequested: false };
    expect((await api(officerToken).post(`/compliance/restricted-reports/${reportId}/external-report`, filing)).status).toBe(409);
    expect((await api(officerToken).post(`/compliance/restricted-reports/${reportId}/decision`, {
      externalReportRequired: true, legalGrounds: 'The nominated officer has determined that an external report is required.', imposeHold: false,
    })).status).toBe(201);
    const external = await api(officerToken).post(`/compliance/restricted-reports/${reportId}/external-report`, filing);
    expect(external.status).toBe(201);
    expect((await api(officerToken).post(`/compliance/restricted-reports/${reportId}/external-report/${external.body.externalReport.id}/events`, {
      outcome: 'requested', receivedAt: new Date(Date.now() - 500).toISOString(), expiresAt: null,
      externalReference: 'NOT-REQUESTED', permittedActivity: null,
      legalBasis: 'No DAML or DATF request was recorded for this external report.',
    })).status).toBe(404);
  });

  it('rechecks the live compliance role and keeps ordinary audit metadata content-free', async () => {
    const reportId = (await submit(await client())).body.receiptId;
    await api(officerToken).get(`/compliance/restricted-reports/${reportId}`);
    const audit = await db.selectFrom('audit_events').select(['action', 'resource_id', 'metadata'])
      .where('action', '=', 'compliance.restricted_record_changed').where('resource_id', '=', reportId).execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toEqual({});
    await sql`select app.appoint_aml_officer(${compliance.id}, 'nominated_officer', ${admin.id})`.execute(db);
    await revokeTestRole(db, officer.id, 'compliance');
    expect((await api(officerToken).get(`/compliance/restricted-reports/${reportId}`)).status).toBe(404);
  });
});
