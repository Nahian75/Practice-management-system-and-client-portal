import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestAccount } from '../../test/accounts.js';
import {
  clearMatterForTests, createAmlStaff, createTeamMatter, ensureAmlFramework, submitTestAssessment, submitTestCdd,
} from '../../test/aml.js';
import { testOwnerDatabaseUrl } from '../../test/database.js';
import { createTestApp } from '../../test/create-test-app.js';
import { sanctionsCsv, type SanctionsRow } from '../../test/sanctions.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { createDatabase } from '../database/database.js';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import { ComplianceModule } from './compliance.module.js';

@Module({ imports: [ComplianceModule] })
class ScreeningTestModule {}

// Names no other test uses, so only these tests' clients can match.
const DESIGNATED: SanctionsRow = { uniqueId: 'TST-ZQF01', names: ['Zebedee', 'QUIXOTIC FARNSWORTH'], dob: '12/03/1961' };

describe('sanctions screening', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let compliance: TestAccount;
  let complianceToken: string;
  let feeToken: string;

  const cookie = (token: string) => `__Host-session=${token}`;
  const api = (token: string) => {
    const server = request(app.getHttpServer());
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie(token)),
      post: (path: string, body: object) => server.post(path).set('Cookie', cookie(token)).send(body),
    };
  };
  /** Activates a new list version: the designations given, plus a filler so the file is always new. */
  async function activateList(rows: SanctionsRow[]) {
    const filler = { uniqueId: `TST-${randomUUID().slice(0, 6)}`, names: ['Filler', `Person ${randomUUID().slice(0, 8)}`] };
    const csv = sanctionsCsv('31-Dec-2099', [...rows, filler]);
    const uploaded = await request(app.getHttpServer()).post('/compliance/sanctions/lists').set('Cookie', cookie(complianceToken))
      .attach('file', Buffer.from(csv), 'UK-Sanctions-List.csv');
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
  }
  /** A matter for a client named like the designated person. */
  async function namedClientMatter(givenNames = 'Zebedee', familyName = 'Quixotic-Farnsworth') {
    const { matterId, clientId } = await createTeamMatter(db, feeEarner, partner);
    await db.updateTable('client_individuals').set({ given_names: givenNames, family_name: familyName, date_of_birth: '1961-03-12' })
      .where('client_id', '=', clientId).execute();
    return { matterId, clientId };
  }
  const screen = (clientId: string) => api(complianceToken).post(`/compliance/sanctions/clients/${clientId}/screenings`, {});
  const openFor = async (clientId: string) => (await api(complianceToken).get('/compliance/sanctions/candidates')).body.candidates
    .filter((candidate: { clientId: string }) => candidate.clientId === clientId);
  const resolve = (candidateId: string, outcome: 'false_positive' | 'confirmed') =>
    api(complianceToken).post(`/compliance/sanctions/candidates/${candidateId}/resolution`,
      { outcome, reasoning: 'Different date of birth and nationality confirmed from the passport.' });
  const gate = async (matterId: string) => (await api(complianceToken).get(`/matters/${matterId}/aml-gate`)).body.state;

  beforeAll(async () => {
    app = await createTestApp(ScreeningTestModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
    await ensureAmlFramework(db);
  });
  afterAll(async () => app.close());
  beforeEach(async () => {
    partner = await createAmlStaff(db, 'partner');
    feeEarner = await createAmlStaff(db, 'fee_earner');
    compliance = await createAmlStaff(db, 'compliance');
    [complianceToken, feeToken] = await Promise.all([
      sessions.start(compliance, 'authenticated', {}), sessions.start(feeEarner, 'authenticated', {}),
    ]);
    await activateList([DESIGNATED]);
  });

  it('holds a matching client until Compliance resolves the candidate', async () => {
    const { matterId, clientId } = await namedClientMatter();
    expect((await api(feeToken).post(`/compliance/sanctions/clients/${clientId}/screenings`, {})).status).toBe(403);
    expect((await screen(clientId)).body).toEqual({ state: 'possible_match' });
    expect(await gate(matterId)).toBe('held');

    const [candidate] = await openFor(clientId);
    expect(candidate).toMatchObject({ uniqueId: 'TST-ZQF01', matchedName: 'Zebedee QUIXOTIC FARNSWORTH', birthAgreement: 'match', subjectRef: 'client' });
    expect((await api(feeToken).post(`/compliance/sanctions/candidates/${candidate.candidateId}/resolution`,
      { outcome: 'false_positive', reasoning: 'A fee earner may not resolve sanctions candidates.' })).status).toBe(403);
    expect((await resolve(candidate.candidateId, 'false_positive')).body).toEqual({ state: 'clear' });
    expect((await resolve(candidate.candidateId, 'false_positive')).status).toBe(409);
    expect(await gate(matterId)).toBe('pending');

    const audit = await db.selectFrom('audit_events').select(['action', 'metadata']).where('resource_id', 'in', [clientId, candidate.candidateId])
      .where('action', 'like', 'aml.screening%').execute();
    expect(audit.map((event) => event.action).sort()).toEqual(['aml.screening_recorded', 'aml.screening_resolved']);
    expect(JSON.stringify(audit)).not.toMatch(/ZQF|QUIXOTIC|possible|false_positive/i);
  });

  it('keeps a confirmed designation held, even after a new list', async () => {
    const { matterId, clientId } = await namedClientMatter();
    await screen(clientId);
    const [candidate] = await openFor(clientId);
    expect((await resolve(candidate.candidateId, 'confirmed')).body).toEqual({ state: 'confirmed' });
    await activateList([DESIGNATED]);
    expect((await screen(clientId)).body.state).toBe('confirmed');
    expect(await gate(matterId)).toBe('held');
  });

  it('carries a false positive forward only while the person and designation are unchanged', async () => {
    const { clientId } = await namedClientMatter();
    await screen(clientId);
    await resolve((await openFor(clientId))[0].candidateId, 'false_positive');

    await activateList([DESIGNATED]);
    expect((await screen(clientId)).body.state).toBe('clear');
    expect(await openFor(clientId)).toEqual([]);

    await activateList([DESIGNATED, { ...DESIGNATED, names: ['Zeb', 'QUIXOTIC FARNSWORTH'], nameType: 'Alias' }]);
    expect((await screen(clientId)).body.state).toBe('possible_match');
    await resolve((await openFor(clientId))[0].candidateId, 'false_positive');

    await db.updateTable('client_individuals').set({ town: 'Leeds' }).where('client_id', '=', clientId).execute();
    expect((await screen(clientId)).body.state).toBe('possible_match');
  });

  it('blocks money, but not other work, until a cleared client is screened against a new list', async () => {
    const { matterId, clientId } = await createTeamMatter(db, feeEarner, partner);
    await clearMatterForTests(db, matterId);
    const owner = createDatabase<Database>(testOwnerDatabaseUrl(), 1);
    const allowed = (action: string) => owner.transaction().execute((trx) => sql`select app.assert_aml_gate(${matterId}, ${action})`.execute(trx))
      .then(() => true, () => false);
    try {
      expect(await allowed('money')).toBe(true);
      await activateList([DESIGNATED]);
      expect((await api(complianceToken).get(`/compliance/sanctions/clients/${clientId}`)).body).toEqual({ state: 'unscreened' });
      expect(await gate(matterId)).toBe('cleared');
      expect(await allowed('money')).toBe(false);
      expect(await allowed('time')).toBe(true);

      expect((await screen(clientId)).body.state).toBe('clear');
      expect(await allowed('money')).toBe(true);
    } finally {
      await owner.destroy();
    }
  });

  it('refuses clearance until the client is screened against the active list', async () => {
    const { matterId, clientId } = await createTeamMatter(db, feeEarner, partner);
    const assessmentId = await submitTestAssessment(db, matterId, compliance.id);
    const approver = await createAmlStaff(db, 'compliance');
    const decide = () => sql`select app.decide_aml_clearance(${randomUUID()}, ${assessmentId}, 'approved', ${'aml-clearance:x'}, 1::smallint,
      ${Buffer.alloc(12)}, ${Buffer.alloc(2)}, ${Buffer.alloc(16)}, ${approver.id})`.execute(db);
    await expect(decide()).rejects.toMatchObject({ code: '23514', message: 'clearance needs current, clear sanctions screening' });
    await screen(clientId);
    await expect(decide()).rejects.toMatchObject({ code: '23514', message: expect.not.stringContaining('sanctions') });
  });

  it('lets only Compliance resolve a candidate, even calling the database directly', async () => {
    const { clientId } = await namedClientMatter();
    await screen(clientId);
    const [candidate] = await openFor(clientId);
    const id = randomUUID();
    await expect(sql`select app.resolve_aml_candidate(${id}, ${candidate.candidateId}, 'false_positive', ${'aml-resolution:' + id},
      1::smallint, ${Buffer.alloc(12)}, ${Buffer.alloc(2)}, ${Buffer.alloc(16)}, ${feeEarner.id})`.execute(db))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('screens each CDD subject by its decrypted name', async () => {
    const { clientId } = await createTeamMatter(db, feeEarner, partner);
    const { subjectId } = await submitTestCdd(db, clientId, compliance.id, 'Zebedee Quixotic Farnsworth');
    expect((await screen(clientId)).body.state).toBe('possible_match');
    expect(await openFor(clientId)).toEqual([expect.objectContaining({ subjectRef: subjectId, uniqueId: 'TST-ZQF01', birthAgreement: 'conflict' })]);
  });

  it('lists only clients with open matters for rescreening, and refuses screening against an old list', async () => {
    const { clientId } = await createTeamMatter(db, feeEarner, partner);
    const listed = (await sql<{ id: string }>`select id from app.aml_clients_to_rescreen(${null}::uuid, 500) as id`.execute(db)).rows;
    expect(listed.length).toBeGreaterThan(0);
    const old = await db.selectFrom('aml_sanctions_lists').select('id').orderBy('version', 'asc').limit(1).executeTakeFirstOrThrow();
    await expect(sql`select app.record_aml_screening(${clientId}, ${old.id}, 'client', '[]'::jsonb, null)`.execute(db))
      .rejects.toMatchObject({ code: '23514' });
    await expect(sql`select app.record_aml_screening(${clientId}, ${old.id}, ${randomUUID()}, '[]'::jsonb, null)`.execute(db))
      .rejects.toMatchObject({ code: '23514' });
  });
});
