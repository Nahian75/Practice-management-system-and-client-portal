import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAccount, grantTestRole, revokeTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { ClientsModule } from './clients.module.js';

const INDIVIDUAL = { kind: 'individual', givenNames: 'Jane', familyName: 'Doe' };
const ORGANISATION = { kind: 'organisation', legalName: 'Acme Trading Ltd', organisationType: 'company' };

describe('Clients', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let feeEarner: TestAccount;
  let token: string;

  const as = (sessionToken: string) => {
    const server = request(app.getHttpServer());
    const cookie = `__Host-session=${sessionToken}`;
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie),
      post: (path: string, body?: object) => server.post(path).set('Cookie', cookie).send(body),
    };
  };
  const signedIn = (account: TestAccount) => sessions.start(account, 'authenticated', {});

  async function staffWith(...roles: StaffRole[]): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) {
      await grantTestRole(db, account.id, role);
    }
    return account;
  }

  const clientsCreatedBy = (accountId: string) =>
    db.selectFrom('clients').select('id').where('created_by', '=', accountId).execute();

  beforeAll(async () => {
    app = await createTestApp(ClientsModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    feeEarner = await staffWith('fee_earner');
    token = await signedIn(feeEarner);
  });

  describe('POST /clients', () => {
    it('creates an individual and normalises the details', async () => {
      const created = await as(token).post('/clients', {
        ...INDIVIDUAL,
        title: ' Dr ',
        givenNames: ' Jane Mary ',
        dateOfBirth: '1980-02-29',
        email: ' Jane.Doe@Example.COM ',
        phone: '+44 20 7946 0000',
        address: { line1: '1 High Street', town: 'London', postcode: 'sw1a 1aa', country: 'gb' },
      });

      expect(created.status).toBe(201);
      expect(created.body.reference).toMatch(/^C-\d{6,}$/);
      const found = await as(token).get(`/clients/${created.body.id}`);
      expect(found.body).toEqual({
        id: created.body.id,
        reference: created.body.reference,
        kind: 'individual',
        status: 'active',
        createdAt: expect.any(String),
        title: 'Dr',
        givenNames: 'Jane Mary',
        familyName: 'Doe',
        dateOfBirth: '1980-02-29',
        email: 'jane.doe@example.com',
        phone: '+44 20 7946 0000',
        address: { line1: '1 High Street', line2: null, town: 'London', postcode: 'SW1A 1AA', country: 'GB' },
      });
    });

    it('creates an organisation', async () => {
      const created = await as(token).post('/clients', { ...ORGANISATION, registrationNumber: 'sc123456' });

      expect(created.status).toBe(201);
      const found = await as(token).get(`/clients/${created.body.id}`);
      expect(found.body).toMatchObject({
        kind: 'organisation',
        legalName: 'Acme Trading Ltd',
        organisationType: 'company',
        registrationNumber: 'SC123456',
        email: null,
        address: null,
      });
    });

    it('records the creation with the kind only, never the details', async () => {
      const created = await as(token)
        .post('/clients', { ...INDIVIDUAL, email: 'jane@example.com' })
        .set('X-Forwarded-For', '198.18.9.9')
        .set('User-Agent', 'clients-test');

      const events = await db
        .selectFrom('audit_events')
        .selectAll()
        .where('resource_id', '=', created.body.id)
        .execute();
      expect(events).toMatchObject([
        {
          actor_id: feeEarner.id,
          action: 'client.created',
          outcome: 'success',
          resource_type: 'client',
          metadata: { kind: 'individual' },
          ip_address: '198.18.9.9',
          user_agent: 'clients-test',
        },
      ]);
      expect(JSON.stringify(events)).not.toMatch(/Jane|Doe|jane@example\.com/);
    });

    it('creates nothing when the audit record cannot be written', async () => {
      vi.spyOn(app.get(AuditService), 'record').mockRejectedValueOnce(new Error('audit unavailable'));

      expect((await as(token).post('/clients', INDIVIDUAL)).status).toBe(500);
      expect(await clientsCreatedBy(feeEarner.id)).toEqual([]);
    });

    it.each<[string, object]>([
      ['a reference', { ...INDIVIDUAL, reference: 'C-000001' }],
      ['a creator', { ...INDIVIDUAL, createdBy: '00000000-0000-7000-8000-000000000000' }],
      ['a status', { ...INDIVIDUAL, status: 'archived' }],
      ['an id', { ...INDIVIDUAL, id: '00000000-0000-7000-8000-000000000000' }],
      ['an organisation field on an individual', { ...INDIVIDUAL, legalName: 'Acme' }],
      ['an unknown address field', { ...INDIVIDUAL, address: { line1: '1 High St', town: 'Leeds', country: 'GB', flat: '2' } }],
    ])('refuses %s in the body', async (_case, body) => {
      expect((await as(token).post('/clients', body)).status).toBe(400);
      expect(await clientsCreatedBy(feeEarner.id)).toEqual([]);
    });

    it.each<[string, object]>([
      ['an unknown kind', { ...INDIVIDUAL, kind: 'trust' }],
      ['blank given names', { ...INDIVIDUAL, givenNames: '   ' }],
      ['an invalid email', { ...INDIVIDUAL, email: 'jane.example.com' }],
      ['a phone number with letters', { ...INDIVIDUAL, phone: '0207 CALL ME' }],
      ['a code that is not a country', { ...INDIVIDUAL, address: { line1: '1 High St', town: 'Leeds', country: 'UK' } }],
      ['an address without a town', { ...INDIVIDUAL, address: { line1: '1 High St', country: 'GB' } }],
      ['a date of birth in the future', { ...INDIVIDUAL, dateOfBirth: '2999-01-01' }],
      ['a date of birth before 1900', { ...INDIVIDUAL, dateOfBirth: '1899-12-31' }],
      ['an impossible date', { ...INDIVIDUAL, dateOfBirth: '1981-02-29' }],
      ['an unknown organisation type', { ...ORGANISATION, organisationType: 'club' }],
      ['a registration number with symbols', { ...ORGANISATION, registrationNumber: 'SC-123' }],
    ])('refuses %s', async (_case, body) => {
      expect((await as(token).post('/clients', body)).status).toBe(400);
    });

    it('is open to a partner', async () => {
      expect((await as(await signedIn(await staffWith('partner'))).post('/clients', INDIVIDUAL)).status).toBe(201);
    });

    it.each(['administrator', 'accounts', 'compliance'] as const)('is closed to %s', async (role) => {
      const staff = await staffWith(role);

      expect((await as(await signedIn(staff)).post('/clients', INDIVIDUAL)).status).toBe(403);
      expect(await clientsCreatedBy(staff.id)).toEqual([]);
    });

    it('is closed to clients', async () => {
      const client = await createTestAccount(db, 'client');

      expect((await as(await signedIn(client)).post('/clients', INDIVIDUAL)).status).toBe(403);
    });

    it('asks for sign-in when there is no session', async () => {
      expect((await request(app.getHttpServer()).post('/clients').send(INDIVIDUAL)).status).toBe(401);
    });
  });

  describe('GET /clients/:clientId', () => {
    let clientId: string;

    beforeEach(async () => {
      clientId = (await as(token).post('/clients', INDIVIDUAL)).body.id;
    });

    it('is not found by another fee earner, with the same answer as a client that does not exist', async () => {
      const other = await as(await signedIn(await staffWith('fee_earner'))).get(`/clients/${clientId}`);
      const missing = await as(token).get('/clients/00000000-0000-7000-8000-000000000000');

      expect(other.status).toBe(404);
      expect(other.body).toEqual(missing.body);
    });

    it('is not found by a partner who did not create it', async () => {
      expect((await as(await signedIn(await staffWith('partner'))).get(`/clients/${clientId}`)).status).toBe(404);
    });

    it('is closed to the creator once their role is revoked', async () => {
      await revokeTestRole(db, feeEarner.id, 'fee_earner');

      expect((await as(token).get(`/clients/${clientId}`)).status).toBe(403);
    });

    it('refuses an id that is not a UUID', async () => {
      expect((await as(token).get('/clients/C-000001')).status).toBe(400);
    });
  });
});
