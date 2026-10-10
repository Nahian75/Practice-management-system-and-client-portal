import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestAccount } from '../../test/accounts.js';
import { clearMatterForTests, createAmlStaff, createTeamMatter, ensureAmlFramework, londonDates, submitTestAssessment } from '../../test/aml.js';
import { createTestApp } from '../../test/create-test-app.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { ComplianceModule } from './compliance.module.js';

@Module({ imports: [ComplianceModule, DocumentsModule] })
class GateTestModule {}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

describe('holds, early starts, review queue and gated APIs', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let compliance: TestAccount;
  let partnerToken: string;
  let feeToken: string;
  let complianceToken: string;
  let inAWeek: string;

  const cookie = (token: string) => `__Host-session=${token}`;
  const api = (token: string) => {
    const server = request(app.getHttpServer());
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie(token)),
      post: (path: string, body: object) => server.post(path).set('Cookie', cookie(token)).send(body),
      upload: (path: string) => server.post(path).set('Cookie', cookie(token)),
    };
  };
  const addDocument = (token: string, matterId: string) => api(token).upload(`/matters/${matterId}/documents`)
    .field('title', 'Lease').field('category', 'contract').attach('file', PDF, 'lease.pdf');
  const reason = 'Unexplained change of funding route reported by the bank.';

  beforeAll(async () => {
    app = await createTestApp(GateTestModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
    await ensureAmlFramework(db);
    const { today } = await londonDates(db);
    inAWeek = (await sql<{ day: string }>`select (${today}::date + 7)::text as day`.execute(db)).rows[0]!.day;
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

  it('refuses ordinary work on an uncleared matter with a generic 409', async () => {
    const { matterId } = await createTeamMatter(db, feeEarner, partner);
    const refused = await addDocument(feeToken, matterId);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toBe('Documents are added only to open matters with current compliance clearance');

    await clearMatterForTests(db, matterId);
    expect((await addDocument(feeToken, matterId)).status).toBe(201);
  });

  it('lets Compliance hold and lift a matter, with the same generic refusal while held', async () => {
    const { matterId } = await createTeamMatter(db, feeEarner, partner);
    await clearMatterForTests(db, matterId);
    expect((await api(partnerToken).post('/compliance/holds', { matterId, reason })).status).toBe(403);
    expect((await api(complianceToken).post('/compliance/holds', { reason })).status).toBe(400);

    const held = await api(complianceToken).post('/compliance/holds', { matterId, reason });
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    expect(held.body).toMatchObject({ matterId, lift: null, imposedBy: { accountId: compliance.id } });
    expect((await api(feeToken).get(`/matters/${matterId}/aml-gate`)).body.state).toBe('held');
    expect((await addDocument(feeToken, matterId)).body.message).toBe('Documents are added only to open matters with current compliance clearance');

    const active = await api(complianceToken).get('/compliance/holds');
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    expect(active.body.holds.map((hold: { id: string }) => hold.id)).toContain(held.body.id);
    const lifted = await api(complianceToken).post(`/compliance/holds/${held.body.id}/lift`, { reason: 'Bank confirmed the route belongs to the client.' });
    expect(lifted.body.lift).toMatchObject({ liftedBy: { accountId: compliance.id } });
    expect((await api(complianceToken).post(`/compliance/holds/${held.body.id}/lift`, { reason: 'A second lift of the same hold.' })).status).toBe(409);
    expect((await addDocument(feeToken, matterId)).status).toBe(201);

    const audit = await db.selectFrom('audit_events').select(['action', 'metadata']).where('resource_id', '=', held.body.id).orderBy('id').execute();
    expect(audit).toEqual([{ action: 'aml.hold_imposed', metadata: {} }, { action: 'aml.hold_lifted', metadata: {} }]);
    expect((await api(complianceToken).post('/compliance/holds', { matterId: randomUUID(), reason })).status).toBe(404);
  });

  it('grants and approves an early start that allows documents before clearance', async () => {
    const { matterId } = await createTeamMatter(db, feeEarner, partner);
    const assessmentId = await submitTestAssessment(db, matterId, feeEarner.id);
    const path = `/matters/${matterId}/aml-risk/${assessmentId}/start-exceptions`;
    const body = { permittedActions: ['documents'], expiresOn: inAWeek, grounds: 'Urgent injunction papers must be reviewed before verification ends.' };

    expect((await api(feeToken).post(path, body)).status).toBe(403);
    expect((await api(complianceToken).post(path, { ...body, permittedActions: ['money'] })).status).toBe(400);
    const granted = await api(complianceToken).post(path, body);
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    expect((await addDocument(feeToken, matterId)).status).toBe(409);

    const approved = await api(partnerToken).post(`/matters/${matterId}/start-exceptions/${granted.body.id}/approval`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body.approval).toMatchObject({ approvedBy: { accountId: partner.id } });
    expect((await addDocument(feeToken, matterId)).status).toBe(201);
    expect((await api(feeToken).get(`/matters/${matterId}/aml-gate`)).body.state).toBe('pending');
  });

  it('shows Compliance a review queue of matters needing attention', async () => {
    const { matterId } = await createTeamMatter(db, feeEarner, partner);
    await submitTestAssessment(db, matterId, feeEarner.id);
    expect((await api(partnerToken).get('/compliance/reviews')).status).toBe(403);
    const queue = await api(complianceToken).get('/compliance/reviews');
    expect(queue.status).toBe(200);
    expect(queue.body.matters.find((item: { matterId: string }) => item.matterId === matterId)).toMatchObject({ state: 'pending' });
  });
});
