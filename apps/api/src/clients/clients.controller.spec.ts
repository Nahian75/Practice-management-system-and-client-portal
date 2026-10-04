import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAccount, grantTestRole, revokeTestRole, setAccountStatus, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { testAppDatabaseUrl } from '../../test/database.js';
import { inbox } from '../../test/mailpit.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { createDatabase } from '../database/database.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { MailOutbox } from '../mail/mail-outbox.js';
import { ClientsModule } from './clients.module.js';
import { ClientsRepository } from './clients.repository.js';

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
      ['a null byte, which the database cannot store', { ...INDIVIDUAL, givenNames: 'Ja\u0000ne' }],
      ['a line break in a name', { ...INDIVIDUAL, familyName: 'Doe\nBcc: someone@example.com' }],
      ['a right-to-left override in a name', { ...INDIVIDUAL, familyName: 'Doe\u202Eevil' }],
      ['a name of invisible characters only', { ...INDIVIDUAL, givenNames: '\u200B\u200B' }],
      ['a tab in an address line', { ...INDIVIDUAL, address: { line1: '1\tHigh St', town: 'Leeds', country: 'GB' } }],
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

    describe('limit and record (review C2)', () => {
      const searchEvents = (accountId: string) =>
        db
          .selectFrom('audit_events')
          .select(['action', 'outcome', 'metadata'])
          .where('actor_id', '=', accountId)
          .where('action', 'like', 'client.search%')
          .orderBy('id')
          .execute();
      const searchAs = (sessionToken: string) => as(sessionToken).get(`/clients/search?q=${encodeURIComponent(name)}`);

      it('records each search with its number of results, never the text searched for', async () => {
        await searchAs(token);

        const events = await searchEvents(feeEarner.id);
        expect(events).toEqual([{ action: 'client.searched', outcome: 'success', metadata: { results: 1 } }]);
        expect(JSON.stringify(events)).not.toContain(name);
      });

      it('refuses the 61st search in an hour, and records going over the limit once', async () => {
        for (let search = 0; search < 60; search++) {
          expect((await searchAs(token)).status).toBe(200);
        }

        const refused = await searchAs(token);
        await searchAs(token);
        await searchAs(token);

        expect(refused.status).toBe(429);
        expect(refused.headers['retry-after']).toBe('3600');
        expect(refused.body.message).toBe('Too many client searches in the last hour. Try again later');
        const events = await searchEvents(feeEarner.id);
        expect(events.filter((event) => event.action === 'client.searched')).toHaveLength(60);
        expect(events.filter((event) => event.action === 'client.search_limited')).toEqual([
          { action: 'client.search_limited', outcome: 'denied', metadata: { limit: 60 } },
        ]);
      });

      it('limits each person separately', async () => {
        for (let search = 0; search < 60; search++) {
          await searchAs(token);
        }

        expect((await searchAs(await signedIn(await staffWith('fee_earner')))).status).toBe(200);
      });

      // Without the per-person lock, requests in flight together would all pass the count first.
      it('lets exactly 60 of 70 searches sent at once through', async () => {
        const statuses = (await Promise.all(Array.from({ length: 70 }, () => searchAs(token)))).map((r) => r.status);

        expect(statuses.filter((status) => status === 200)).toHaveLength(60);
        expect(statuses.filter((status) => status === 429)).toHaveLength(10);
      });
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

  describe('contacts', () => {
    const SAM = { givenNames: 'Sam', familyName: 'Lee', jobTitle: 'Finance Director', email: 'Sam.Lee@acme.example' };
    let organisationId: string;

    const contactEvents = (id: string) =>
      db
        .selectFrom('audit_events')
        .select(['action', 'metadata'])
        .where('resource_id', '=', id)
        .where('action', 'like', 'client.contact%')
        .orderBy('id')
        .execute();

    beforeEach(async () => {
      organisationId = (await as(token).post('/clients', ORGANISATION)).body.id;
    });

    describe('POST /clients/:clientId/contacts', () => {
      it('adds an active contact, shown with the client', async () => {
        const added = await as(token).post(`/clients/${organisationId}/contacts`, SAM);

        expect(added.status).toBe(201);
        expect((await as(token).get(`/clients/${organisationId}`)).body.contacts).toEqual([
          {
            id: added.body.id,
            givenNames: 'Sam',
            familyName: 'Lee',
            jobTitle: 'Finance Director',
            email: 'sam.lee@acme.example',
            phone: null,
            active: true,
          },
        ]);
      });

      it('records the contact id only, never their details', async () => {
        const added = await as(token).post(`/clients/${organisationId}/contacts`, SAM);

        const events = await contactEvents(organisationId);
        expect(events).toEqual([{ action: 'client.contact_added', metadata: { contactId: added.body.id } }]);
        expect(JSON.stringify(events)).not.toMatch(/Sam|Lee|acme/);
      });

      it('refuses a contact for an individual client', async () => {
        const individualId = (await as(token).post('/clients', INDIVIDUAL)).body.id;

        expect((await as(token).post(`/clients/${individualId}/contacts`, SAM)).status).toBe(409);
      });

      it('does not find a client someone else is responsible for', async () => {
        const other = await signedIn(await staffWith('fee_earner'));

        expect((await as(other).post(`/clients/${organisationId}/contacts`, SAM)).status).toBe(404);
        expect((await as(token).get(`/clients/${organisationId}`)).body.contacts).toEqual([]);
      });

      it.each<[string, object]>([
        ['no family name', { givenNames: 'Sam' }],
        ['an invalid email', { ...SAM, email: 'sam.example' }],
        ['an active flag', { ...SAM, active: false }],
        ['a line break in a job title', { ...SAM, jobTitle: 'Director\nof Finance' }],
        ['a client id', { ...SAM, clientId: '00000000-0000-7000-8000-000000000000' }],
      ])('refuses %s', async (_case, body) => {
        expect((await as(token).post(`/clients/${organisationId}/contacts`, body)).status).toBe(400);
      });

      it.each(['administrator', 'accounts', 'compliance'] as const)('is closed to %s', async (role) => {
        expect((await as(await signedIn(await staffWith(role))).post(`/clients/${organisationId}/contacts`, SAM)).status).toBe(403);
      });

      // Through the API the client is checked first; this checks the contact queries keep the rule on their own.
      it('keeps contact queries to clients the viewer may see', async () => {
        const contactId = (await as(token).post(`/clients/${organisationId}/contacts`, SAM)).body.id;
        const repository = app.get(ClientsRepository);
        const stranger = await staffWith('fee_earner');

        expect(await repository.visibleContacts(organisationId, stranger.id)).toEqual([]);
        expect(await repository.findVisibleContact(organisationId, contactId, stranger.id)).toBeUndefined();
        expect(await repository.findVisibleContact(organisationId, contactId, feeEarner.id)).toMatchObject({ id: contactId });
      });
    });

    describe('PATCH /clients/:clientId/contacts/:contactId', () => {
      let contactId: string;

      beforeEach(async () => {
        contactId = (await as(token).post(`/clients/${organisationId}/contacts`, SAM)).body.id;
      });

      it('changes the given fields and records which ones changed', async () => {
        const response = await as(token).patch(`/clients/${organisationId}/contacts/${contactId}`, {
          jobTitle: 'Chief Executive',
          phone: '+44 161 496 0000',
        });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ jobTitle: 'Chief Executive', phone: '+44 161 496 0000', email: 'sam.lee@acme.example' });
        expect(await contactEvents(organisationId)).toEqual([
          { action: 'client.contact_added', metadata: { contactId } },
          { action: 'client.contact_updated', metadata: { contactId, fields: 'jobTitle,phone' } },
        ]);
      });

      it('marks a contact inactive, listing active contacts first', async () => {
        const other = (await as(token).post(`/clients/${organisationId}/contacts`, { givenNames: 'Ana', familyName: 'Zed' })).body.id;

        await as(token).patch(`/clients/${organisationId}/contacts/${contactId}`, { active: false });

        expect((await as(token).get(`/clients/${organisationId}`)).body.contacts.map((c: { id: string; active: boolean }) => [c.id, c.active])).toEqual([
          [other, true],
          [contactId, false],
        ]);
      });

      it('records nothing when the values are the same as before', async () => {
        await as(token).patch(`/clients/${organisationId}/contacts/${contactId}`, { givenNames: 'Sam', active: true });

        expect(await contactEvents(organisationId)).toHaveLength(1);
      });

      it("does not change another client's contact through this client's address", async () => {
        const otherClient = (await as(token).post('/clients', { ...ORGANISATION, legalName: 'Other Ltd' })).body.id;
        const theirContact = (await as(token).post(`/clients/${otherClient}/contacts`, { givenNames: 'Kim', familyName: 'Ray' })).body.id;

        const response = await as(token).patch(`/clients/${organisationId}/contacts/${theirContact}`, { familyName: 'Changed' });

        expect(response.status).toBe(404);
        expect((await as(token).get(`/clients/${otherClient}`)).body.contacts[0].familyName).toBe('Ray');
      });

      it('does not find a contact of a client someone else is responsible for', async () => {
        const other = await signedIn(await staffWith('fee_earner'));

        expect((await as(other).patch(`/clients/${organisationId}/contacts/${contactId}`, { familyName: 'X' })).status).toBe(404);
      });

      it.each<[string, object]>([
        ['nothing to change', {}],
        ['a required field cleared', { familyName: null }],
        ['a client id', { clientId: '00000000-0000-7000-8000-000000000000' }],
        ['an active flag that is not true or false', { active: 'no' }],
      ])('refuses %s', async (_case, body) => {
        expect((await as(token).patch(`/clients/${organisationId}/contacts/${contactId}`, body)).status).toBe(400);
      });
    });
  });

  describe('POST /clients/:clientId/take-over', () => {
    const REASON = { reason: 'Fee earner left the firm before the matter opened' };
    let clientId: string;
    let partner: TestAccount;
    let partnerToken: string;

    const changesOf = (id: string) =>
      db
        .selectFrom('client_responsibility_changes')
        .select(['id', 'from_account_id', 'to_account_id', 'reason'])
        .where('client_id', '=', id)
        .execute();
    const takeOverEvents = (id: string) =>
      db
        .selectFrom('audit_events')
        .select(['actor_id', 'action', 'outcome', 'metadata'])
        .where('resource_id', '=', id)
        .where('action', 'like', 'client.take%')
        .orderBy('id')
        .execute();

    let reference: string;

    beforeEach(async () => {
      ({ id: clientId, reference } = (await as(token).post('/clients', INDIVIDUAL)).body);
      partner = await staffWith('partner');
      partnerToken = await signedIn(partner);
    });

    // Compliance holders receive notices from other tests too, so only emails naming this client count.
    const noticesAbout = async (address: string, clientReference: string) =>
      (await inbox(address)).filter((email) => email.subject.includes(clientReference));

    describe('telling compliance (review C8)', () => {
      beforeEach(async () => {
        await setAccountStatus(db, feeEarner.id, 'disabled');
      });

      it('tells every compliance holder, naming the client by reference only', async () => {
        const holder = await staffWith('compliance');

        await as(partnerToken).post(`/clients/${clientId}/take-over`, REASON);

        await expect.poll(() => noticesAbout(holder.email, reference), { timeout: 15_000 }).toHaveLength(1);
        const [email] = await noticesAbout(holder.email, reference);
        expect(email?.subject).toBe(`Client ${reference} was taken over`);
        expect(email?.text).toContain(`took over client ${reference}`);
        expect(email?.text).not.toMatch(/Jane|Doe|left the firm/);
      });

      it('does not tell the partner who took it over, even if they hold compliance', async () => {
        await grantTestRole(db, partner.id, 'compliance');

        await as(partnerToken).post(`/clients/${clientId}/take-over`, REASON);
        await app.get(MailOutbox).drain();

        expect(await noticesAbout(partner.email, reference)).toEqual([]);
      });
    });

    it('tells nobody when the takeover is refused', async () => {
      const holder = await staffWith('compliance');

      await as(partnerToken).post(`/clients/${clientId}/take-over`, REASON);
      await app.get(MailOutbox).drain();

      expect(await noticesAbout(holder.email, reference)).toEqual([]);
    });

    describe('when the responsible person is disabled', () => {
      beforeEach(async () => {
        await setAccountStatus(db, feeEarner.id, 'disabled');
      });

      it('makes the partner responsible, so they can open and list the client', async () => {
        expect((await as(partnerToken).get(`/clients/${clientId}`)).status).toBe(404);

        const response = await as(partnerToken).post(`/clients/${clientId}/take-over`, REASON);

        expect(response.status).toBe(204);
        expect((await as(partnerToken).get(`/clients/${clientId}`)).status).toBe(200);
        expect((await as(partnerToken).get('/clients')).body.clients.map((c: { id: string }) => c.id)).toContain(clientId);
      });

      it('keeps the reason with the change, and only a pointer to it in the audit log', async () => {
        await as(partnerToken).post(`/clients/${clientId}/take-over`, REASON);

        const changes = await changesOf(clientId);
        expect(changes).toEqual([
          { id: expect.any(String), from_account_id: feeEarner.id, to_account_id: partner.id, reason: REASON.reason },
        ]);
        const events = await takeOverEvents(clientId);
        expect(events).toEqual([
          {
            actor_id: partner.id,
            action: 'client.taken_over',
            outcome: 'success',
            metadata: { changeId: changes[0]?.id, from: feeEarner.id },
          },
        ]);
        expect(JSON.stringify(events)).not.toContain('left the firm');
      });

      /*
       * Holding the takeover lock from another connection makes both requests
       * queue on it every time; once it is released they run one after the
       * other, and the second finds the first partner responsible and active.
       */
      it('lets only one of two partners taking it over at once succeed', async () => {
        const otherPartner = await signedIn(await staffWith('partner'));
        const holder = createDatabase<Database>(testAppDatabaseUrl(), 1);
        const lockKey = sql`hashtextextended(${`app.client_responsibility:${clientId}`}, 0)`;
        try {
          await sql`select pg_advisory_lock(${lockKey})`.execute(holder);
          const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(holder);
          const holderPid = rows[0]?.pid;
          const responses = Promise.all([
            as(partnerToken).post(`/clients/${clientId}/take-over`, REASON).then((r) => r),
            as(otherPartner).post(`/clients/${clientId}/take-over`, REASON).then((r) => r),
          ]);
          await expect
            .poll(async () => {
              const blocked = await sql<{ count: string }>`
                select count(*) from pg_stat_activity where ${holderPid}::int = any(pg_blocking_pids(pid))`.execute(db);
              return Number(blocked.rows[0]?.count);
            })
            .toBe(2);
          await sql`select pg_advisory_unlock(${lockKey})`.execute(holder);

          expect((await responses).map((response) => response.status).sort()).toEqual([204, 409]);
          expect(await changesOf(clientId)).toHaveLength(1);
        } finally {
          await holder.destroy();
        }
      });

      it.each<[string, object]>([
        ['no reason', {}],
        ['a short reason', { reason: '  left    ' }],
        ['a reason over 500 characters', { reason: 'x'.repeat(501) }],
        ['a reason with a null byte', { reason: 'Left the firm\u0000 last month' }],
        ['someone else to hand it to', { ...REASON, toAccountId: '00000000-0000-7000-8000-000000000000' }],
      ])('refuses %s', async (_case, body) => {
        expect((await as(partnerToken).post(`/clients/${clientId}/take-over`, body)).status).toBe(400);
        expect(await changesOf(clientId)).toEqual([]);
      });

      it.each(['fee_earner', 'administrator', 'compliance'] as const)('is closed to %s', async (role) => {
        expect((await as(await signedIn(await staffWith(role))).post(`/clients/${clientId}/take-over`, REASON)).status).toBe(403);
        expect(await changesOf(clientId)).toEqual([]);
      });
    });

    it('refuses while the responsible person is active, and records the attempt', async () => {
      const response = await as(partnerToken).post(`/clients/${clientId}/take-over`, REASON);

      expect(response.status).toBe(409);
      expect(await changesOf(clientId)).toEqual([]);
      expect((await as(partnerToken).get(`/clients/${clientId}`)).status).toBe(404);
      expect(await takeOverEvents(clientId)).toEqual([
        { actor_id: partner.id, action: 'client.take_over_refused', outcome: 'denied', metadata: { reason: 'responsible_has_access' } },
      ]);
    });

    it('does not find a client that does not exist', async () => {
      expect((await as(partnerToken).post('/clients/00000000-0000-7000-8000-000000000000/take-over', REASON)).status).toBe(404);
    });

    // Review C3: the responsible person moved to another team, still at work but unable to see clients.
    it('takes over from someone still active who no longer holds a role that sees clients', async () => {
      await revokeTestRole(db, feeEarner.id, 'fee_earner');
      await grantTestRole(db, feeEarner.id, 'accounts');

      expect((await as(partnerToken).post(`/clients/${clientId}/take-over`, REASON)).status).toBe(204);
      expect((await as(partnerToken).get(`/clients/${clientId}`)).status).toBe(200);
    });
  });
});
