import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearMatterForTests } from '../../test/aml.js';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { PortalModule } from './portal.module.js';
import { PortalRepository } from './portal.repository.js';

@Module({ imports: [DocumentsModule, PortalModule] })
class ClientPortalModule {}

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'ascii');
const FINAL_PDF = Buffer.from('%PDF-1.7\n% final version\n%%EOF\n', 'ascii');

describe('Client portal', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let portal: PortalRepository;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let staffToken: string;
  let person: TestAccount;
  let clientToken: string;
  let clientId: string;
  let linkId: string;
  let matter: { id: string; reference: string; status: string };

  const uniqueName = () => randomUUID().replaceAll('-', '').slice(0, 16);
  const cookie = (token: string) => `__Host-session=${token}`;
  const signedIn = (account: TestAccount) => sessions.start(account, 'authenticated', {});

  async function staffWith(...roles: StaffRole[]): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) {
      await grantTestRole(db, account.id, role);
    }
    return account;
  }

  async function individual(email: string, familyName = uniqueName()): Promise<string> {
    return db.transaction().execute(async (trx) => {
      const client = await trx.insertInto('clients').values({ kind: 'individual', created_by: feeEarner.id }).returning('id').executeTakeFirstOrThrow();
      await trx
        .insertInto('client_individuals')
        .values({ client_id: client.id, given_names: 'Test', family_name: familyName, email })
        .execute();
      return client.id;
    });
  }

  async function organisation(email: string): Promise<{ clientId: string; contactId: string }> {
    return db.transaction().execute(async (trx) => {
      const client = await trx.insertInto('clients').values({ kind: 'organisation', created_by: feeEarner.id }).returning('id').executeTakeFirstOrThrow();
      await trx
        .insertInto('client_organisations')
        .values({ client_id: client.id, legal_name: uniqueName(), organisation_type: 'company' })
        .execute();
      const contact = await trx
        .insertInto('client_contacts')
        .values({ client_id: client.id, given_names: 'Client', family_name: 'Contact', email })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { clientId: client.id, contactId: contact.id };
    });
  }

  const link = (forClient: string, contactId: string | null = null, account = person) =>
    db
      .insertInto('portal_links')
      .values({ account_id: account.id, client_id: forClient, contact_id: contactId, linked_by: feeEarner.id })
      .returning('id')
      .executeTakeFirstOrThrow();

  async function openMatter(forClient: string, options: { close?: boolean; conflictWith?: string } = {}) {
    return db.transaction().execute(async (trx) => {
      const check = await trx
        .insertInto('conflict_checks')
        .values({ client_id: forClient, requested_by: feeEarner.id, names: [options.conflictWith ?? uniqueName()] })
        .returning('id')
        .executeTakeFirstOrThrow();
      const created = await trx
        .insertInto('matters')
        .values({
          client_id: forClient,
          title: `Matter ${uniqueName()}`,
          matter_type: 'litigation',
          opened_by: feeEarner.id,
          conflict_check_id: check.id,
        })
        .returning(['id', 'reference', 'status'])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('matter_team')
        .values({ matter_id: created.id, account_id: partner.id, role: 'supervising_partner', added_by: feeEarner.id })
        .execute();
      await trx
        .insertInto('matter_team')
        .values({ matter_id: created.id, account_id: feeEarner.id, role: 'fee_earner', added_by: feeEarner.id })
        .execute();
      if (options.close) {
        await trx.insertInto('matter_closures').values({ matter_id: created.id, closed_by: partner.id, reason: 'The work is complete' }).execute();
      }
      return { ...created, status: options.close ? 'closed' : created.status };
    }).then(async (matter) => {
      // A closed matter cannot be assessed, and needs no clearance for what the tests do with it.
      if (!options.close) await clearMatterForTests(db, matter.id);
      return matter;
    });
  }

  const addDocument = (matterId: string, title: string, file = PDF, fileName = 'advice.pdf') =>
    request(app.getHttpServer())
      .post(`/matters/${matterId}/documents`)
      .set('Cookie', cookie(staffToken))
      .field('title', title)
      .field('category', 'correspondence')
      .attach('file', file, fileName);

  const addVersion = (documentId: string, file = FINAL_PDF, fileName = 'advice-final.pdf') =>
    request(app.getHttpServer()).post(`/documents/${documentId}/versions`).set('Cookie', cookie(staffToken)).attach('file', file, fileName);

  const share = (documentId: string) =>
    request(app.getHttpServer()).put(`/documents/${documentId}/client-sharing`).set('Cookie', cookie(staffToken));

  const portalGet = (path: string, token = clientToken) => request(app.getHttpServer()).get(path).set('Cookie', cookie(token));

  const download = (documentId: string, token = clientToken) =>
    portalGet(`/portal/documents/${documentId}/content`, token)
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => done(null, Buffer.concat(chunks)));
      });

  beforeAll(async () => {
    app = await createTestApp(ClientPortalModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
    portal = app.get(PortalRepository);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    partner = await staffWith('partner');
    feeEarner = await staffWith('fee_earner');
    staffToken = await signedIn(feeEarner);
    person = await createTestAccount(db, 'client');
    clientToken = await signedIn(person);
    clientId = await individual(person.email);
    linkId = (await link(clientId)).id;
    matter = await openMatter(clientId);
  });

  describe('matters', () => {
    it('lists open and closed matters of every linked client, but not one awaiting conflict clearance', async () => {
      const closed = await openMatter(clientId, { close: true });
      const secondClient = await individual(person.email);
      await link(secondClient);
      const second = await openMatter(secondClient);
      const conflictName = uniqueName();
      await individual(`${uniqueName()}@example.com`, conflictName);
      const awaiting = await openMatter(clientId, { conflictWith: `Test ${conflictName}` });
      expect(awaiting.status).toBe('awaiting_clearance');

      const response = await portalGet('/portal/matters');

      expect(response.status).toBe(200);
      expect(response.body.next).toBeNull();
      expect(response.body.matters).toHaveLength(3);
      expect(response.body.matters.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining([matter.id, closed.id, second.id]));
      expect(response.body.matters.map((row: { id: string }) => row.id)).not.toContain(awaiting.id);
      expect(response.body.matters[0]).toEqual({
        id: expect.any(String),
        reference: expect.any(String),
        title: expect.any(String),
        matterType: 'litigation',
        status: expect.stringMatching(/^(open|closed)$/),
        openedAt: expect.any(String),
        team: expect.arrayContaining([
          { displayName: 'Test staff', role: 'supervising_partner' },
          { displayName: 'Test staff', role: 'fee_earner' },
        ]),
      });
    });

    it('shows only the client-safe matter fields, never parties, conflict data, client records or account ids', async () => {
      const check = await db
        .selectFrom('matters')
        .innerJoin('conflict_checks', 'conflict_checks.id', 'matters.conflict_check_id')
        .select('conflict_checks.names')
        .where('matters.id', '=', matter.id)
        .executeTakeFirstOrThrow();
      const secret = check.names.at(-1) as string;
      await db
        .insertInto('matter_parties')
        .values({ matter_id: matter.id, role: 'opponent', kind: 'individual', name: secret, added_by: feeEarner.id })
        .execute();

      const response = await portalGet(`/portal/matters/${matter.id}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        id: matter.id,
        reference: matter.reference,
        title: expect.any(String),
        matterType: 'litigation',
        status: 'open',
        openedAt: expect.any(String),
        team: expect.arrayContaining([
          { displayName: 'Test staff', role: 'supervising_partner' },
          { displayName: 'Test staff', role: 'fee_earner' },
        ]),
      });
      expect(JSON.stringify(response.body)).not.toContain(secret);
      expect(JSON.stringify(response.body)).not.toContain(clientId);
      expect(JSON.stringify(response.body)).not.toContain(feeEarner.id);
    });

    it('is client-only, validates ids and page markers, and hides another client account’s matter', async () => {
      const staff = await signedIn(partner);
      const outsider = await signedIn(await createTestAccount(db, 'client'));

      expect((await portalGet('/portal/matters', staff)).status).toBe(403);
      expect((await request(app.getHttpServer()).get('/portal/matters')).status).toBe(401);
      expect((await portalGet('/portal/matters?before=not-an-id')).status).toBe(400);
      expect((await portalGet('/portal/matters/not-an-id')).status).toBe(400);
      expect((await portalGet(`/portal/matters/${matter.id}`, outsider)).status).toBe(404);
      expect((await portalGet(`/portal/matters/${matter.id}/documents?before=not-an-id`)).status).toBe(400);
      expect((await portalGet(`/portal/matters/${matter.id}/documents`, outsider)).status).toBe(404);
      expect((await portalGet('/portal/documents/not-an-id/content')).status).toBe(400);
    });
  });

  describe('shared documents', () => {
    it('lists only shared, unwithdrawn documents, and only the latest version', async () => {
      await addDocument(matter.id, 'Internal note', PDF, 'internal.pdf').expect(201);
      const shared = await addDocument(matter.id, 'Advice', PDF, 'advice-draft.pdf');
      await share(shared.body.id).expect(204);
      await addVersion(shared.body.id).expect(201);
      const withdrawn = await addDocument(matter.id, 'Wrong document', PDF, 'wrong.pdf');
      await share(withdrawn.body.id).expect(204);
      await request(app.getHttpServer())
        .post(`/documents/${withdrawn.body.id}/withdrawal`)
        .set('Cookie', cookie(staffToken))
        .send({ reason: 'Uploaded to the wrong matter by mistake' })
        .expect(204);

      const response = await portalGet(`/portal/matters/${matter.id}/documents`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        documents: [
          {
            id: shared.body.id,
            title: 'Advice',
            category: 'correspondence',
            createdAt: expect.any(String),
            latest: {
              fileName: 'advice-final.pdf',
              mediaType: 'application/pdf',
              sizeBytes: FINAL_PDF.length,
              uploadedAt: expect.any(String),
            },
          },
        ],
        next: null,
      });
      expect(JSON.stringify(response.body)).not.toContain('advice-draft.pdf');
      expect(JSON.stringify(response.body)).not.toContain('Internal note');
      expect(JSON.stringify(response.body)).not.toContain('Wrong document');
    });

    it('downloads exactly the latest version as an attachment and records the client actor', async () => {
      const document = await addDocument(matter.id, 'Advice', PDF, 'advice-draft.pdf');
      await addVersion(document.body.id).expect(201);
      await share(document.body.id).expect(204);

      const response = await download(document.body.id);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(FINAL_PDF);
      expect(response.headers).toMatchObject({
        'content-type': 'application/pdf',
        'content-length': String(FINAL_PDF.length),
        'content-disposition': 'attachment; filename="advice-final.pdf"; filename*=UTF-8\'\'advice-final.pdf',
        'content-security-policy': "default-src 'none'; sandbox",
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      });
      const event = await db
        .selectFrom('audit_events')
        .select(['actor_type', 'actor_id', 'action', 'metadata'])
        .where('resource_id', '=', document.body.id)
        .where('action', '=', 'document.downloaded')
        .where('actor_id', '=', person.id)
        .executeTakeFirstOrThrow();
      expect(event).toEqual({ actor_type: 'client', actor_id: person.id, action: 'document.downloaded', metadata: { matterId: matter.id, version: 2 } });
    });

    it('never exposes an unshared document, an older version, or a document of another client', async () => {
      const unshared = await addDocument(matter.id, 'Internal', PDF, 'internal.pdf');
      const otherPerson = await createTestAccount(db, 'client');
      const otherClient = await individual(otherPerson.email);
      await link(otherClient, null, otherPerson);
      const otherMatter = await openMatter(otherClient);
      const otherDocument = await addDocument(otherMatter.id, 'Other client', PDF, 'other.pdf');
      await share(otherDocument.body.id).expect(204);
      const otherToken = await signedIn(otherPerson);

      expect((await download(unshared.body.id)).status).toBe(404);
      expect((await download(otherDocument.body.id, otherToken)).status).toBe(200);
      expect((await download(otherDocument.body.id)).status).toBe(404);
      expect((await portalGet(`/documents/${otherDocument.body.id}/versions/1/content`)).status).toBe(403);
      const downloads = await db
        .selectFrom('audit_events')
        .select('id')
        .where('actor_id', '=', person.id)
        .where('action', '=', 'document.downloaded')
        .where('resource_id', 'in', [unshared.body.id, otherDocument.body.id])
        .execute();
      expect(downloads).toEqual([]);
    });

    it('keeps shared documents available on a closed matter', async () => {
      const document = await addDocument(matter.id, 'Final advice');
      await share(document.body.id).expect(204);
      await db.insertInto('matter_closures').values({ matter_id: matter.id, closed_by: partner.id, reason: 'The work is complete' }).execute();

      const listed = await portalGet(`/portal/matters/${matter.id}/documents`);

      expect(listed.status).toBe(200);
      expect(listed.body.documents.map((row: { id: string }) => row.id)).toContain(document.body.id);
      expect((await download(document.body.id)).status).toBe(200);
    });
  });

  describe('access is checked again on every request', () => {
    it('loses every route as soon as the portal link ends', async () => {
      const document = await addDocument(matter.id, 'Advice');
      await share(document.body.id).expect(204);
      await db.updateTable('portal_links').set({ ended_at: new Date(), ended_by: feeEarner.id }).where('id', '=', linkId).execute();

      expect((await portalGet('/portal/matters')).body).toEqual({ matters: [], next: null });
      expect((await portalGet(`/portal/matters/${matter.id}`)).status).toBe(404);
      expect((await portalGet(`/portal/matters/${matter.id}/documents`)).status).toBe(404);
      expect((await download(document.body.id)).status).toBe(404);
    });

    it('loses an organisation’s matters and documents as soon as the contact is no longer current', async () => {
      const organisationClient = await organisation(person.email);
      await link(organisationClient.clientId, organisationClient.contactId);
      const organisationMatter = await openMatter(organisationClient.clientId);
      const document = await addDocument(organisationMatter.id, 'Company advice');
      expect(document.status, JSON.stringify(document.body)).toBe(201);
      await share(document.body.id).expect(204);
      await db.updateTable('client_contacts').set({ active: false }).where('id', '=', organisationClient.contactId).execute();

      expect((await portalGet(`/portal/matters/${organisationMatter.id}`)).status).toBe(404);
      expect((await portalGet(`/portal/matters/${organisationMatter.id}/documents`)).status).toBe(404);
      expect((await download(document.body.id)).status).toBe(404);
      expect((await portalGet('/portal/matters')).body.matters.map((row: { id: string }) => row.id)).not.toContain(organisationMatter.id);
    });

    it('loses an individual client as soon as the address on their record changes', async () => {
      const document = await addDocument(matter.id, 'Advice');
      await share(document.body.id).expect(204);
      await db.updateTable('client_individuals').set({ email: `${uniqueName()}@example.com` }).where('client_id', '=', clientId).execute();

      expect((await portalGet(`/portal/matters/${matter.id}`)).status).toBe(404);
      expect((await portalGet(`/portal/matters/${matter.id}/documents`)).status).toBe(404);
      expect((await download(document.body.id)).status).toBe(404);
      expect((await portalGet('/portal/matters')).body.matters.map((row: { id: string }) => row.id)).not.toContain(matter.id);
    });

    it('loses an organisation as soon as the address on its contact record changes', async () => {
      const organisationClient = await organisation(person.email);
      await link(organisationClient.clientId, organisationClient.contactId);
      const organisationMatter = await openMatter(organisationClient.clientId);
      const document = await addDocument(organisationMatter.id, 'Company advice');
      await share(document.body.id).expect(204);
      await db
        .updateTable('client_contacts')
        .set({ email: `${uniqueName()}@example.com` })
        .where('id', '=', organisationClient.contactId)
        .execute();

      expect((await portalGet(`/portal/matters/${organisationMatter.id}`)).status).toBe(404);
      expect((await portalGet(`/portal/matters/${organisationMatter.id}/documents`)).status).toBe(404);
      expect((await download(document.body.id)).status).toBe(404);
      expect((await portalGet('/portal/matters')).body.matters.map((row: { id: string }) => row.id)).not.toContain(organisationMatter.id);
    });

    it('loses the session on the next request when the client account is disabled', async () => {
      await db.updateTable('accounts').set({ status: 'disabled' }).where('id', '=', person.id).execute();

      expect((await portalGet('/portal/matters')).status).toBe(401);
      expect(await portal.clientMatters(person.id, { limit: 50 })).toEqual([]);
    });

    it('loses a document as soon as staff stop sharing it', async () => {
      const document = await addDocument(matter.id, 'Advice');
      await share(document.body.id).expect(204);
      expect((await download(document.body.id)).status).toBe(200);

      await request(app.getHttpServer())
        .delete(`/documents/${document.body.id}/client-sharing`)
        .set('Cookie', cookie(staffToken))
        .expect(204);

      expect((await portalGet(`/portal/matters/${matter.id}/documents`)).body.documents).toEqual([]);
      expect((await download(document.body.id)).status).toBe(404);
    });
  });
});
