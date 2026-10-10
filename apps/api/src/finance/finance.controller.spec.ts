import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMatterForTests } from '../../test/aml.js';
import { createTestAccount, grantTestRole, revokeTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { ClientsModule } from '../clients/clients.module.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { MattersModule } from '../matters/matters.module.js';
import { FinanceModule } from './finance.module.js';
import { FinanceRepository } from './finance.repository.js';

@Module({ imports: [ClientsModule, MattersModule, FinanceModule] })
class FinanceTestModule {}

describe('Finance time API', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let accounts: TestAccount;
  let compliance: TestAccount;
  let matterId: string;
  let feeToken: string;
  let accountsToken: string;
  let today: string;

  const uniqueName = () => randomUUID().replaceAll('-', '').slice(0, 16);
  const cookie = (token: string) => `__Host-session=${token}`;
  const signedIn = (account: TestAccount) => sessions.start(account, 'authenticated', {});
  const as = (token: string) => {
    const server = request(app.getHttpServer());
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie(token)),
      post: (path: string, body: object) => server.post(path).set('Cookie', cookie(token)).send(body),
    };
  };

  async function staffWith(...roles: StaffRole[]): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) {
      await grantTestRole(db, account.id, role);
    }
    return account;
  }

  async function openMatter(): Promise<string> {
    const client = await as(feeToken).post('/clients', { kind: 'individual', givenNames: uniqueName(), familyName: uniqueName() });
    const check = await as(feeToken).post('/conflict-checks', { clientId: client.body.id, names: [uniqueName()] });
    const matter = await as(feeToken).post('/matters', {
      clientId: client.body.id,
      title: 'Finance API matter',
      matterType: 'other',
      supervisingPartnerId: partner.id,
      conflictCheckId: check.body.id,
      parties: [],
    });
    if (matter.status === 201) await clearMatterForTests(db, matter.body.id);
    return matter.body.id;
  }

  const createRate = (token = accountsToken, overrides: object = {}) => as(token).post('/finance/rates', {
    accountId: feeEarner.id,
    hourlyRate: '250.00',
    effectiveFrom: today,
    ...overrides,
  });

  const recordTime = (token = feeToken, matter = matterId, overrides: object = {}) => as(token).post(`/matters/${matter}/time-entries`, {
    workedOn: today,
    minutes: 60,
    description: 'Prepared the completion statement',
    ...overrides,
  });

  const failAudit = (action: string) => {
    const service = app.get(AuditService);
    const record = service.record.bind(service);
    return vi.spyOn(service, 'record').mockImplementation((event, transaction) =>
      event.action === action ? Promise.reject(new Error('audit unavailable')) : record(event, transaction),
    );
  };

  beforeAll(async () => {
    app = await createTestApp(FinanceTestModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    today = (await sql<{ today: string }>`select (clock_timestamp() at time zone 'Europe/London')::date::text as today`.execute(db)).rows[0]!.today;
    partner = await staffWith('partner');
    feeEarner = await staffWith('fee_earner');
    accounts = await staffWith('accounts');
    compliance = await staffWith('compliance');
    await db.updateTable('accounts').set({ display_name: 'Pat Fee Earner' }).where('id', '=', feeEarner.id).execute();
    await db.updateTable('accounts').set({ display_name: 'Alex Accounts' }).where('id', '=', accounts.id).execute();
    feeToken = await signedIn(feeEarner);
    accountsToken = await signedIn(accounts);
    matterId = await openMatter();
  });

  describe('staff rates', () => {
    it('lets Accounts create and list an immutable rate', async () => {
      const eligible = await as(accountsToken).get('/finance/rate-accounts');
      expect(eligible.status).toBe(200);
      expect(eligible.body.accounts).toEqual(expect.arrayContaining([
        expect.objectContaining({ accountId: feeEarner.id, roles: expect.arrayContaining(['fee_earner']) }),
        expect.objectContaining({ accountId: partner.id, roles: expect.arrayContaining(['partner']) }),
      ]));
      const created = await createRate();
      expect(created.status).toBe(201);
      expect(created.body).toEqual({
        id: expect.any(String),
        account: { accountId: feeEarner.id, displayName: 'Pat Fee Earner' },
        hourlyRate: '250.00',
        effectiveFrom: today,
        createdBy: { accountId: accounts.id, displayName: 'Alex Accounts' },
        createdAt: expect.any(String),
      });

      const listed = await as(accountsToken).get(`/finance/rates?accountId=${feeEarner.id}`);
      expect(listed.status).toBe(200);
      expect(listed.body.rates).toContainEqual(created.body);
    });

    it('allows Compliance to read rates but not create them', async () => {
      await createRate();
      const token = await signedIn(compliance);
      expect((await as(token).get(`/finance/rates?accountId=${feeEarner.id}`)).status).toBe(200);
      expect((await createRate(token, { accountId: partner.id })).status).toBe(403);
      expect((await as(token).get('/finance/rate-accounts')).status).toBe(403);
    });

    it('refuses other roles, invalid money, duplicate dates and ineligible staff', async () => {
      expect((await createRate(feeToken)).status).toBe(403);
      expect((await createRate(accountsToken, { hourlyRate: '250' })).status).toBe(400);
      expect((await createRate(accountsToken, { hourlyRate: '10000.01' })).status).toBe(400);
      expect((await createRate()).status).toBe(201);
      expect((await createRate()).status).toBe(409);
      const administrator = await staffWith('administrator');
      expect((await createRate(accountsToken, { accountId: administrator.id })).status).toBe(409);
    });

    it('audits ids and money only, and rolls back when audit fails', async () => {
      const created = await createRate();
      const event = await db.selectFrom('audit_events').select(['action', 'actor_id', 'resource_id', 'metadata']).where('resource_id', '=', created.body.id).executeTakeFirstOrThrow();
      expect(event).toEqual({
        action: 'rate.created',
        actor_id: accounts.id,
        resource_id: created.body.id,
        metadata: { accountId: feeEarner.id, effectiveFrom: today, hourlyRatePence: '25000' },
      });
      expect(JSON.stringify(event)).not.toContain('Pat Fee Earner');

      const worker = await staffWith('fee_earner');
      const audit = failAudit('rate.created');
      let failed: request.Response;
      try {
        failed = await createRate(accountsToken, { accountId: worker.id });
      } finally {
        audit.mockRestore();
      }
      expect(failed!.status).toBe(500);
      expect((await sql<{ count: string }>`select count(*) as count from staff_rates where account_id = ${worker.id}`.execute(db)).rows[0]!.count).toBe('0');
    });

    it('pages rates with a stable 100-row cursor', async () => {
      const dates = Array.from({ length: 101 }, (_, index) => {
        const date = new Date(`${today}T12:00:00Z`);
        date.setUTCDate(date.getUTCDate() - index);
        return date.toISOString().slice(0, 10);
      });
      await db.insertInto('staff_rates').values(dates.map((effectiveFrom) => ({
        account_id: feeEarner.id,
        hourly_rate_pence: '25000',
        effective_from: effectiveFrom,
        created_by: accounts.id,
      }))).execute();

      const first = await as(accountsToken).get(`/finance/rates?accountId=${feeEarner.id}`);
      expect(first.status).toBe(200);
      expect(first.body.rates).toHaveLength(100);
      expect(first.body.next).toBe(first.body.rates.at(-1).id);
      const second = await as(accountsToken).get(`/finance/rates?accountId=${feeEarner.id}&before=${first.body.next}`);
      expect(second.body.rates).toHaveLength(1);
      expect(second.body.next).toBeNull();
    });

    it('rolls audit back if the rate transaction fails afterwards', async () => {
      const worker = await staffWith('fee_earner');
      const repository = app.get(FinanceRepository);
      const read = vi.spyOn(repository, 'findRate').mockRejectedValueOnce(new Error('read failed'));
      let response: request.Response;
      try {
        response = await createRate(accountsToken, { accountId: worker.id });
      } finally {
        read.mockRestore();
      }
      expect(response!.status).toBe(500);
      expect(await db.selectFrom('staff_rates').select('id').where('account_id', '=', worker.id).executeTakeFirst()).toBeUndefined();
      expect(await db.selectFrom('audit_events').select('id').where('action', '=', 'rate.created').where('metadata', '@>', { accountId: worker.id }).executeTakeFirst()).toBeUndefined();
    });
  });

  describe('time entries', () => {
    beforeEach(async () => {
      expect((await createRate()).status).toBe(201);
    });

    it('records own time with its rate snapshot and private text outside audit', async () => {
      const response = await recordTime();
      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        id: expect.any(String),
        matterId,
        worker: { accountId: feeEarner.id, displayName: 'Pat Fee Earner' },
        workedOn: today,
        minutes: 60,
        description: 'Prepared the completion statement',
        hourlyRate: '250.00',
        voided: false,
        recordedAt: expect.any(String),
        corrections: [],
      });
      const event = await db.selectFrom('audit_events').select(['action', 'actor_id', 'metadata']).where('resource_id', '=', response.body.id).executeTakeFirstOrThrow();
      expect(event).toEqual({ action: 'time.recorded', actor_id: feeEarner.id, metadata: { matterId, minutes: 60, hourlyRatePence: '25000' } });
      expect(JSON.stringify(event)).not.toContain('completion statement');
    });

    it('lists visible time newest first and lets Accounts and Compliance see any matter', async () => {
      const first = await recordTime(undefined, undefined, { description: 'First entry' });
      const second = await recordTime(undefined, undefined, { description: 'Second entry' });
      const teamList = await as(feeToken).get(`/matters/${matterId}/time-entries`);
      expect(teamList.status).toBe(200);
      expect(teamList.body.timeEntries.map((entry: { id: string }) => entry.id).slice(0, 2)).toEqual([second.body.id, first.body.id]);
      expect(JSON.stringify(teamList.body)).not.toMatch(/First entry|Second entry/);
      expect((await as(feeToken).get(`/time-entries/${second.body.id}`)).body).toMatchObject({ description: 'Second entry' });
      expect((await as(accountsToken).get(`/matters/${matterId}/time-entries`)).status).toBe(200);
      expect((await as(accountsToken).get(`/time-entries/${second.body.id}`)).status).toBe(200);
      expect((await as(await signedIn(compliance)).get(`/matters/${matterId}/time-entries`)).status).toBe(200);
    });

    it('pages time with a stable 100-row cursor', async () => {
      await db.insertInto('time_entries').values(Array.from({ length: 101 }, (_, index) => ({
        matter_id: matterId,
        worker_id: feeEarner.id,
        worked_on: today,
        minutes: index + 1,
        description: `Paging entry ${index + 1}`,
        recorded_by: feeEarner.id,
      }))).execute();

      const first = await as(feeToken).get(`/matters/${matterId}/time-entries`);
      expect(first.status).toBe(200);
      expect(first.body.timeEntries).toHaveLength(100);
      expect(first.body.next).toBe(first.body.timeEntries.at(-1).id);
      const second = await as(feeToken).get(`/matters/${matterId}/time-entries?before=${first.body.next}`);
      expect(second.body.timeEntries).toHaveLength(1);
      expect(second.body.next).toBeNull();
      expect(JSON.stringify(first.body)).not.toContain('Paging entry');
    });

    it('hides another matter from ordinary staff and reacts immediately to team removal', async () => {
      const outsider = await staffWith('fee_earner');
      const outsiderToken = await signedIn(outsider);
      expect((await as(outsiderToken).get(`/matters/${matterId}/time-entries`)).status).toBe(404);
      const entry = await recordTime();
      expect((await as(outsiderToken).get(`/time-entries/${entry.body.id}`)).status).toBe(404);
      await db.updateTable('matter_team').set({ removed_at: new Date(), removed_by: partner.id }).where('matter_id', '=', matterId).where('account_id', '=', feeEarner.id).execute();
      expect((await as(feeToken).get(`/matters/${matterId}/time-entries`)).status).toBe(404);
      expect((await recordTime()).status).toBe(404);
    });

    it('refuses missing rates, closed matters, wrong roles and invalid input', async () => {
      const worker = await staffWith('fee_earner');
      await db.insertInto('matter_team').values({ matter_id: matterId, account_id: worker.id, role: 'fee_earner', added_by: partner.id }).execute();
      expect((await recordTime(await signedIn(worker))).status).toBe(409);
      expect((await recordTime(accountsToken)).status).toBe(403);
      expect((await recordTime(feeToken, matterId, { minutes: 0 })).status).toBe(400);
      expect((await recordTime(feeToken, matterId, { description: '' })).status).toBe(400);
      expect((await recordTime(feeToken, matterId, { extra: true })).status).toBe(400);
      await db.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'All work is complete' }).execute();
      expect((await recordTime()).status).toBe(409);
    });

    it('rolls time back when its audit cannot be written', async () => {
      const audit = failAudit('time.recorded');
      let response: request.Response;
      try {
        response = await recordTime(undefined, undefined, { description: 'Must roll back' });
      } finally {
        audit.mockRestore();
      }
      expect(response!.status).toBe(500);
      expect((await sql<{ count: string }>`select count(*) as count from time_entries where matter_id = ${matterId} and description = 'Must roll back'`.execute(db)).rows[0]!.count).toBe('0');
    });

    it('replaces or voids own time with permanent before-and-after history', async () => {
      const entry = await recordTime();
      const replaced = await as(feeToken).post(`/time-entries/${entry.body.id}/corrections`, {
        reason: 'The timer was left running',
        replacement: { workedOn: today, minutes: 30, description: 'Prepared the statement' },
      });
      expect(replaced.status).toBe(200);
      expect(replaced.body).toMatchObject({ minutes: 30, description: 'Prepared the statement', voided: false });
      expect(replaced.body.corrections).toEqual([
        expect.objectContaining({
          from: expect.objectContaining({ minutes: 60, description: 'Prepared the completion statement', hourlyRate: '250.00' }),
          to: expect.objectContaining({ minutes: 30, description: 'Prepared the statement', hourlyRate: '250.00' }),
          reason: 'The timer was left running',
        }),
      ]);

      const voided = await as(feeToken).post(`/time-entries/${entry.body.id}/corrections`, { reason: 'Recorded on the wrong matter', replacement: null });
      expect(voided.status).toBe(200);
      expect(voided.body.voided).toBe(true);
      expect(voided.body.corrections).toHaveLength(2);
    });

    it('refuses correction by another person, after access or role loss, and of voided time', async () => {
      const entry = await recordTime();
      const partnerToken = await signedIn(partner);
      expect((await as(partnerToken).post(`/time-entries/${entry.body.id}/corrections`, { reason: 'Not mine', replacement: null })).status).toBe(404);

      await revokeTestRole(db, feeEarner.id, 'fee_earner');
      expect((await as(feeToken).post(`/time-entries/${entry.body.id}/corrections`, { reason: 'No role', replacement: null })).status).toBe(403);
      await grantTestRole(db, feeEarner.id, 'fee_earner');

      await db.updateTable('matter_team').set({ removed_at: new Date(), removed_by: partner.id }).where('matter_id', '=', matterId).where('account_id', '=', feeEarner.id).execute();
      expect((await as(feeToken).post(`/time-entries/${entry.body.id}/corrections`, { reason: 'No access', replacement: null })).status).toBe(404);
    });

    it('refuses malformed corrections and a second correction after voiding', async () => {
      const entry = await recordTime();
      expect((await as(feeToken).post(`/time-entries/${entry.body.id}/corrections`, { reason: '', replacement: null })).status).toBe(400);
      expect((await as(feeToken).post(`/time-entries/${entry.body.id}/corrections`, {
        reason: 'Bad replacement',
        replacement: { workedOn: today, minutes: 30, description: 'Correct text', extra: true },
      })).status).toBe(400);

      expect((await as(feeToken).post(`/time-entries/${entry.body.id}/corrections`, { reason: 'Wrong matter', replacement: null })).status).toBe(200);
      expect((await as(feeToken).post(`/time-entries/${entry.body.id}/corrections`, { reason: 'Again', replacement: null })).status).toBe(409);
    });

    it('suppresses an unchanged correction and rolls a change back when audit fails', async () => {
      const entry = await recordTime();
      const unchanged = await as(feeToken).post(`/time-entries/${entry.body.id}/corrections`, {
        reason: 'No actual change',
        replacement: { workedOn: today, minutes: 60, description: 'Prepared the completion statement' },
      });
      expect(unchanged.status).toBe(200);
      expect(unchanged.body.corrections).toEqual([]);
      expect(await db.selectFrom('audit_events').select('id').where('action', '=', 'time.corrected').where('resource_id', '=', entry.body.id).executeTakeFirst()).toBeUndefined();

      const audit = failAudit('time.corrected');
      let failed: request.Response;
      try {
        failed = await as(feeToken).post(`/time-entries/${entry.body.id}/corrections`, {
          reason: 'Timer error',
          replacement: { workedOn: today, minutes: 30, description: 'Prepared the statement' },
        });
      } finally {
        audit.mockRestore();
      }
      expect(failed!.status).toBe(500);
      const stored = await db.selectFrom('time_entries').select(['minutes', 'description']).where('id', '=', entry.body.id).executeTakeFirstOrThrow();
      expect(stored).toEqual({ minutes: 60, description: 'Prepared the completion statement' });
      expect(await db.selectFrom('time_entry_corrections').select('id').where('time_entry_id', '=', entry.body.id).executeTakeFirst()).toBeUndefined();
    });

    it('allows a correction after matter closure and audits no private text or reason', async () => {
      const entry = await recordTime();
      await db.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'All work is complete' }).execute();
      const corrected = await as(feeToken).post(`/time-entries/${entry.body.id}/corrections`, {
        reason: 'Confidential correction explanation',
        replacement: null,
      });
      expect(corrected.status).toBe(200);
      const event = await db.selectFrom('audit_events').select(['action', 'metadata']).where('action', '=', 'time.corrected').where('resource_id', '=', entry.body.id).executeTakeFirstOrThrow();
      expect(event).toEqual({ action: 'time.corrected', metadata: { matterId, voided: true, fields: 'workedOn,minutes,description,hourlyRate' } });
      expect(JSON.stringify(event)).not.toMatch(/Confidential|completion statement/);
    });

    it('requires a session and keeps clients outside staff finance routes', async () => {
      expect((await request(app.getHttpServer()).get(`/matters/${matterId}/time-entries`)).status).toBe(401);
      const client = await createTestAccount(db, 'client');
      expect((await as(await signedIn(client)).get(`/matters/${matterId}/time-entries`)).status).toBe(403);
    });
  });
});
