import { randomBytes, randomUUID } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { eicarTestFile } from '../../test/eicar.js';
import { waitForEmailWithSubject } from '../../test/mailpit.js';
import { officeFile } from '../../test/zip.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { ClientsModule } from '../clients/clients.module.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { MailOutbox } from '../mail/mail-outbox.js';
import { MattersModule } from '../matters/matters.module.js';
import { DocumentVault } from './document-vault.js';
import { DocumentsModule } from './documents.module.js';
import { MAX_DOCUMENT_BYTES } from './file-inspection.js';
import { ObjectStorage } from './object-storage.js';

@Module({ imports: [ClientsModule, MattersModule, DocumentsModule] })
class ClientsMattersDocumentsModule {}

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'ascii');

describe('Documents', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let feeEarner: TestAccount;
  let token: string;
  let partner: TestAccount;
  let matterId: string;

  const uniqueName = () => randomUUID().replaceAll('-', '').slice(0, 16);
  const cookie = (sessionToken: string) => `__Host-session=${sessionToken}`;
  const signedIn = (account: TestAccount) => sessions.start(account, 'authenticated', {});

  async function staffWith(...roles: StaffRole[]): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) {
      await grantTestRole(db, account.id, role);
    }
    return account;
  }

  /** A client and a matter for it, opened by the fee earner; awaiting clearance if `otherParty` matches a client. */
  async function openMatter(sessionToken: string, otherParty = uniqueName()): Promise<{ id: string; status: string; reference: string }> {
    const server = request(app.getHttpServer());
    const client = await server.post('/clients').set('Cookie', cookie(sessionToken)).send({ kind: 'individual', givenNames: uniqueName(), familyName: uniqueName() });
    const check = await server.post('/conflict-checks').set('Cookie', cookie(sessionToken)).send({ clientId: client.body.id, names: [otherParty] });
    const opened = await server
      .post('/matters')
      .set('Cookie', cookie(sessionToken))
      .send({
        clientId: client.body.id,
        title: 'Lease renewal',
        matterType: 'commercial_property',
        supervisingPartnerId: partner.id,
        conflictCheckId: check.body.id,
        parties: [{ role: 'opponent', kind: 'individual', name: otherParty }],
      });
    return opened.body;
  }

  const upload = (sessionToken: string, file: Buffer, fileName: string, fields: Record<string, string> = { title: 'Signed lease', category: 'contract' }, matter = matterId) => {
    let sending = request(app.getHttpServer()).post(`/matters/${matter}/documents`).set('Cookie', cookie(sessionToken));
    for (const [name, value] of Object.entries(fields)) {
      sending = sending.field(name, value);
    }
    return sending.attach('file', file, fileName);
  };

  /** Every object that reached storage, and every one removed again, while `work` runs. */
  async function storageDuring(work: () => Promise<unknown>) {
    const storage = app.get(ObjectStorage);
    const [put, remove] = [storage.put.bind(storage), storage.remove.bind(storage)];
    const stored: string[] = [];
    const removed: string[] = [];
    const putSpy = vi.spyOn(storage, 'put').mockImplementation(async (key, body, abort) => {
      await put(key, body, abort);
      stored.push(key);
    });
    const removeSpy = vi.spyOn(storage, 'remove').mockImplementation(async (key) => {
      await remove(key);
      removed.push(key);
    });
    try {
      await work();
    } finally {
      putSpy.mockRestore();
      removeSpy.mockRestore();
    }
    return { stored, removed };
  }

  const documentsOf = (matter: string) => db.selectFrom('documents').select('id').where('matter_id', '=', matter).execute();
  const refusalsFor = (matter: string) =>
    db.selectFrom('audit_events').select(['action', 'outcome', 'metadata']).where('resource_id', '=', matter).where('action', '=', 'document.refused').execute();

  beforeAll(async () => {
    app = await createTestApp(ClientsMattersDocumentsModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    feeEarner = await staffWith('fee_earner');
    token = await signedIn(feeEarner);
    partner = await staffWith('partner');
    matterId = (await openMatter(token)).id;
  });

  describe('POST /matters/:id/documents', () => {
    it('stores the file encrypted and records it as version 1', async () => {
      const added = await upload(token, PDF, 'lease.pdf');

      expect(added.status).toBe(201);
      expect(added.body).toEqual({
        id: expect.any(String),
        title: 'Signed lease',
        category: 'contract',
        createdAt: expect.any(String),
        version: { number: 1, fileName: 'lease.pdf', mediaType: 'application/pdf', sizeBytes: PDF.length, uploadedAt: expect.any(String) },
      });

      const version = await db.selectFrom('document_versions').selectAll().where('document_id', '=', added.body.id).executeTakeFirstOrThrow();
      const raw = await buffer(await app.get(ObjectStorage).get(version.storage_key));
      expect(raw.includes(Buffer.from('%PDF'))).toBe(false);
      const opened = await app.get(DocumentVault).open({
        storageKey: version.storage_key,
        sealedKey: { keyVersion: version.key_version, nonce: version.key_nonce, ciphertext: version.wrapped_key, authTag: version.key_tag },
      });
      expect(await buffer(opened)).toEqual(PDF);
    });

    it('records the addition by ids, type and size: never the title or the file name', async () => {
      const added = await upload(token, PDF, 'Divorce settlement - Smith.pdf');

      const event = await db.selectFrom('audit_events').select(['actor_id', 'action', 'metadata']).where('resource_id', '=', added.body.id).executeTakeFirstOrThrow();
      expect(event).toEqual({
        actor_id: feeEarner.id,
        action: 'document.added',
        metadata: { matterId, version: 1, mediaType: 'application/pdf', sizeBytes: PDF.length },
      });
    });

    it('keeps only the name of a file sent with its folders', async () => {
      const added = await upload(token, PDF, 'C:\\Users\\jane\\Documents\\lease.pdf');

      expect(added.body.version.fileName).toBe('lease.pdf');
    });

    describe('refuses, stores nothing, and records why', () => {
      it.each([
        ['a web page named .pdf', '<html><script>alert(1)</script></html>', 'lease.pdf', 415, 'type'],
        ['a kind of file not accepted', '<svg/>', 'logo.svg', 415, 'type'],
        ['an Office file with macros', officeFile('word/document.xml', { 'word/vbaProject.bin': randomBytes(50) }), 'letter.docx', 415, 'macros'],
        ['an empty file', '', 'note.txt', 400, 'empty'],
        ['a file name over 255 characters', 'Hello', `${'a'.repeat(252)}.txt`, 400, 'file_name'],
      ])('%s', async (_case, content, fileName, status, reason) => {
        let response: request.Response | undefined;
        const { stored, removed } = await storageDuring(async () => {
          response = await upload(token, Buffer.isBuffer(content) ? content : Buffer.from(content), fileName);
        });

        expect(response?.status).toBe(status);
        expect(response?.body.message).toBeDefined();
        expect(response?.headers['connection']).toBe('close');
        expect(await documentsOf(matterId)).toEqual([]);
        expect(await refusalsFor(matterId)).toEqual([{ action: 'document.refused', outcome: 'failure', metadata: { reason } }]);
        // Anything that reached storage before the refusal was removed again.
        expect(removed.sort()).toEqual(stored.sort());
      });

      it('a file name with a control character, refused with the form', async () => {
        const response = await upload(token, Buffer.from('Hello'), `note${String.fromCharCode(7)}.txt`);

        expect(response.status).toBe(400);
        expect(await documentsOf(matterId)).toEqual([]);
      });

      it('a file over 50 MB', async () => {
        const response = await upload(token, Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x61), 'note.txt');

        expect(response.status).toBe(413);
        expect(await documentsOf(matterId)).toEqual([]);
      });

      it('malware, and tells compliance by matter reference only', async () => {
        const compliance = await staffWith('compliance');
        const matter = await openMatter(token);

        let response: request.Response | undefined;
        const { stored, removed } = await storageDuring(async () => {
          response = await upload(token, eicarTestFile(), 'invoice.txt', undefined, matter.id);
        });
        await app.get(MailOutbox).drain();

        expect(response?.status).toBe(422);
        // The scanner answers last, so the file was stored first; it is removed again.
        expect(stored).toHaveLength(1);
        expect(removed).toEqual(stored);
        expect(await documentsOf(matter.id)).toEqual([]);
        expect(await refusalsFor(matter.id)).toEqual([
          { action: 'document.refused', outcome: 'failure', metadata: { reason: 'malware', signature: 'Eicar-Test-Signature' } },
        ]);
        // Other tests grant roles that also email every compliance holder: look for this one.
        const email = await waitForEmailWithSubject(compliance.email, `Malware refused on ${matter.reference}`);
        expect(email).toBeDefined();
        expect(email?.text).not.toContain('invoice.txt');
      });
    });

    it('refuses everything when the scanner cannot be reached: nothing unscanned is stored', async () => {
      const blind = await createTestApp(ClientsMattersDocumentsModule, { env: { CLAMAV_PORT: 3109 } });
      try {
        const response = await request(blind.getHttpServer())
          .post(`/matters/${matterId}/documents`)
          .set('Cookie', cookie(token))
          .field('title', 'Signed lease')
          .field('category', 'contract')
          .attach('file', PDF, 'lease.pdf');

        expect(response.status).toBe(503);
        expect(await documentsOf(matterId)).toEqual([]);
      } finally {
        await blind.close();
      }
    });

    describe('only to open matters the person works on', () => {
      it('answers 404 to someone not on the team, as if the matter did not exist', async () => {
        const outsider = await staffWith('fee_earner');

        expect((await upload(await signedIn(outsider), PDF, 'lease.pdf')).status).toBe(404);
        expect((await upload(token, PDF, 'lease.pdf', undefined, randomUUID())).status).toBe(404);
      });

      it('refuses a matter awaiting conflict clearance', async () => {
        const existing = uniqueName();
        const server = request(app.getHttpServer());
        await server.post('/clients').set('Cookie', cookie(token)).send({ kind: 'individual', givenNames: 'Robin', familyName: existing });
        const awaiting = await openMatter(token, `Robin ${existing}`);

        expect(awaiting.status).toBe('awaiting_clearance');
        expect((await upload(token, PDF, 'lease.pdf', undefined, awaiting.id)).status).toBe(409);
      });

      it('refuses someone whose role does not add documents', async () => {
        const accounts = await staffWith('accounts');

        expect((await upload(await signedIn(accounts), PDF, 'lease.pdf')).status).toBe(403);
      });

      it('refuses without a session', async () => {
        const response = await request(app.getHttpServer()).post(`/matters/${matterId}/documents`).attach('file', PDF, 'lease.pdf');

        expect(response.status).toBe(401);
      });
    });

    describe('refuses a form that is not as expected', () => {
      it.each([
        ['no title', { category: 'contract' }],
        ['an unknown category', { title: 'Lease', category: 'secret' }],
        ['an extra field', { title: 'Lease', category: 'contract', owner: 'someone' }],
        ['a title of control characters', { title: String.fromCharCode(10, 9), category: 'contract' }],
      ])('%s', async (_case, fields) => {
        expect((await upload(token, PDF, 'lease.pdf', fields)).status).toBe(400);
        expect(await documentsOf(matterId)).toEqual([]);
      });

      it('the file before the other fields', async () => {
        // Built by hand: the test client always sends fields first, whatever order they are given in.
        const boundary = `boundary${uniqueName()}`;
        const part = (disposition: string, content: Buffer | string) =>
          Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; ${disposition}\r\n\r\n`), Buffer.from(content), Buffer.from('\r\n')]);
        const body = Buffer.concat([
          part('name="file"; filename="lease.pdf"', PDF),
          part('name="title"', 'Signed lease'),
          part('name="category"', 'contract'),
          Buffer.from(`--${boundary}--\r\n`),
        ]);

        const response = await request(app.getHttpServer())
          .post(`/matters/${matterId}/documents`)
          .set('Cookie', cookie(token))
          .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
          .send(body);

        expect(response.status).toBe(400);
        expect(await documentsOf(matterId)).toEqual([]);
      });

      it('two files', async () => {
        const response = await upload(token, PDF, 'lease.pdf').attach('file', PDF, 'second.pdf');

        expect(response.status).toBe(400);
        expect(await documentsOf(matterId)).toEqual([]);
      });

      it('no file, or not a multipart form', async () => {
        const server = request(app.getHttpServer());
        const noFile = await server.post(`/matters/${matterId}/documents`).set('Cookie', cookie(token)).field('title', 'Lease').field('category', 'contract');
        const json = await server.post(`/matters/${matterId}/documents`).set('Cookie', cookie(token)).send({ title: 'Lease', category: 'contract' });

        expect(noFile.status).toBe(400);
        expect(json.status).toBe(400);
      });
    });
  });
});
