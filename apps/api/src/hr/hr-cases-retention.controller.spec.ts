import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, revokeTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { testOwnerDatabaseUrl } from '../../test/database.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { createDatabase } from '../database/database.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { HrModule } from './hr.module.js';

@Module({ imports: [HrModule] }) class HrCasesRetentionTestModule {}

describe('People / HR cases, retention and exports API', () => {
  let app: NestExpressApplication, db: Kysely<Database>, ownerDb: Kysely<Database>, sessions: SessionsService;
  let hr: TestAccount, reviewer: TestAccount, worker: TestAccount, investigator: TestAccount;
  let decisionMaker: TestAccount, appealOfficer: TestAccount, outsider: TestAccount;
  let hrToken: string, reviewerToken: string, investigatorToken: string, decisionToken: string;
  let appealToken: string, outsiderToken: string, workerPerson: string, today: string;
  const api = (token: string) => { const server = request(app.getHttpServer()), cookie = `__Host-session=${token}`; return {
    get: (path: string) => server.get(path).set('Cookie', cookie),
    post: (path: string, body: object) => server.post(path).set('Cookie', cookie).send(body),
  }; };
  async function staffWith(...roles: StaffRole[]) { const account = await createTestAccount(db, 'staff');
    for (const role of roles) await grantTestRole(db, account.id, role); return account; }
  async function addPerson(account: TestAccount) { const response = await api(hrToken).post('/hr/people', { accountId: account.id });
    expect(response.status, JSON.stringify(response.body)).toBe(201); return response.body.personId as string; }
  async function openCase(issue = `Confidential issue ${randomUUID()}`) { const response = await api(hrToken).post('/hr/cases', {
    personId: workerPerson, kind: 'grievance', raisedByPersonId: workerPerson, policyVersion: 'Grievance policy 2026.1',
    dueOn: null, issue,
  }); expect(response.status, JSON.stringify(response.body)).toBe(201); return { id: response.body.id as string, issue }; }
  async function addMember(caseId: string, accountId: string, role: string, separationOverride: string | null = null) {
    return api(hrToken).post(`/hr/cases/${caseId}/members`, { accountId, role, separationOverride });
  }
  async function caseEvent(token: string, caseId: string, kind: string, state: string | null = null, occurredOn = today) {
    return api(token).post(`/hr/cases/${caseId}/events`, { kind, state, occurredOn,
      supersedesEventId: null, summary: `${kind} summary`, details: `${kind} confidential detail`, evidenceReference: null });
  }

  beforeAll(async () => { app = await createTestApp(HrCasesRetentionTestModule); db = app.get(DATABASE);
    ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 1); sessions = app.get(SessionsService);
    today = (await sql<{ today: string }>`select current_date::text today`.execute(db)).rows[0]!.today; });
  afterAll(async () => { await ownerDb.destroy(); await app.close(); });
  beforeEach(async () => {
    hr = await staffWith('hr'); reviewer = await staffWith('hr'); worker = await staffWith('fee_earner');
    investigator = await staffWith('partner'); decisionMaker = await staffWith('partner');
    appealOfficer = await staffWith('partner'); outsider = await staffWith('administrator');
    [hrToken, reviewerToken, investigatorToken, decisionToken, appealToken, outsiderToken] = await Promise.all([
      sessions.start(hr, 'authenticated', {}), sessions.start(reviewer, 'authenticated', {}),
      sessions.start(investigator, 'authenticated', {}), sessions.start(decisionMaker, 'authenticated', {}),
      sessions.start(appealOfficer, 'authenticated', {}), sessions.start(outsider, 'authenticated', {}),
    ]);
    workerPerson = await addPerson(worker);
  });

  it('shows neutral queues and full detail only to current case members', async () => {
    const opened = await openCase();
    expect((await api(hrToken).get('/hr/cases')).body.cases).toContainEqual(expect.objectContaining({ id: opened.id,
      personId: workerPerson, kind: 'grievance', state: 'open' }));
    expect((await api(hrToken).get(`/hr/cases/${opened.id}`)).body.issue).toBe(opened.issue);
    expect((await api(outsiderToken).get('/hr/cases')).body.cases).not.toContainEqual(expect.objectContaining({ id: opened.id }));
    expect((await api(outsiderToken).get(`/hr/cases/${opened.id}`)).status).toBe(404);
  });

  it('enforces separated investigator, decision-maker and appeal roles in PostgreSQL', async () => {
    const { id: caseId } = await openCase();
    expect((await addMember(caseId, investigator.id, 'investigator')).status).toBe(201);
    expect((await addMember(caseId, decisionMaker.id, 'decision_maker')).status).toBe(201);
    expect((await addMember(caseId, appealOfficer.id, 'appeal_officer')).status).toBe(201);
    expect((await caseEvent(investigatorToken, caseId, 'evidence')).status).toBe(201);
    expect((await caseEvent(investigatorToken, caseId, 'outcome')).status).toBe(404);
    expect((await caseEvent(decisionToken, caseId, 'outcome')).status).toBe(201);
    expect((await caseEvent(appealToken, caseId, 'appeal')).status).toBe(409);
    expect((await caseEvent(hrToken, caseId, 'status', 'closed')).status).toBe(201);
    expect((await caseEvent(appealToken, caseId, 'appeal')).status).toBe(201);
  });

  it('requires an encrypted justification when one person holds incompatible case roles', async () => {
    const { id: caseId } = await openCase();
    expect((await addMember(caseId, investigator.id, 'investigator')).status).toBe(201);
    expect((await addMember(caseId, investigator.id, 'decision_maker')).status).toBe(409);
    const override = `Small-firm separation exception ${randomUUID()}`;
    expect((await addMember(caseId, investigator.id, 'decision_maker', override)).status).toBe(201);
    const detail = await api(investigatorToken).get(`/hr/cases/${caseId}`);
    expect(detail.body.members).toContainEqual(expect.objectContaining({ role: 'decision_maker', separationOverride: override }));
    expect(JSON.stringify(await ownerDb.selectFrom('hr_case_memberships').select('override_ciphertext')
      .where('case_id', '=', caseId).execute())).not.toContain(override);
  });

  it('revokes access on membership ending and refuses to remove the final HR case owner', async () => {
    const { id: caseId } = await openCase();
    const added = await addMember(caseId, investigator.id, 'investigator');
    expect((await api(investigatorToken).get(`/hr/cases/${caseId}`)).status).toBe(200);
    expect((await api(hrToken).post(`/hr/case-memberships/${added.body.id}/end`, { reason: 'Investigation completed.' })).status).toBe(201);
    expect((await api(investigatorToken).get(`/hr/cases/${caseId}`)).status).toBe(404);
    const detail = await api(hrToken).get(`/hr/cases/${caseId}`), owner = detail.body.members.find((item: { role: string }) => item.role === 'hr_member');
    expect((await api(hrToken).post(`/hr/case-memberships/${owner.id}/end`, { reason: 'Cannot leave the case ownerless.' })).status).toBe(409);
  });

  it('removes HR-member case access immediately when the live HR role is revoked', async () => {
    const { id: caseId } = await openCase();
    await revokeTestRole(db, hr.id, 'hr');
    expect((await api(hrToken).get('/hr/cases')).body.cases).toEqual([]);
    expect((await api(hrToken).get(`/hr/cases/${caseId}`)).status).toBe(404);
  });

  it('encrypts case content, records protected access, and keeps secrets out of audit metadata', async () => {
    const secret = `Allegation ${randomUUID()}`, { id: caseId } = await openCase(secret);
    await api(hrToken).get(`/hr/cases/${caseId}`);
    const raw = await ownerDb.selectFrom('hr_cases').select(['issue_context','issue_ciphertext']).where('id', '=', caseId).executeTakeFirstOrThrow();
    expect(raw.issue_context).toBe(`hr-case:${caseId}`); expect(raw.issue_ciphertext.toString('utf8')).not.toContain(secret);
    expect(await ownerDb.selectFrom('hr_case_access_log').select('id').where('case_id', '=', caseId).execute()).not.toHaveLength(0);
    expect(JSON.stringify(await ownerDb.selectFrom('audit_events').select('metadata').where('resource_id', '=', caseId).execute())).not.toContain(secret);
  });

  it('blocks due disposal under a hold, then removes content and leaves only tombstones', async () => {
    const secret = `Disposable case ${randomUUID()}`, { id: caseId } = await openCase(secret);
    expect((await caseEvent(hrToken, caseId, 'status', 'closed', '2000-01-01')).status).toBe(201);
    const rule = await api(hrToken).post('/hr/retention/rules', { category: 'case', effectiveFrom: '1999-01-01',
      reviewAfterMonths: 1, retainMonths: 1, governingRule: 'Approved case retention rule version one',
      rationale: 'The documented limitation period and data-minimisation assessment.' });
    const schedule = await api(hrToken).post('/hr/retention/schedules', { personId: workerPerson, ruleId: rule.body.id,
      sourceId: caseId, basisOn: '2000-01-01', evidence: 'Case closure was checked before scheduling disposal.' });
    expect(schedule.status, JSON.stringify(schedule.body)).toBe(201);
    expect((await api(hrToken).post(`/hr/retention/schedules/${schedule.body.id}/legal-holds`, { action: 'imposed',
      reviewOn: '2099-01-01', authority: 'Employment counsel', reason: 'Current proceedings require preservation.' })).status).toBe(201);
    expect((await api(hrToken).post(`/hr/retention/schedules/${schedule.body.id}/dispose`, {})).status).toBe(409);
    expect((await api(hrToken).post(`/hr/retention/schedules/${schedule.body.id}/legal-holds`, { action: 'released',
      reviewOn: null, authority: 'Employment counsel', reason: 'Proceedings ended and the hold is released.' })).status).toBe(201);
    const disposed = await api(hrToken).post(`/hr/retention/schedules/${schedule.body.id}/dispose`, {});
    expect(disposed.status, JSON.stringify(disposed.body)).toBe(201); expect(disposed.body.state).toBe('completed');
    expect(await ownerDb.selectFrom('hr_cases').select('id').where('id', '=', caseId).execute()).toEqual([]);
    const tombstones = await ownerDb.selectFrom('hr_disposed_records').select(['record_kind','category']).where('run_id', '=', disposed.body.id).execute();
    expect(tombstones).toContainEqual({ record_kind: 'hr_case', category: 'case' });
    expect(JSON.stringify(tombstones)).not.toContain(secret);
  });

  it('requires a different authorised reviewer before a fixed export can be downloaded', async () => {
    const { id: caseId, issue } = await openCase();
    expect((await addMember(caseId, reviewer.id, 'hr_member')).status).toBe(201);
    const prepared = await api(hrToken).post('/hr/exports', { personId: workerPerson, purpose: 'worker_access',
      scopes: ['personal','cases'], reason: 'Prepare a reviewable worker access response.' });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(201); expect(prepared.body.decision).toBeNull();
    expect((await api(hrToken).get(`/hr/exports/${prepared.body.id}/content`)).status).toBe(409);
    expect((await api(hrToken).post(`/hr/exports/${prepared.body.id}/decision`, { decision: 'approved',
      note: 'The preparer cannot approve their own bundle.' })).status).toBe(409);
    const preview = await api(reviewerToken).get(`/hr/exports/${prepared.body.id}/review`);
    expect(JSON.stringify(preview.body.bundle)).toContain(issue);
    expect((await api(reviewerToken).post(`/hr/exports/${prepared.body.id}/decision`, { decision: 'approved',
      note: 'Third-party and exempt material was reviewed before release.' })).status).toBe(201);
    const downloaded = await api(reviewerToken).get(`/hr/exports/${prepared.body.id}/content`);
    expect(downloaded.status).toBe(200); expect(downloaded.headers['cache-control']).toBe('private, no-store');
    expect(downloaded.headers['content-disposition']).toContain('attachment');
    expect(JSON.stringify(downloaded.body)).toContain(issue);
  });

  it('rejects malformed shapes, direct app reads, and owner rewrites or truncation', async () => {
    expect((await api(hrToken).post('/hr/cases', { personId: workerPerson, kind: 'whistleblowing',
      policyVersion: 'Not supported', issue: 'Wrong case kind', score: 7 })).status).toBe(400);
    await expect(db.selectFrom('hr_cases').selectAll().execute()).rejects.toThrow(/permission denied/);
    const { id: caseId } = await openCase();
    await expect(ownerDb.updateTable('hr_cases').set({ policy_version: 'Rewritten' } as never).where('id', '=', caseId).execute())
      .rejects.toThrow(/immutable/);
    await expect(sql`truncate app.hr_case_events cascade`.execute(ownerDb)).rejects.toThrow(/cannot be truncated/);
  });
});
