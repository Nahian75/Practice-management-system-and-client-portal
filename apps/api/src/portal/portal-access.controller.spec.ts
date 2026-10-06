import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { waitForEmailWithSubject } from '../../test/mailpit.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { ClientsModule } from '../clients/clients.module.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { MailOutbox } from '../mail/mail-outbox.js';
import { PortalModule } from './portal.module.js';

@Module({ imports: [ClientsModule, PortalModule] })
class ClientsAndPortalModule {}

describe('Portal access', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let feeEarner: TestAccount;
  let token: string;

  const cookie = (sessionToken: string) => `__Host-session=${sessionToken}`;
  const signedIn = (account: TestAccount) => sessions.start(account, 'authenticated', {});
  const uniqueEmail = () => `client-${randomUUID()}@example.com`;

  async function staffWith(...roles: StaffRole[]): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) {
      await grantTestRole(db, account.id, role);
    }
    return account;
  }

  const as = (sessionToken: string) => {
    const server = request(app.getHttpServer());
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie(sessionToken)),
      post: (path: string, body: object = {}) => server.post(path).set('Cookie', cookie(sessionToken)).send(body),
      delete: (path: string) => server.delete(path).set('Cookie', cookie(sessionToken)),
    };
  };

  const individualClient = async (email: string | null) =>
    (await as(token).post('/clients', { kind: 'individual', givenNames: 'Jane', familyName: `Doe${randomUUID().slice(0, 8)}`, ...(email ? { email } : {}) })).body as {
      id: string;
    };

  async function organisationWithContact(email: string | null) {
    const client = (await as(token).post('/clients', { kind: 'organisation', legalName: `Acme ${randomUUID().slice(0, 8)} Ltd`, organisationType: 'company' })).body as {
      id: string;
    };
    const contact = (await as(token).post(`/clients/${client.id}/contacts`, { givenNames: 'Kim', familyName: 'Ray', ...(email ? { email } : {}) })).body as {
      id: string;
    };
    return { clientId: client.id, contactId: contact.id };
  }

  const auditOf = (clientId: string, action: string) =>
    db.selectFrom('audit_events').select(['actor_id', 'metadata']).where('resource_id', '=', clientId).where('action', '=', action).execute();

  beforeAll(async () => {
    app = await createTestApp(ClientsAndPortalModule);
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

  describe('POST /clients/:id/portal-access', () => {
    it('invites an individual client at the address on their record, and lists them', async () => {
      const email = uniqueEmail();
      const client = await individualClient(email);

      const granted = await as(token).post(`/clients/${client.id}/portal-access`);
      await app.get(MailOutbox).drain();

      expect(granted.status).toBe(201);
      expect(granted.body).toEqual({ id: expect.any(String), accountId: expect.any(String), invited: true });
      const account = await db.selectFrom('accounts').select(['kind', 'status', 'email']).where('id', '=', granted.body.accountId).executeTakeFirstOrThrow();
      expect(account).toEqual({ kind: 'client', status: 'invited', email });
      expect(await waitForEmailWithSubject(email, 'Set up your Practice Portal account')).toBeDefined();
      const listed = await as(token).get(`/clients/${client.id}/portal-access`);
      expect(listed.body.people).toEqual([
        {
          id: granted.body.id,
          accountId: granted.body.accountId,
          contactId: null,
          name: expect.stringMatching(/^Jane Doe/),
          email,
          accountStatus: 'invited',
          linkedAt: expect.any(String),
        },
      ]);
      expect(await auditOf(client.id, 'portal.access_granted')).toEqual([
        { actor_id: feeEarner.id, metadata: { linkId: granted.body.id, accountId: granted.body.accountId, invited: true } },
      ]);
    });

    it("invites an organisation's contact at the contact's address", async () => {
      const email = uniqueEmail();
      const { clientId, contactId } = await organisationWithContact(email);

      const granted = await as(token).post(`/clients/${clientId}/portal-access`, { contactId });

      expect(granted.status).toBe(201);
      expect((await as(token).get(`/clients/${clientId}/portal-access`)).body.people[0]).toMatchObject({ contactId, email, name: 'Kim Ray' });
    });

    it('links someone who already uses the portal, without inviting them again, and tells them', async () => {
      const person = await createTestAccount(db, 'client');
      const client = await individualClient(person.email);

      const granted = await as(token).post(`/clients/${client.id}/portal-access`);
      await app.get(MailOutbox).drain();

      expect(granted.body).toEqual({ id: expect.any(String), accountId: person.id, invited: false });
      const told = await waitForEmailWithSubject(person.email, 'More matters in your client portal');
      expect(told?.text).not.toContain('Jane');
    });

    describe('refuses', () => {
      it('a person with no email address on record, pointing staff to the record', async () => {
        const client = await individualClient(null);

        const refused = await as(token).post(`/clients/${client.id}/portal-access`);

        expect(refused.status).toBe(409);
        expect(refused.body.message).toContain('Add an email address to their record first');
      });

      it('a contact that is not a current contact of this client, or none for an organisation, or one for an individual', async () => {
        const { clientId, contactId } = await organisationWithContact(uniqueEmail());
        const other = await organisationWithContact(uniqueEmail());
        const individual = await individualClient(uniqueEmail());
        await request(app.getHttpServer())
          .patch(`/clients/${clientId}/contacts/${contactId}`)
          .set('Cookie', cookie(token))
          .send({ givenNames: 'Kim', familyName: 'Ray', active: false });

        expect((await as(token).post(`/clients/${clientId}/portal-access`, { contactId })).status).toBe(400);
        expect((await as(token).post(`/clients/${clientId}/portal-access`, { contactId: other.contactId })).status).toBe(400);
        expect((await as(token).post(`/clients/${clientId}/portal-access`)).status).toBe(400);
        expect((await as(token).post(`/clients/${individual.id}/portal-access`, { contactId: other.contactId })).status).toBe(400);
      });

      it('a second grant for the same person and client', async () => {
        const client = await individualClient(uniqueEmail());
        await as(token).post(`/clients/${client.id}/portal-access`);

        expect((await as(token).post(`/clients/${client.id}/portal-access`)).status).toBe(409);
      });

      it('an address that belongs to a staff account', async () => {
        const colleague = await staffWith('fee_earner');
        const client = await individualClient(colleague.email);

        expect((await as(token).post(`/clients/${client.id}/portal-access`)).status).toBe(409);
      });

      it('a client the person cannot see, as if it did not exist', async () => {
        const client = await individualClient(uniqueEmail());
        const outsider = await signedIn(await staffWith('fee_earner'));

        expect((await as(outsider).post(`/clients/${client.id}/portal-access`)).status).toBe(404);
        expect((await as(outsider).get(`/clients/${client.id}/portal-access`)).status).toBe(404);
      });

      it('a role that does not invite clients to the portal', async () => {
        const client = await individualClient(uniqueEmail());
        const accounts = await signedIn(await staffWith('accounts'));

        expect((await as(accounts).post(`/clients/${client.id}/portal-access`)).status).toBe(403);
      });
    });
  });

  describe('DELETE /clients/:id/portal-access/:linkId', () => {
    it('ends access at once and records it; access can then be given again', async () => {
      const client = await individualClient(uniqueEmail());
      const granted = await as(token).post(`/clients/${client.id}/portal-access`);

      expect((await as(token).delete(`/clients/${client.id}/portal-access/${granted.body.id}`)).status).toBe(204);

      expect((await as(token).get(`/clients/${client.id}/portal-access`)).body.people).toEqual([]);
      expect((await as(token).delete(`/clients/${client.id}/portal-access/${granted.body.id}`)).status).toBe(404);
      expect(await auditOf(client.id, 'portal.access_ended')).toEqual([
        { actor_id: feeEarner.id, metadata: { linkId: granted.body.id, accountId: granted.body.accountId } },
      ]);
      expect((await as(token).post(`/clients/${client.id}/portal-access`)).status).toBe(201);
    });

    it("answers 404 for a link of another client, and to someone who cannot see the client", async () => {
      const client = await individualClient(uniqueEmail());
      const other = await individualClient(uniqueEmail());
      const granted = await as(token).post(`/clients/${client.id}/portal-access`);
      const outsider = await signedIn(await staffWith('fee_earner'));

      expect((await as(token).delete(`/clients/${other.id}/portal-access/${granted.body.id}`)).status).toBe(404);
      expect((await as(outsider).delete(`/clients/${client.id}/portal-access/${granted.body.id}`)).status).toBe(404);
      expect((await as(token).get(`/clients/${client.id}/portal-access`)).body.people).toHaveLength(1);
    });
  });
});
