import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAccount, grantTestRole, revokeTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { testAppDatabaseUrl } from '../../test/database.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { createDatabase } from '../database/database.js';
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
      patch: (path: string, body?: object) => server.patch(path).set('Cookie', cookie).send(body),
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

  describe('GET /clients', () => {
    it('lists only your own clients, newest first, without their details', async () => {
      const first = (await as(token).post('/clients', { ...INDIVIDUAL, email: 'jane@example.com' })).body;
      const second = (await as(token).post('/clients', ORGANISATION)).body;
      await as(await signedIn(await staffWith('fee_earner'))).post('/clients', INDIVIDUAL);

      const response = await as(token).get('/clients');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        clients: [
          { id: second.id, reference: second.reference, kind: 'organisation', name: 'Acme Trading Ltd' },
          { id: first.id, reference: first.reference, kind: 'individual', name: 'Jane Doe' },
        ],
        next: null,
      });
    });

    it('pages through many clients', async () => {
      for (let created = 0; created < 52; created++) {
        await as(token).post('/clients', INDIVIDUAL);
      }

      const firstPage = await as(token).get('/clients');
      const secondPage = await as(token).get(`/clients?before=${firstPage.body.next}`);

      expect(firstPage.body.clients).toHaveLength(50);
      expect(firstPage.body.next).toBe(firstPage.body.clients[49].reference);
      expect(secondPage.body).toMatchObject({ next: null });
      expect(secondPage.body.clients).toHaveLength(2);
    });

    it.each(['?before=12', '?before=C-1', '?page=2', '?before=C-000001&before=C-000002'])('refuses %s', async (query) => {
      expect((await as(token).get(`/clients${query}`)).status).toBe(400);
    });

    it.each(['administrator', 'accounts', 'compliance'] as const)('is closed to %s', async (role) => {
      expect((await as(await signedIn(await staffWith(role))).get('/clients')).status).toBe(403);
    });
  });

  describe('GET /clients/search', () => {
    let name: string;
    let theirs: { id: string; reference: string };

    beforeEach(async () => {
      name = `Searchable ${randomUUID().slice(0, 8)}`;
      const someoneElse = await signedIn(await staffWith('fee_earner'));
      theirs = (await as(someoneElse).post('/clients', { ...ORGANISATION, legalName: `${name} Holdings Ltd`, email: 'x@example.com' })).body;
    });

    it('finds any client by part of the name, showing only reference, kind and name', async () => {
      const response = await as(token).get(`/clients/search?q=${encodeURIComponent(name.toLowerCase())}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        clients: [{ id: theirs.id, reference: theirs.reference, kind: 'organisation', name: `${name} Holdings Ltd` }],
      });
    });

    it('finds a client by its reference', async () => {
      const response = await as(token).get(`/clients/search?q=${theirs.reference.toLowerCase()}`);

      expect(response.body.clients[0]).toMatchObject({ id: theirs.id });
    });

    it('treats % and _ as ordinary characters', async () => {
      expect((await as(token).get('/clients/search?q=%25%25')).body).toEqual({ clients: [] });
      expect((await as(token).get('/clients/search?q=__')).body).toEqual({ clients: [] });
    });

    it('returns at most 20 clients', async () => {
      for (let created = 0; created < 21; created++) {
        await as(token).post('/clients', { ...ORGANISATION, legalName: `${name} ${created}` });
      }

      expect((await as(token).get(`/clients/search?q=${encodeURIComponent(name)}`)).body.clients).toHaveLength(20);
    });

    it.each(['', '?q=a', '?q=%20%20a%20', `?q=${'a'.repeat(101)}`, '?q=ab&q=cd', '?q=ab&kind=individual'])(
      'refuses the query %s',
      async (query) => {
        expect((await as(token).get(`/clients/search${query}`)).status).toBe(400);
      },
    );

    it.each(['administrator', 'accounts', 'compliance'] as const)('is closed to %s', async (role) => {
      expect((await as(await signedIn(await staffWith(role))).get(`/clients/search?q=${name}`)).status).toBe(403);
    });
  });

  describe('PATCH /clients/:clientId', () => {
    let clientId: string;

    const updatesOf = (id: string) =>
      db
        .selectFrom('audit_events')
        .select(['actor_id', 'metadata'])
        .where('resource_id', '=', id)
        .where('action', '=', 'client.updated')
        .orderBy('id')
        .execute();

    beforeEach(async () => {
      clientId = (
        await as(token).post('/clients', {
          ...INDIVIDUAL,
          email: 'jane@example.com',
          phone: '020 7946 0000',
          address: { line1: '1 High Street', town: 'London', country: 'GB' },
        })
      ).body.id;
    });

    it('changes the given fields, keeps the rest, and records which fields changed', async () => {
      const response = await as(token).patch(`/clients/${clientId}`, {
        kind: 'individual',
        familyName: 'Smith',
        email: ' JANE.SMITH@example.com ',
      });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        givenNames: 'Jane',
        familyName: 'Smith',
        email: 'jane.smith@example.com',
        phone: '020 7946 0000',
      });
      const updates = await updatesOf(clientId);
      expect(updates).toEqual([{ actor_id: feeEarner.id, metadata: { fields: 'email,familyName' } }]);
      expect(JSON.stringify(updates)).not.toMatch(/Smith|jane/);
    });

    it('clears optional fields with null', async () => {
      const response = await as(token).patch(`/clients/${clientId}`, { kind: 'individual', phone: null, address: null });

      expect(response.body).toMatchObject({ phone: null, address: null, email: 'jane@example.com' });
      expect(await updatesOf(clientId)).toEqual([{ actor_id: feeEarner.id, metadata: { fields: 'address,phone' } }]);
    });

    it('replaces the whole address', async () => {
      const response = await as(token).patch(`/clients/${clientId}`, {
        kind: 'individual',
        address: { line1: '2 Low Road', town: 'Leeds', postcode: 'ls1 1aa', country: 'GB' },
      });

      expect(response.body.address).toEqual({ line1: '2 Low Road', line2: null, town: 'Leeds', postcode: 'LS1 1AA', country: 'GB' });
    });

    it('records nothing when the values are the same as before', async () => {
      const response = await as(token).patch(`/clients/${clientId}`, {
        kind: 'individual',
        email: 'jane@example.com',
        address: { line1: '1 High Street', town: 'London', country: 'GB' },
      });

      expect(response.status).toBe(200);
      expect(await updatesOf(clientId)).toEqual([]);
    });

    it('refuses a change for the other kind of client', async () => {
      const response = await as(token).patch(`/clients/${clientId}`, { kind: 'organisation', legalName: 'Doe Ltd' });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('This client is an individual');
    });

    it.each<[string, object]>([
      ['nothing to change', { kind: 'individual' }],
      ['no kind', { familyName: 'Smith' }],
      ['a reference', { kind: 'individual', reference: 'C-000001' }],
      ['a status', { kind: 'individual', status: 'archived' }],
      ['a creator', { kind: 'individual', createdBy: '00000000-0000-7000-8000-000000000000' }],
      ['a required field cleared', { kind: 'individual', givenNames: null }],
      ['an invalid email', { kind: 'individual', email: 'jane.example.com' }],
    ])('refuses %s', async (_case, body) => {
      expect((await as(token).patch(`/clients/${clientId}`, body)).status).toBe(400);
      expect(await updatesOf(clientId)).toEqual([]);
    });

    it('does not find a client someone else is responsible for, and leaves it unchanged', async () => {
      const other = await as(await signedIn(await staffWith('fee_earner'))).patch(`/clients/${clientId}`, {
        kind: 'individual',
        familyName: 'Smith',
      });

      expect(other.status).toBe(404);
      expect((await as(token).get(`/clients/${clientId}`)).body.familyName).toBe('Doe');
    });

    it('changes nothing when the audit record cannot be written', async () => {
      vi.spyOn(app.get(AuditService), 'record').mockRejectedValueOnce(new Error('audit unavailable'));

      expect((await as(token).patch(`/clients/${clientId}`, { kind: 'individual', familyName: 'Smith' })).status).toBe(500);
      expect((await as(token).get(`/clients/${clientId}`)).body.familyName).toBe('Doe');
    });

    /*
     * Another connection holds the row, so both requests are in flight together
     * every time. With the service's lock, the second one reads the first one's
     * change and has nothing to record; without it, both would record a change.
     */
    it('records the same change sent twice at the same moment only once', async () => {
      const holder = createDatabase<Database>(testAppDatabaseUrl(), 1);
      try {
        await sql`begin`.execute(holder);
        await sql`select 1 from client_individuals where client_id = ${clientId} for update`.execute(holder);
        const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(holder);
        const holderPid = rows[0]?.pid;

        const change = () => as(token).patch(`/clients/${clientId}`, { kind: 'individual', familyName: 'Smith' }).then((r) => r);
        const responses = Promise.all([change(), change()]);
        await expect
          .poll(async () => {
            const waiting = await sql<{ count: string }>`
              select count(*) from pg_stat_activity
              where wait_event_type = 'Lock' and pid <> ${holderPid}::int and query ilike '%client_individuals%'`.execute(db);
            return Number(waiting.rows[0]?.count);
          })
          .toBe(2);
        await sql`commit`.execute(holder);

        expect((await responses).map((response) => response.status)).toEqual([200, 200]);
        expect(await updatesOf(clientId)).toHaveLength(1);
      } finally {
        await holder.destroy();
      }
    });

    it.each(['administrator', 'accounts', 'compliance'] as const)('is closed to %s', async (role) => {
      const response = await as(await signedIn(await staffWith(role))).patch(`/clients/${clientId}`, {
        kind: 'individual',
        familyName: 'Smith',
      });

      expect(response.status).toBe(403);
    });
  });
});
