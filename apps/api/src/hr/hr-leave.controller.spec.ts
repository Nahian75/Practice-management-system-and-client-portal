import { randomUUID } from 'node:crypto';
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
import { HrModule } from './hr.module.js';

@Module({ imports: [HrModule] })
class HrLeaveTestModule {}

const pattern = { timeZone: 'Europe/London', mondayMinutes: 450, tuesdayMinutes: 450,
  wednesdayMinutes: 450, thursdayMinutes: 450, fridayMinutes: 420,
  saturdayMinutes: 0, sundayMinutes: 0 };

describe('People / HR leave, sickness and adjustments API', () => {
  let app: NestExpressApplication, db: Kysely<Database>, ownerDb: Kysely<Database>, sessions: SessionsService;
  let hr: TestAccount, worker: TestAccount, manager: TestAccount, outsider: TestAccount;
  let hrToken: string, workerToken: string, managerToken: string, outsiderToken: string;
  let workerPerson: string, managerPerson: string, nextMonday: string, nextTuesday: string, followingMonday: string;

  const api = (token: string) => {
    const server = request(app.getHttpServer()), cookie = `__Host-session=${token}`;
    return { get: (path: string) => server.get(path).set('Cookie', cookie),
      post: (path: string, body: object) => server.post(path).set('Cookie', cookie).send(body) };
  };

  async function staffWith(...roles: StaffRole[]) {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) await grantTestRole(db, account.id, role);
    return account;
  }

  async function createPerson(account: TestAccount, token = hrToken) {
    const response = await api(token).post('/hr/people', { accountId: account.id });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.personId as string;
  }

  async function engage(personId: string, title = 'Solicitor') {
    const response = await api(hrToken).post(`/hr/people/${personId}/engagements`, {
      kind: 'employee', startedOn: '2020-01-01', jobTitle: title, team: 'Disputes', workLocation: 'London', pattern,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }

  async function grant(minutes = 2_000) {
    const response = await api(hrToken).post(`/hr/people/${workerPerson}/leave/entitlement`, {
      leaveYearStart: `${new Date().getUTCFullYear()}-01-01`, kind: 'opening_grant', minutes,
      reason: 'Contractual annual entitlement.',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }

  async function requestLeave(kind: 'annual' | 'family' | 'compassionate' | 'unpaid' | 'other' = 'annual',
    startsOn = nextMonday, endsOn = nextTuesday) {
    return api(workerToken).post('/hr/me/leave', { kind, startsOn, endsOn, reason: `Private ${kind} request.` });
  }

  beforeAll(async () => {
    app = await createTestApp(HrLeaveTestModule);
    db = app.get(DATABASE); ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 1);
    sessions = app.get(SessionsService);
    const dates = (await sql<{ monday: string; tuesday: string; following: string }>`select
      ((current_date + ((8-extract(isodow from current_date)::integer)%7))::date)::text as monday,
      ((current_date + ((8-extract(isodow from current_date)::integer)%7) + 1)::date)::text as tuesday,
      ((current_date + ((8-extract(isodow from current_date)::integer)%7) + 7)::date)::text as following`
      .execute(db)).rows[0]!;
    nextMonday = dates.monday; nextTuesday = dates.tuesday; followingMonday = dates.following;
    const policy = await ownerDb.selectFrom('hr_leave_policies').select('id').executeTakeFirst();
    if (!policy) {
      const bootstrap = await staffWith('hr');
      await sql`select app.create_hr_leave_policy('2020-01-01'::date,1::smallint,1::smallint,
        12600,2250,7::smallint,'manager_or_hr',${bootstrap.id}::uuid)`.execute(db);
    }
  });

  afterAll(async () => { await ownerDb.destroy(); await app.close(); });

  beforeEach(async () => {
    hr = await staffWith('hr'); worker = await staffWith('fee_earner'); manager = await staffWith('partner');
    outsider = await staffWith('administrator');
    [hrToken, workerToken, managerToken, outsiderToken] = await Promise.all([
      sessions.start(hr, 'authenticated', {}), sessions.start(worker, 'authenticated', {}),
      sessions.start(manager, 'authenticated', {}), sessions.start(outsider, 'authenticated', {}),
    ]);
    workerPerson = await createPerson(worker); managerPerson = await createPerson(manager);
    await engage(workerPerson); await engage(managerPerson, 'Partner');
    const assigned = await api(hrToken).post(`/hr/people/${workerPerson}/manager`, {
      managerPersonId: managerPerson, effectiveOn: '2020-01-02',
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
  });

  it('limits policy and entitlement administration to HR', async () => {
    const policies = await api(hrToken).get('/hr/leave/policies');
    expect(policies.status).toBe(200);
    expect(policies.body.policies).toContainEqual(expect.objectContaining({ leaveYearMonth: 1, leaveYearDay: 1,
      standardEntitlementMinutes: 12600, annualApprovalRoute: 'manager_or_hr' }));
    expect((await api(managerToken).get('/hr/leave/policies')).status).toBe(403);
    expect((await api(outsiderToken).post(`/hr/people/${workerPerson}/leave/entitlement`, {
      leaveYearStart: `${new Date().getUTCFullYear()}-01-01`, kind: 'opening_grant', minutes: 500,
      reason: 'Unauthorised grant.',
    })).status).toBe(403);
    expect((await api(hrToken).post(`/hr/people/${workerPerson}/leave/entitlement`, {
      leaveYearStart: `${new Date().getUTCFullYear()}-01-01`, kind: 'carry_over', minutes: 2251,
      reason: 'Over the policy limit.',
    })).status).toBe(409);
  });

  it('encrypts a self-service request and places it in the HR queue', async () => {
    const created = await requestLeave();
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const queue = await api(hrToken).get('/hr/leave/requests');
    expect(queue.status).toBe(200);
    expect(queue.body.requests).toContainEqual(expect.objectContaining({ id: created.body.id,
      personId: workerPerson, reason: 'Private annual request.', state: 'pending' }));
    expect((await api(outsiderToken).get(`/hr/people/${workerPerson}/leave`)).status).toBe(403);
    const raw = await ownerDb.selectFrom('hr_leave_requests').select(['context', 'ciphertext'])
      .where('id', '=', created.body.id).executeTakeFirstOrThrow();
    expect(raw.context).toBe(`hr-leave-request:${created.body.id}`);
    expect(raw.ciphertext.toString('utf8')).not.toContain('Private annual request');
  });

  it('serializes annual approval into exact working minutes and prevents self-approval', async () => {
    await grant();
    const created = await requestLeave();
    expect((await api(workerToken).post(`/hr/leave/requests/${created.body.id}/decision`, {
      action: 'approved', reason: 'Self approved.',
    })).status).toBe(404);
    const approved = await api(managerToken).post(`/hr/leave/requests/${created.body.id}/decision`, {
      action: 'approved', reason: 'Coverage is confirmed.',
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body.minutes).toBe(900);
    const record = await api(workerToken).get('/hr/me/leave');
    expect(record.body).toMatchObject({ balanceMinutes: 1100,
      requests: [expect.objectContaining({ state: 'approved', approvedMinutes: 900 })] });
    expect(await ownerDb.selectFrom('hr_leave_request_days').selectAll()
      .where('request_id', '=', created.body.id).orderBy('leave_on').execute()).toHaveLength(2);
  });

  it('lets HR decide protected leave categories while refusing the manager', async () => {
    const created = await requestLeave('family');
    expect((await api(managerToken).post(`/hr/leave/requests/${created.body.id}/decision`, {
      action: 'approved', reason: 'Manager attempt.',
    })).status).toBe(404);
    expect((await api(hrToken).post(`/hr/leave/requests/${created.body.id}/decision`, {
      action: 'approved', reason: 'HR recorded the accountable decision.',
    })).status).toBe(201);
  });

  it('enforces a versioned HR-only annual approval route', async () => {
    const existing = await ownerDb.selectFrom('hr_leave_policies').select('id')
      .where('effective_from', '=', '2099-01-01').executeTakeFirst();
    if (!existing) {
      const policy = await api(hrToken).post('/hr/leave/policies', { effectiveFrom: '2099-01-01',
        leaveYearMonth: 1, leaveYearDay: 1, standardEntitlementMinutes: 12600,
        carryOverLimitMinutes: 2250, bookingNoticeDays: 7, annualApprovalRoute: 'hr_only' });
      expect(policy.status, JSON.stringify(policy.body)).toBe(201);
    }
    const created = await api(workerToken).post('/hr/me/leave', { kind: 'annual',
      startsOn: '2099-01-08', endsOn: '2099-01-08', reason: 'Future policy request.' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await api(managerToken).post(`/hr/leave/requests/${created.body.id}/decision`, {
      action: 'approved', reason: 'Manager attempted approval.',
    })).status).toBe(404);
  });

  it('serializes concurrent annual decisions against one balance', async () => {
    await grant(450);
    const first = await requestLeave('annual', nextMonday, nextMonday);
    const second = await requestLeave('annual', followingMonday, followingMonday);
    const results = await Promise.all([first, second].map((created) => api(managerToken)
      .post(`/hr/leave/requests/${created.body.id}/decision`, { action: 'approved', reason: 'Concurrent approval.' })));
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect((await api(workerToken).get('/hr/me/leave')).body.balanceMinutes).toBe(0);
  });

  it('rejects overlap and returns annual entitlement through an immutable cancellation event', async () => {
    await grant();
    const first = await requestLeave();
    expect((await api(managerToken).post(`/hr/leave/requests/${first.body.id}/decision`, {
      action: 'approved', reason: 'Approved.',
    })).status).toBe(201);
    const overlap = await requestLeave('annual', nextTuesday, nextTuesday);
    expect((await api(managerToken).post(`/hr/leave/requests/${overlap.body.id}/decision`, {
      action: 'approved', reason: 'Would overlap.',
    })).status).toBe(409);
    const cancelled = await api(workerToken).post(`/hr/leave/requests/${first.body.id}/cancel`, { reason: 'Plans changed.' });
    expect(cancelled.status).toBe(201);
    expect(cancelled.body.minutesReturned).toBe(900);
    expect((await api(workerToken).get('/hr/me/leave')).body.balanceMinutes).toBe(2000);
    expect((await api(workerToken).post(`/hr/leave/requests/${first.body.id}/cancel`, { reason: 'Again.' })).status).toBe(409);
  });

  it('keeps sickness administration reason-free and rejects overlapping absences', async () => {
    const body = { startedOn: nextMonday, endedOn: nextTuesday,
      notifiedAt: `${nextMonday}T08:00:00Z`, fitnessStatus: 'not_fit' };
    const created = await api(managerToken).post(`/hr/people/${workerPerson}/sickness`, body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await api(managerToken).post(`/hr/people/${workerPerson}/sickness`, { ...body,
      reason: 'A medical diagnosis that must not be accepted.' })).status).toBe(400);
    expect((await api(hrToken).post(`/hr/people/${workerPerson}/sickness`, { ...body,
      startedOn: nextTuesday, endedOn: followingMonday })).status).toBe(409);
    const managerView = await api(managerToken).get(`/hr/reports/${workerPerson}/leave`);
    expect(managerView.body.sickness[0]).toMatchObject({ fitnessStatus: 'not_fit' });
    expect(JSON.stringify(managerView.body)).not.toContain('diagnosis');
  });

  it('serializes concurrent overlapping sickness entries', async () => {
    const body = { startedOn: nextMonday, endedOn: nextTuesday,
      notifiedAt: `${nextMonday}T08:00:00Z`, fitnessStatus: 'not_assessed' };
    const results = await Promise.all([
      api(managerToken).post(`/hr/people/${workerPerson}/sickness`, body),
      api(hrToken).post(`/hr/people/${workerPerson}/sickness`, body),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
  });

  it('keeps encrypted health details out of self and manager projections', async () => {
    const detail = `Restricted clinical detail ${randomUUID()}`;
    const created = await api(hrToken).post(`/hr/people/${workerPerson}/health`, {
      kind: 'occupational_health', validFrom: nextMonday, validTo: null, details: detail,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const hrView = await api(hrToken).get(`/hr/people/${workerPerson}/health`);
    expect(hrView.body.records[0].details).toBe(detail);
    expect((await api(workerToken).get('/hr/me/health')).body.records[0].details).toBe(detail);
    expect((await api(workerToken).get(`/hr/people/${workerPerson}/health`)).status).toBe(403);
    expect(JSON.stringify((await api(managerToken).get(`/hr/reports/${workerPerson}/leave`)).body)).not.toContain(detail);
    const raw = await ownerDb.selectFrom('hr_health_records').select('ciphertext').where('id', '=', created.body.id)
      .executeTakeFirstOrThrow();
    expect(raw.ciphertext.toString('utf8')).not.toContain(detail);
  });

  it('projects only agreed operational adjustments to the manager', async () => {
    const requested = await api(workerToken).post('/hr/me/adjustments', {
      request: 'Private disability grounds and treatment details.',
    });
    expect(requested.status).toBe(201);
    const decided = await api(hrToken).post(`/hr/adjustments/${requested.body.id}/decision`, {
      outcome: 'agreed', reason: 'Restricted assessment evidence.',
      operationalInstruction: 'Provide a quiet room for client calls.', effectiveOn: nextMonday, reviewOn: followingMonday,
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(201);
    const managerView = await api(managerToken).get(`/hr/reports/${workerPerson}/adjustments`);
    expect(managerView.status).toBe(200);
    expect(managerView.body.adjustments[0]).toMatchObject({ request: null, decisionReason: null,
      operationalInstruction: 'Provide a quiet room for client calls.' });
    expect(JSON.stringify(managerView.body)).not.toContain('disability');
    expect(JSON.stringify(managerView.body)).not.toContain('assessment evidence');
    expect((await api(managerToken).post(`/hr/adjustments/decisions/${decided.body.id}/progress`, {
      action: 'implemented', note: 'The room is now available.',
    })).status).toBe(201);
    expect((await api(managerToken).post(`/hr/adjustments/decisions/${decided.body.id}/progress`, {
      action: 'closed', note: 'Manager tried to close it.',
    })).status).toBe(404);
    expect((await api(hrToken).post(`/hr/adjustments/decisions/${decided.body.id}/progress`, {
      action: 'closed', note: 'HR completed the recorded review.',
    })).status).toBe(201);
    expect((await api(managerToken).post(`/hr/adjustments/decisions/${decided.body.id}/progress`, {
      action: 'reviewed', note: 'No event is valid after closure.',
    })).status).toBe(409);
  });

  it('retains payroll-supplied holiday-pay evidence without exposing it to managers', async () => {
    await grant();
    const leave = await requestLeave();
    await api(managerToken).post(`/hr/leave/requests/${leave.body.id}/decision`, { action: 'approved', reason: 'Approved.' });
    expect((await api(hrToken).post(`/hr/people/${workerPerson}/leave/holiday-pay`, {
      requestId: leave.body.id, periodStartsOn: nextMonday, periodEndsOn: nextTuesday,
      amountPence: 42_500, basis: 'normal', includedElements: [{ name: 'salary', amountPence: 40_000 }],
    })).status).toBe(400);
    const pay = await api(hrToken).post(`/hr/people/${workerPerson}/leave/holiday-pay`, {
      requestId: leave.body.id, periodStartsOn: nextMonday, periodEndsOn: nextTuesday,
      amountPence: 42_500, basis: 'normal', includedElements: [
        { name: 'salary', amountPence: 40_000 }, { name: 'regular overtime', amountPence: 2_500 }],
    });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    const self = await api(workerToken).get('/hr/me/leave');
    expect(self.body.holidayPay[0]).toMatchObject({ amountPence: 42500, basis: 'normal',
      includedElements: [{ name: 'salary', amountPence: 40000 },
        { name: 'regular overtime', amountPence: 2500 }] });
    const managerView = await api(managerToken).get(`/hr/reports/${workerPerson}/leave`);
    expect(managerView.body.holidayPay).toEqual([]);
    const retained = await ownerDb.selectFrom('hr_holiday_pay_records').select('retention_until')
      .where('id', '=', pay.body.id).executeTakeFirstOrThrow();
    expect(new Date(retained.retention_until).getUTCFullYear()).toBeGreaterThanOrEqual(new Date().getUTCFullYear() + 6);
  });

  it('denies direct application-table writes and changes to immutable HR history', async () => {
    await expect(db.insertInto('hr_sickness_absences').values({ id: randomUUID(), person_id: workerPerson,
      started_on: nextMonday, ended_on: nextTuesday, notified_at: new Date(), fitness_status: 'not_fit',
      recorded_by: manager.id, recorded_at: new Date() }).execute()).rejects.toMatchObject({ code: '42501' });
    const created = await requestLeave();
    await expect(sql`update app.hr_leave_requests set ends_on=${followingMonday}::date
      where id=${created.body.id}::uuid`.execute(ownerDb)).rejects.toMatchObject({ code: '42501' });
  });
});
