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

@Module({ imports: [HrModule] })
class HrTestModule {}

const MINIMAL_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
const pattern = { timeZone: 'Europe/London', mondayMinutes: 450, tuesdayMinutes: 450,
  wednesdayMinutes: 450, thursdayMinutes: 450, fridayMinutes: 420,
  saturdayMinutes: 0, sundayMinutes: 0 };

describe('People / HR foundation API', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let sessions: SessionsService;
  let hr: TestAccount;
  let admin: TestAccount;
  let worker: TestAccount;
  let manager: TestAccount;
  let replacement: TestAccount;
  let hrToken: string;
  let adminToken: string;
  let workerToken: string;
  let managerToken: string;
  let replacementToken: string;
  let today: string;
  let yesterday: string;

  const cookie = (token: string) => `__Host-session=${token}`;
  const api = (token: string) => {
    const server = request(app.getHttpServer());
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie(token)),
      post: (path: string, body: object) => server.post(path).set('Cookie', cookie(token)).send(body),
      put: (path: string, body: object) => server.put(path).set('Cookie', cookie(token)).send(body),
      upload: (path: string) => server.post(path).set('Cookie', cookie(token)),
    };
  };

  async function staffWith(...roles: StaffRole[]) {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) await grantTestRole(db, account.id, role);
    return account;
  }

  async function createPerson(account: TestAccount) {
    const response = await api(hrToken).post('/hr/people', { accountId: account.id });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.personId as string;
  }

  async function engage(personId: string, jobTitle = 'Solicitor') {
    const response = await api(hrToken).post(`/hr/people/${personId}/engagements`, {
      kind: 'employee', startedOn: yesterday, jobTitle, team: 'Disputes', workLocation: 'London', pattern,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.engagementId as string;
  }

  beforeAll(async () => {
    app = await createTestApp(HrTestModule);
    db = app.get(DATABASE);
    ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 1);
    sessions = app.get(SessionsService);
    const dates = (await sql<{ today: string; yesterday: string }>`select
      (clock_timestamp() at time zone 'Europe/London')::date::text as today,
      ((clock_timestamp() at time zone 'Europe/London')::date - 1)::text as yesterday`.execute(db)).rows[0]!;
    today = dates.today;
    yesterday = dates.yesterday;
  });

  afterAll(async () => { await ownerDb.destroy(); await app.close(); });

  beforeEach(async () => {
    hr = await staffWith('hr');
    admin = await staffWith('administrator');
    worker = await staffWith('fee_earner');
    manager = await staffWith('partner');
    replacement = await staffWith('partner');
    [hrToken, adminToken, workerToken, managerToken, replacementToken] = await Promise.all([
      sessions.start(hr, 'authenticated', {}), sessions.start(admin, 'authenticated', {}),
      sessions.start(worker, 'authenticated', {}), sessions.start(manager, 'authenticated', {}),
      sessions.start(replacement, 'authenticated', {}),
    ]);
  });

  it('keeps HR authority separate while exposing only the safe directory', async () => {
    const directoryName = `A HR Directory ${randomUUID()}`;
    await db.updateTable('accounts').set({ display_name: directoryName }).where('id', '=', worker.id).execute();
    expect((await api(adminToken).post('/hr/people', { accountId: worker.id })).status).toBe(403);
    const personId = await createPerson(worker);
    await engage(personId);

    const directory = await api(adminToken).get('/hr/directory');
    expect(directory.status).toBe(200);
    expect(directory.body.people).toContainEqual(expect.objectContaining({ accountId: worker.id,
      personId, displayName: directoryName, jobTitle: 'Solicitor', team: 'Disputes' }));
    expect(JSON.stringify(directory.body)).not.toContain('personalEmail');
    expect((await api(workerToken).get('/hr/people')).status).toBe(403);
    expect(await api(adminToken).get('/hr/access').then((response) => response.body)).toMatchObject({
      personId: null, reportCount: 0, canManagePeople: false, canManageCases: false,
    });
    expect(await api(hrToken).get('/hr/access').then((response) => response.body)).toMatchObject({
      canManagePeople: true, canManageLeave: true, canManageHealth: true, canManageVetting: true,
      canManageCompetence: true, canManageCases: true, canManageRetention: true, canManageExports: true,
    });
  });

  it('encrypts personal details and allows self-service contact changes but not HR authority', async () => {
    const created = await api(hrToken).post('/hr/people', {
      accountId: worker.id,
      contact: { personalEmail: 'worker.personal@example.test', phone: '+44 20 7946 0999',
        address: { line1: '1 Private Street', town: 'London', postcode: 'SW1A 1AA', country: 'GB' },
        emergencyContact: { name: 'Private Contact', relationship: 'Sibling', phone: '+44 7700 900123' } },
      privateDetails: { dateOfBirth: '1990-02-03' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const personId = created.body.personId;

    const self = await api(workerToken).get('/hr/me');
    expect(self.status).toBe(200);
    expect(self.body.contact.personalEmail).toBe('worker.personal@example.test');
    expect(self.body.privateDetails.dateOfBirth).toBe('1990-02-03');

    const changed = await api(workerToken).put('/hr/me/contact', {
      personalEmail: 'new.personal@example.test', phone: null, address: null, emergencyContact: null,
    });
    expect(changed.status).toBe(200);
    expect(changed.body.contact.personalEmail).toBe('new.personal@example.test');
    expect((await api(workerToken).put(`/hr/people/${personId}/private`, { dateOfBirth: '2000-01-01' })).status).toBe(403);

    const raw = await ownerDb.selectFrom('hr_contact_versions').select('ciphertext')
      .where('person_id', '=', personId).orderBy('recorded_at', 'desc').executeTakeFirstOrThrow();
    expect(raw.ciphertext.toString('utf8')).not.toContain('new.personal@example.test');
    expect(JSON.stringify(await ownerDb.selectFrom('audit_events').select('metadata')
      .where('resource_id', '=', personId).execute())).not.toContain('example.test');
  });

  it('gives only the current manager a bounded projection and removes former-manager access', async () => {
    const workerId = await createPerson(worker);
    const managerId = await createPerson(manager);
    const replacementId = await createPerson(replacement);
    await engage(workerId);
    await engage(managerId, 'Partner');
    await engage(replacementId, 'Partner');

    expect((await api(hrToken).post(`/hr/people/${workerId}/manager`, {
      managerPersonId: managerId, effectiveOn: yesterday,
    })).status).toBe(201);
    const first = await api(managerToken).get(`/hr/reports/${workerId}`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ accessKind: 'manager', personId: workerId,
      workPattern: { mondayMinutes: 450 } });
    expect(first.body).not.toHaveProperty('contact');
    expect(first.body).not.toHaveProperty('privateDetails');
    expect(first.body).not.toHaveProperty('files');
    expect(await api(managerToken).get('/hr/reports').then((response) => response.body.people)).toContainEqual(
      expect.objectContaining({ personId: workerId, accountId: worker.id }),
    );
    expect(await api(managerToken).get('/hr/access').then((response) => response.body.reportCount)).toBe(1);

    expect((await api(hrToken).post(`/hr/people/${workerId}/manager`, {
      managerPersonId: replacementId, effectiveOn: today,
    })).status).toBe(201);
    expect((await api(managerToken).get(`/hr/reports/${workerId}`)).status).toBe(404);
    expect(await api(managerToken).get('/hr/reports').then((response) => response.body.people)).toHaveLength(0);
    expect((await api(replacementToken).get(`/hr/reports/${workerId}`)).status).toBe(200);
  });

  it('removes manager access when HR clears the line manager', async () => {
    const workerId = await createPerson(worker);
    const managerId = await createPerson(manager);
    await engage(workerId);
    await engage(managerId, 'Partner');

    expect((await api(hrToken).post(`/hr/people/${workerId}/manager`, {
      managerPersonId: managerId, effectiveOn: yesterday,
    })).status).toBe(201);
    expect((await api(managerToken).get(`/hr/reports/${workerId}`)).status).toBe(200);

    expect((await api(hrToken).post(`/hr/people/${workerId}/manager`, {
      managerPersonId: null, effectiveOn: today,
    })).status).toBe(201);
    expect((await api(managerToken).get(`/hr/reports/${workerId}`)).status).toBe(404);
    expect(await api(managerToken).get('/hr/reports').then((response) => response.body.people)).toHaveLength(0);
  });

  it('removes manager access when either current engagement has ended', async () => {
    const firstWorker = await createPerson(worker);
    const firstManager = await createPerson(manager);
    const firstWorkerEngagement = await engage(firstWorker);
    await engage(firstManager, 'Partner');
    await api(hrToken).post(`/hr/people/${firstWorker}/manager`, {
      managerPersonId: firstManager, effectiveOn: yesterday,
    });
    expect((await api(managerToken).get(`/hr/reports/${firstWorker}`)).status).toBe(200);
    expect((await api(hrToken).post(`/hr/people/${firstWorker}/end-engagement`, {
      engagementId: firstWorkerEngagement, endedOn: yesterday, reason: 'Engagement completed.',
    })).status).toBe(201);
    expect((await api(managerToken).get(`/hr/reports/${firstWorker}`)).status).toBe(404);

    const secondWorker = await createPerson(replacement);
    const secondManager = await createPerson(admin);
    await engage(secondWorker);
    const managerEngagement = await engage(secondManager, 'Operations manager');
    await api(hrToken).post(`/hr/people/${secondWorker}/manager`, {
      managerPersonId: secondManager, effectiveOn: yesterday,
    });
    expect((await api(adminToken).get(`/hr/reports/${secondWorker}`)).status).toBe(200);
    expect((await api(hrToken).post(`/hr/people/${secondManager}/end-engagement`, {
      engagementId: managerEngagement, endedOn: yesterday, reason: 'Manager engagement completed.',
    })).status).toBe(201);
    expect((await api(adminToken).get(`/hr/reports/${secondWorker}`)).status).toBe(404);
  });

  it('refuses reporting-line cycles and overlapping or retroactive employment history', async () => {
    const workerId = await createPerson(worker);
    const managerId = await createPerson(manager);
    const replacementId = await createPerson(replacement);
    const workerEngagement = await engage(workerId);
    await engage(managerId, 'Partner');
    const replacementEngagement = await engage(replacementId, 'Partner');
    expect((await api(hrToken).post(`/hr/people/${workerId}/manager`, {
      managerPersonId: managerId, effectiveOn: yesterday,
    })).status).toBe(201);
    expect((await api(hrToken).post(`/hr/people/${managerId}/manager`, {
      managerPersonId: workerId, effectiveOn: today,
    })).status).toBe(409);
    expect((await api(hrToken).post(`/hr/people/${workerId}/engagements`, {
      kind: 'consultant', startedOn: today, jobTitle: 'Consultant', team: null, workLocation: null, pattern,
    })).status).toBe(409);
    expect((await api(hrToken).post(`/hr/people/${workerId}/terms`, {
      engagementId: workerEngagement, effectiveOn: yesterday, jobTitle: 'Backdated', team: null, workLocation: null,
    })).status).toBe(409);
    expect((await api(hrToken).post(`/hr/people/${workerId}/terms`, {
      engagementId: replacementEngagement, effectiveOn: today, jobTitle: 'Wrong person', team: null, workLocation: null,
    })).status).toBe(404);
  });

  it('keeps correction requests append-only and visible only to the worker and HR', async () => {
    const personId = await createPerson(worker);
    const otherPersonId = await createPerson(replacement);
    const requested = await api(workerToken).post('/hr/me/corrections', {
      category: 'personal', request: 'Please correct the date shown in my private record.',
    });
    expect(requested.status).toBe(201);
    const correctionId = requested.body.corrections[0].id;
    expect((await api(managerToken).get(`/hr/reports/${personId}`)).status).toBe(404);

    const queue = await api(hrToken).get('/hr/corrections');
    expect(queue.status).toBe(200);
    expect(queue.body.corrections[0]).toMatchObject({ id: correctionId, personId, outcome: null });
    expect((await api(hrToken).post(`/hr/people/${otherPersonId}/corrections/${correctionId}/decision`, {
      outcome: 'resolved', response: 'A request cannot be decided through another person path.',
    })).status).toBe(404);
    const decided = await api(hrToken).post(`/hr/people/${personId}/corrections/${correctionId}/decision`, {
      outcome: 'resolved', response: 'The source evidence was checked and the record was corrected.',
    });
    expect(decided.status).toBe(201);
    expect(decided.body.corrections[0].outcome).toBe('resolved');
    expect((await api(hrToken).post(`/hr/people/${personId}/corrections/${correctionId}/decision`, {
      outcome: 'rejected', response: 'A second decision must not replace the first one.',
    })).status).toBe(409);
  });

  it('streams encrypted private files only to HR or the worker when marked visible', async () => {
    const personId = await createPerson(worker);
    const upload = await api(hrToken).upload(`/hr/people/${personId}/files`)
      .field('category', 'contract').field('workerVisible', 'true')
      .attach('file', MINIMAL_PDF, 'employment-contract.pdf');
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const fileId = upload.body.files[0].id;
    const stored = await ownerDb.selectFrom('hr_files').select(['storage_key', 'metadata_ciphertext'])
      .where('id', '=', fileId).executeTakeFirstOrThrow();
    expect(stored.storage_key).toMatch(/^hr\/[0-9a-f-]{36}$/);
    expect(stored.metadata_ciphertext.toString('utf8')).not.toContain('employment-contract.pdf');

    const downloaded = await api(workerToken).get(`/hr/people/${personId}/files/${fileId}/content`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['content-disposition']).toContain('employment-contract.pdf');
    expect((await api(adminToken).get(`/hr/people/${personId}/files/${fileId}/content`)).status).toBe(404);
  });

  it('denies direct application-table access and owner mutation', async () => {
    const personId = await createPerson(worker);
    await expect(db.selectFrom('hr_people').selectAll().execute()).rejects.toThrow(/permission denied/);
    await expect(sql`insert into app.hr_people(account_id,created_by) values(${randomUUID()},${hr.id})`
      .execute(ownerDb)).rejects.toThrow(/written only through protected functions/);
    await expect(sql`update app.hr_people set account_id=${admin.id} where id=${personId}`
      .execute(ownerDb)).rejects.toThrow(/immutable/);
    await expect(sql`truncate app.hr_people cascade`.execute(ownerDb)).rejects.toThrow(/cannot be truncated/);
  });

  it('serializes a protected HR read against loss of the live HR role', async () => {
    const personId = await createPerson(worker);
    const reading = db.transaction().execute(async (trx) => {
      const result = await sql`select * from app.read_hr_person_summary(${personId},${hr.id})`.execute(trx);
      await new Promise((resolve) => setTimeout(resolve, 120));
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    let revoked = false;
    const removal = revokeTestRole(db, hr.id, 'hr').then(() => { revoked = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(revoked).toBe(false);
    expect((await reading).rows).toHaveLength(1);
    await removal;
    expect((await api(hrToken).get(`/hr/people/${personId}`)).status).toBe(403);
  });

  it('rejects unknown and unsafe input fields', async () => {
    const personId = await createPerson(worker);
    expect((await api(hrToken).post(`/hr/people/${personId}/engagements`, {
      kind: 'employee', startedOn: today, jobTitle: 'Solicitor\u202E', team: null,
      workLocation: null, pattern, role: 'administrator',
    })).status).toBe(400);
  });
});
