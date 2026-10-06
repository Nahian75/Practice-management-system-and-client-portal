import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { testAppDatabaseUrl } from '../../test/database.js';
import { eicarTestFile } from '../../test/eicar.js';
import { waitForEmailWithSubject } from '../../test/mailpit.js';
import { officeFile, relationships, withDeclaredSizes } from '../../test/zip.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { ClientsModule } from '../clients/clients.module.js';
import { createDatabase } from '../database/database.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { MailOutbox } from '../mail/mail-outbox.js';
import { MattersModule } from '../matters/matters.module.js';
import { DocumentVault } from './document-vault.js';
import { DocumentsModule } from './documents.module.js';
import { UPLOAD_BYTES_PER_HOUR, UPLOAD_WINDOW_SECONDS, UPLOADS_PER_HOUR } from './documents.service.js';
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
        [
          'an Office file with a remote template (review D1)',
          officeFile('word/document.xml', {
            'word/_rels/settings.xml.rels': relationships({ type: 'attachedTemplate', target: 'https://attacker.example/t.dotm', external: true }),
          }),
          'letter.docx',
          415,
          'active_content',
        ],
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

      it('a file the virus scanner could not fully check, recorded but not reported as malware (review D3)', async () => {
        // Declares 1,000 bytes per part, so it passes the inspection; ClamAV counts the 450 MB it really unpacks to.
        const zeros = Buffer.alloc(90 * 1024 * 1024);
        const parts = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`word/media/part${index}.bin`, zeros]));
        const understated = withDeclaredSizes(officeFile('word/document.xml', parts, { deflate: true }), 1000);
        let response: request.Response | undefined;
        const { stored, removed } = await storageDuring(async () => {
          response = await upload(token, understated, 'letter.docx');
        });

        expect(response?.status).toBe(422);
        expect(response?.body.message).toContain('could not be fully checked for viruses');
        expect(removed).toEqual(stored);
        expect(await documentsOf(matterId)).toEqual([]);
        expect(await refusalsFor(matterId)).toEqual([
          { action: 'document.refused', outcome: 'failure', metadata: { reason: 'unscannable', signature: 'Heuristics.Limits.Exceeded.MaxScanSize' } },
        ]);
      }, 60_000);

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

describe('hourly upload allowance (review D4)', () => {
    /** Records that `account` added `files` documents this hour, of `sizeBytes` each, as uploads would. */
    async function alreadyAdded(account: TestAccount, files: number, sizeBytes = 1000) {
      const audit = app.get(AuditService);
      for (let index = 0; index < files; index++) {
        await audit.record({
          actor: { type: 'user', id: account.id },
          action: 'document.added',
          outcome: 'success',
          resource: { type: 'document', id: randomUUID() },
          metadata: { matterId, version: 1, mediaType: 'application/pdf', sizeBytes },
        });
      }
    }
    const limitedRecords = (account: TestAccount) =>
      db.selectFrom('audit_events').select('id').where('actor_id', '=', account.id).where('action', '=', 'document.upload_limited').execute();

    it('refuses the 201st file in an hour before reading it, records the limit once, and tells the administrators', async () => {
      const administrator = await staffWith('administrator');
      await alreadyAdded(feeEarner, UPLOADS_PER_HOUR);

      let first: request.Response | undefined;
      const { stored } = await storageDuring(async () => {
        first = await upload(token, PDF, 'lease.pdf');
      });
      const second = await upload(token, PDF, 'lease.pdf');
      await app.get(MailOutbox).drain();

      expect(first?.status).toBe(429);
      expect(first?.headers['retry-after']).toBe(String(UPLOAD_WINDOW_SECONDS));
      expect(first?.body.message).toContain('most documents allowed in an hour');
      expect(stored).toEqual([]);
      expect(second.status).toBe(429);
      expect(await limitedRecords(feeEarner)).toHaveLength(1);
      expect(await documentsOf(matterId)).toEqual([]);
      expect(await waitForEmailWithSubject(administrator.email, 'Document upload limit reached')).toBeDefined();
    });

    it('refuses a file that would take the hour past 2 GB, removing what was stored', async () => {
      await alreadyAdded(feeEarner, 1, UPLOAD_BYTES_PER_HOUR - 10);

      let response: request.Response | undefined;
      const { stored, removed } = await storageDuring(async () => {
        response = await upload(token, PDF, 'lease.pdf');
      });

      expect(response?.status).toBe(429);
      expect(stored).toHaveLength(1);
      expect(removed).toEqual(stored);
      expect(await documentsOf(matterId)).toEqual([]);
    });

    /*
     * Holding the person's upload lock from another connection makes the race
     * happen every time: both uploads pass the check made before reading, are
     * stored, then queue on the lock, and are counted one after the other once
     * it is released.
     */
    it('lets exactly one of two uploads at once take the last place', async () => {
      await alreadyAdded(feeEarner, UPLOADS_PER_HOUR - 1);
      const holder = createDatabase<Database>(testAppDatabaseUrl(), 1);
      try {
        const lockKey = sql`hashtextextended(${`app.document_uploads:${feeEarner.id}`}, 0)`;
        await sql`select pg_advisory_lock(${lockKey})`.execute(holder);

        const first = upload(token, PDF, 'one.pdf').then((response) => response.status);
        const second = upload(token, PDF, 'two.pdf').then((response) => response.status);
        // Waiting on this person's upload lock only: other tests use advisory locks at the same time.
        await expect
          .poll(
            async () => {
              const { rows } = await sql<{ waiting: string }>`
                select count(*) as waiting from pg_locks
                where locktype = 'advisory' and not granted
                  and ((classid::bigint << 32) | objid::bigint) = ${lockKey}`.execute(holder);
              return Number(rows[0]?.waiting);
            },
            { timeout: 20_000 },
          )
          .toBe(2);
        await sql`select pg_advisory_unlock(${lockKey})`.execute(holder);

        expect([await first, await second].sort()).toEqual([201, 429]);
        expect(await documentsOf(matterId)).toHaveLength(1);
      } finally {
        await holder.destroy();
      }
    }, 30_000);

    it("counts each person's uploads separately", async () => {
      await alreadyAdded(feeEarner, UPLOADS_PER_HOUR);

      expect((await upload(await signedIn(partner), PDF, 'lease.pdf')).status).toBe(201);
    });
  });

  describe('GET /matters/:id/documents', () => {
    it('lists the documents, newest first, with their latest version', async () => {
      const first = await upload(token, PDF, 'lease.pdf');
      const second = await upload(token, Buffer.from('Call note'), 'note.txt', { title: 'Call with client', category: 'correspondence' });

      const listed = await request(app.getHttpServer()).get(`/matters/${matterId}/documents`).set('Cookie', cookie(token));

      expect(listed.status).toBe(200);
      expect(listed.body).toEqual({
        documents: [
          {
            id: second.body.id,
            title: 'Call with client',
            category: 'correspondence',
            createdAt: expect.any(String),
            latest: { number: 1, fileName: 'note.txt', mediaType: 'text/plain', sizeBytes: 9, uploadedAt: expect.any(String) },
          },
          expect.objectContaining({ id: first.body.id, title: 'Signed lease' }),
        ],
        next: null,
      });
    });

    it('answers 404 to someone not on the team, as for a matter that does not exist', async () => {
      const outsider = await signedIn(await staffWith('fee_earner'));
      const server = request(app.getHttpServer());

      expect((await server.get(`/matters/${matterId}/documents`).set('Cookie', cookie(outsider))).status).toBe(404);
      expect((await server.get(`/matters/${randomUUID()}/documents`).set('Cookie', cookie(token))).status).toBe(404);
    });

    it('refuses a role that does not see documents, and a page marker that is not an id', async () => {
      const server = request(app.getHttpServer());
      const accounts = await signedIn(await staffWith('accounts'));

      expect((await server.get(`/matters/${matterId}/documents`).set('Cookie', cookie(accounts))).status).toBe(403);
      expect((await server.get(`/matters/${matterId}/documents?before=x`).set('Cookie', cookie(token))).status).toBe(400);
    });
  });

  describe('GET /documents/:id', () => {
    it('shows the document and each version, with who uploaded it', async () => {
      const added = await upload(token, PDF, 'lease.pdf');

      const found = await request(app.getHttpServer()).get(`/documents/${added.body.id}`).set('Cookie', cookie(token));

      expect(found.body).toEqual({
        id: added.body.id,
        matterId,
        title: 'Signed lease',
        category: 'contract',
        createdAt: expect.any(String),
        sharedWithClient: false,
        versions: [
          {
            number: 1,
            fileName: 'lease.pdf',
            mediaType: 'application/pdf',
            sizeBytes: PDF.length,
            uploadedAt: expect.any(String),
            uploadedBy: { accountId: feeEarner.id, displayName: 'Test staff' },
          },
        ],
        withdrawal: null,
      });
    });

    it('answers 404 to someone not on the team', async () => {
      const added = await upload(token, PDF, 'lease.pdf');
      const outsider = await signedIn(await staffWith('partner'));

      expect((await request(app.getHttpServer()).get(`/documents/${added.body.id}`).set('Cookie', cookie(outsider))).status).toBe(404);
    });
  });

  describe('PUT and DELETE /documents/:id/client-sharing', () => {
    const changeSharing = (sessionToken: string, documentId: string, shared: boolean) =>
      request(app.getHttpServer())[shared ? 'put' : 'delete'](`/documents/${documentId}/client-sharing`).set('Cookie', cookie(sessionToken));

    it('shares and stops sharing, recording each change and audit event by ids only', async () => {
      const added = await upload(token, PDF, 'Client name must not reach the audit log.pdf');

      expect((await changeSharing(token, added.body.id, true)).status).toBe(204);
      expect((await request(app.getHttpServer()).get(`/documents/${added.body.id}`).set('Cookie', cookie(token))).body.sharedWithClient).toBe(true);
      expect((await changeSharing(await signedIn(partner), added.body.id, false)).status).toBe(204);

      const changes = await sql<{ shared: boolean; changed_by: string }>`select shared, changed_by from document_sharing_changes
        where document_id = ${added.body.id} order by changed_at, id`.execute(db);
      expect(changes.rows).toEqual([
        { shared: true, changed_by: feeEarner.id },
        { shared: false, changed_by: partner.id },
      ]);
      const events = await db
        .selectFrom('audit_events')
        .select(['actor_id', 'action', 'metadata'])
        .where('resource_id', '=', added.body.id)
        .where('action', 'in', ['document.shared', 'document.unshared'])
        .orderBy('occurred_at')
        .execute();
      expect(events).toEqual([
        { actor_id: feeEarner.id, action: 'document.shared', metadata: { matterId } },
        { actor_id: partner.id, action: 'document.unshared', metadata: { matterId } },
      ]);
    });

    it('is idempotent, without duplicate history or audit records', async () => {
      const added = await upload(token, PDF, 'lease.pdf');

      expect((await changeSharing(token, added.body.id, true)).status).toBe(204);
      expect((await changeSharing(token, added.body.id, true)).status).toBe(204);

      const changes = await sql<{ count: string }>`select count(*)::text as count from document_sharing_changes where document_id = ${added.body.id}`.execute(db);
      const events = await db
        .selectFrom('audit_events')
        .select('id')
        .where('resource_id', '=', added.body.id)
        .where('action', '=', 'document.shared')
        .execute();
      expect(changes.rows[0]?.count).toBe('1');
      expect(events).toHaveLength(1);
    });

    it('can share a document after its matter has closed', async () => {
      const added = await upload(token, PDF, 'lease.pdf');
      await request(app.getHttpServer())
        .post(`/matters/${matterId}/close`)
        .set('Cookie', cookie(await signedIn(partner)))
        .send({ reason: 'Lease renewed and signed' })
        .expect(204);

      expect((await changeSharing(token, added.body.id, true)).status).toBe(204);
    });

    it('answers 404 off the team, and 403 without the new permission', async () => {
      const added = await upload(token, PDF, 'lease.pdf');
      const outsider = await signedIn(await staffWith('fee_earner'));
      const accounts = await signedIn(await staffWith('accounts'));

      expect((await changeSharing(outsider, added.body.id, true)).status).toBe(404);
      expect((await changeSharing(accounts, added.body.id, true)).status).toBe(403);
    });

    it('will not share or unshare a withdrawn document', async () => {
      const added = await upload(token, PDF, 'lease.pdf');
      await request(app.getHttpServer())
        .post(`/documents/${added.body.id}/withdrawal`)
        .set('Cookie', cookie(token))
        .send({ reason: 'Uploaded to the wrong matter by mistake' })
        .expect(204);

      expect((await changeSharing(token, added.body.id, true)).status).toBe(409);
      expect((await changeSharing(token, added.body.id, false)).status).toBe(409);
    });

    it('stops sharing on withdrawal and records both events', async () => {
      const added = await upload(token, PDF, 'lease.pdf');
      await changeSharing(token, added.body.id, true).expect(204);

      await request(app.getHttpServer())
        .post(`/documents/${added.body.id}/withdrawal`)
        .set('Cookie', cookie(token))
        .send({ reason: 'Uploaded to the wrong matter by mistake' })
        .expect(204);

      const found = await request(app.getHttpServer()).get(`/documents/${added.body.id}`).set('Cookie', cookie(token));
      expect(found.body.sharedWithClient).toBe(false);
      const events = await db
        .selectFrom('audit_events')
        .select('action')
        .where('resource_id', '=', added.body.id)
        .where('action', 'in', ['document.shared', 'document.unshared', 'document.withdrawn'])
        .orderBy('occurred_at')
        .execute();
      expect(events).toEqual([{ action: 'document.shared' }, { action: 'document.unshared' }, { action: 'document.withdrawn' }]);
    });

    it('records the unshare when sharing and withdrawal happen at the same time', async () => {
      const added = await upload(token, PDF, 'lease.pdf');
      const holder = createDatabase<Database>(testAppDatabaseUrl(), 1);
      const lockKey = sql`hashtextextended(${`app.document_version:${added.body.id}`}, 0)`;
      try {
        await sql`select pg_advisory_lock(${lockKey})`.execute(holder);
        const sharing = changeSharing(token, added.body.id, true).then((response) => response.status);
        await expect
          .poll(
            async () => {
              const { rows } = await sql<{ waiting: string }>`
                select count(*) as waiting from pg_locks
                where locktype = 'advisory' and not granted
                  and ((classid::bigint << 32) | objid::bigint) = ${lockKey}`.execute(holder);
              return Number(rows[0]?.waiting);
            },
            { timeout: 20_000 },
          )
          .toBe(1);
        const withdrawal = request(app.getHttpServer())
          .post(`/documents/${added.body.id}/withdrawal`)
          .set('Cookie', cookie(token))
          .send({ reason: 'Uploaded to the wrong matter by mistake' })
          .then((response) => response.status);
        await expect
          .poll(
            async () => {
              const { rows } = await sql<{ waiting: string }>`
                select count(*) as waiting from pg_locks
                where locktype = 'advisory' and not granted
                  and ((classid::bigint << 32) | objid::bigint) = ${lockKey}`.execute(holder);
              return Number(rows[0]?.waiting);
            },
            { timeout: 20_000 },
          )
          .toBe(2);
        await sql`select pg_advisory_unlock(${lockKey})`.execute(holder);

        expect(await sharing).toBe(204);
        expect(await withdrawal).toBe(204);
        const changes = await sql<{ shared: boolean }>`select shared from document_sharing_changes
          where document_id = ${added.body.id} order by changed_at, id`.execute(db);
        expect(changes.rows).toEqual([{ shared: true }, { shared: false }]);
        const events = await db
          .selectFrom('audit_events')
          .select('action')
          .where('resource_id', '=', added.body.id)
          .where('action', 'in', ['document.shared', 'document.unshared', 'document.withdrawn'])
          .orderBy('occurred_at')
          .execute();
        expect(events).toEqual([{ action: 'document.shared' }, { action: 'document.unshared' }, { action: 'document.withdrawn' }]);
      } finally {
        await holder.destroy();
      }
    }, 30_000);
  });

  describe('GET /documents/:id/versions/:number/content', () => {
    const download = (sessionToken: string, documentId: string, number = 1) =>
      request(app.getHttpServer())
        .get(`/documents/${documentId}/versions/${number}/content`)
        .set('Cookie', cookie(sessionToken))
        .buffer(true)
        .parse((response, done) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => done(null, Buffer.concat(chunks)));
        });

    it('sends the exact file, as a download that cannot run in the browser', async () => {
      const added = await upload(token, PDF, 'Lease – 12 High St.pdf');

      const response = await download(token, added.body.id);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(PDF);
      expect(response.headers).toMatchObject({
        'content-type': 'application/pdf',
        'content-length': String(PDF.length),
        'content-disposition': `attachment; filename="Lease _ 12 High St.pdf"; filename*=UTF-8''Lease%20%E2%80%93%2012%20High%20St.pdf`,
        'content-security-policy': "default-src 'none'; sandbox",
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      });
    });

    it('records the download by ids and version', async () => {
      const added = await upload(token, PDF, 'lease.pdf');

      await download(token, added.body.id);

      const event = await db
        .selectFrom('audit_events')
        .select(['actor_id', 'metadata'])
        .where('resource_id', '=', added.body.id)
        .where('action', '=', 'document.downloaded')
        .executeTakeFirstOrThrow();
      expect(event).toEqual({ actor_id: feeEarner.id, metadata: { matterId, version: 1 } });
    });

    it('answers 404, and records nothing, for someone not on the team or a version that does not exist', async () => {
      const added = await upload(token, PDF, 'lease.pdf');
      const outsider = await signedIn(await staffWith('fee_earner'));

      expect((await download(outsider, added.body.id)).status).toBe(404);
      expect((await download(token, added.body.id, 2)).status).toBe(404);
      const downloads = await db
        .selectFrom('audit_events')
        .select('id')
        .where('resource_id', '=', added.body.id)
        .where('action', '=', 'document.downloaded')
        .execute();
      expect(downloads).toEqual([]);
    });

    it('cuts the download off when the stored file was changed, rather than sending altered content', async () => {
      const original = Buffer.from('Attendance note. '.repeat(12_000));
      const added = await upload(token, original, 'note.txt');
      const { storage_key: storageKey } = await db
        .selectFrom('document_versions')
        .select('storage_key')
        .where('document_id', '=', added.body.id)
        .executeTakeFirstOrThrow();
      const storage = app.get(ObjectStorage);
      const raw = await buffer(await storage.get(storageKey));
      raw[raw.length - 40] = (raw[raw.length - 40] ?? 0) ^ 0x01;
      await storage.put(storageKey, Readable.from([raw]));

      // The transfer fails as a whole: never a shorter file that looks complete.
      await expect(download(token, added.body.id)).rejects.toThrow();
    });
  });

  describe('POST /documents/:id/versions', () => {
    const addVersion = (sessionToken: string, documentId: string, file: Buffer, fileName: string) =>
      request(app.getHttpServer()).post(`/documents/${documentId}/versions`).set('Cookie', cookie(sessionToken)).attach('file', file, fileName);
    const contentOf = async (documentId: string, number: number) =>
      (
        await request(app.getHttpServer())
          .get(`/documents/${documentId}/versions/${number}/content`)
          .set('Cookie', cookie(token))
          .buffer(true)
          .parse((response, done) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => done(null, Buffer.concat(chunks)));
          })
      ).body as Buffer;

    it('adds version 2, keeping version 1 downloadable', async () => {
      const added = await upload(token, PDF, 'lease.pdf');
      const signed = Buffer.from('%PDF-1.7\n% signed by both parties\n%%EOF\n', 'ascii');

      const response = await addVersion(await signedIn(partner), added.body.id, signed, 'lease-signed.pdf');

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ number: 2, fileName: 'lease-signed.pdf', mediaType: 'application/pdf', sizeBytes: signed.length, uploadedAt: expect.any(String) });
      expect(await contentOf(added.body.id, 1)).toEqual(PDF);
      expect(await contentOf(added.body.id, 2)).toEqual(signed);
      const listed = await request(app.getHttpServer()).get(`/matters/${matterId}/documents`).set('Cookie', cookie(token));
      expect(listed.body.documents[0].latest).toMatchObject({ number: 2, fileName: 'lease-signed.pdf' });
      const event = await db
        .selectFrom('audit_events')
        .select(['actor_id', 'metadata'])
        .where('resource_id', '=', added.body.id)
        .where('action', '=', 'document.version_added')
        .executeTakeFirstOrThrow();
      expect(event).toEqual({ actor_id: partner.id, metadata: { matterId, version: 2, mediaType: 'application/pdf', sizeBytes: signed.length } });
    });

    it('checks a new version exactly as a first upload', async () => {
      const added = await upload(token, PDF, 'lease.pdf');

      const response = await addVersion(token, added.body.id, Buffer.from('<html></html>'), 'lease.pdf');

      expect(response.status).toBe(415);
      const versions = await db.selectFrom('document_versions').select('number').where('document_id', '=', added.body.id).execute();
      expect(versions).toEqual([{ number: 1 }]);
    });

    it('answers 404 to someone not on the team, and refuses extra form fields', async () => {
      const added = await upload(token, PDF, 'lease.pdf');
      const outsider = await signedIn(await staffWith('fee_earner'));

      expect((await addVersion(outsider, added.body.id, PDF, 'lease.pdf')).status).toBe(404);
      const withTitle = await request(app.getHttpServer())
        .post(`/documents/${added.body.id}/versions`)
        .set('Cookie', cookie(token))
        .field('title', 'Renamed')
        .attach('file', PDF, 'lease.pdf');
      expect(withTitle.status).toBe(400);
    });

    it('refuses a closed matter', async () => {
      const added = await upload(token, PDF, 'lease.pdf');
      await request(app.getHttpServer())
        .post(`/matters/${matterId}/close`)
        .set('Cookie', cookie(await signedIn(partner)))
        .send({ reason: 'Lease renewed and signed' })
        .expect(204);

      expect((await addVersion(token, added.body.id, PDF, 'lease.pdf')).status).toBe(409);
    });
  });

  describe('POST /documents/:id/withdrawal', () => {
    const withdraw = (sessionToken: string, documentId: string, reason = 'Uploaded to the wrong matter by mistake') =>
      request(app.getHttpServer()).post(`/documents/${documentId}/withdrawal`).set('Cookie', cookie(sessionToken)).send({ reason });

    it('withdraws a document: kept and shown as withdrawn, but no longer listed, downloaded or versioned', async () => {
      const added = await upload(token, PDF, 'lease.pdf');
      const server = request(app.getHttpServer());

      expect((await withdraw(token, added.body.id)).status).toBe(204);

      expect((await server.get(`/matters/${matterId}/documents`).set('Cookie', cookie(token))).body.documents).toEqual([]);
      const found = await server.get(`/documents/${added.body.id}`).set('Cookie', cookie(token));
      expect(found.body.withdrawal).toEqual({
        withdrawnBy: { accountId: feeEarner.id, displayName: 'Test staff' },
        reason: 'Uploaded to the wrong matter by mistake',
        withdrawnAt: expect.any(String),
      });
      expect((await server.get(`/documents/${added.body.id}/versions/1/content`).set('Cookie', cookie(token))).status).toBe(410);
      const newVersion = await server.post(`/documents/${added.body.id}/versions`).set('Cookie', cookie(token)).attach('file', PDF, 'lease.pdf');
      expect(newVersion.status).toBe(409);
    });

    it('records the withdrawal by ids, without the reason', async () => {
      const added = await upload(token, PDF, 'lease.pdf');

      await withdraw(token, added.body.id);

      const event = await db
        .selectFrom('audit_events')
        .select(['actor_id', 'metadata'])
        .where('resource_id', '=', added.body.id)
        .where('action', '=', 'document.withdrawn')
        .executeTakeFirstOrThrow();
      expect(event).toEqual({ actor_id: feeEarner.id, metadata: { matterId } });
    });

    it("lets the matter's supervising partner withdraw someone else's document", async () => {
      const added = await upload(token, PDF, 'lease.pdf');

      expect((await withdraw(await signedIn(partner), added.body.id)).status).toBe(204);
    });

    it('refuses another fee earner on the team, and answers 404 to someone not on it', async () => {
      const added = await upload(token, PDF, 'lease.pdf');
      const colleague = await staffWith('fee_earner');
      await request(app.getHttpServer())
        .put(`/matters/${matterId}/team/${colleague.id}`)
        .set('Cookie', cookie(await signedIn(partner)))
        .expect(204);
      const outsider = await signedIn(await staffWith('partner'));

      expect((await withdraw(await signedIn(colleague), added.body.id)).status).toBe(403);
      expect((await withdraw(outsider, added.body.id)).status).toBe(404);
    });

    it('withdraws once, and needs a reason of 10 to 500 characters', async () => {
      const added = await upload(token, PDF, 'lease.pdf');

      expect((await withdraw(token, added.body.id, 'Mistake')).status).toBe(400);
      expect((await withdraw(token, added.body.id)).status).toBe(204);
      expect((await withdraw(token, added.body.id)).status).toBe(409);
    });
  });
});
