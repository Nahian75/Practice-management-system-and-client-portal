import { randomBytes, randomUUID } from 'node:crypto';
import { sql, type Insertable, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database, DocumentVersionsTable, StaffRole } from '../database/schema.js';

describe('documents tables', () => {
  let db: Kysely<Database>;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let matterId: string;

  async function staffWith(...roles: StaffRole[]): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) {
      await grantTestRole(db, account.id, role);
    }
    return account;
  }

  const uniqueName = () => randomUUID().replaceAll('-', '').slice(0, 16);

  /** A client with a name no other test uses, so checking another name finds nothing. */
  async function insertClient(trx: Kysely<Database>, familyName = uniqueName()): Promise<string> {
    const created = await trx
      .insertInto('clients')
      .values({ kind: 'individual', created_by: feeEarner.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.insertInto('client_individuals').values({ client_id: created.id, given_names: 'Test', family_name: familyName }).execute();
    return created.id;
  }
  const createClient = (familyName?: string) => db.transaction().execute((trx) => insertClient(trx, familyName));

  /** A matter supervised by `partner`, with `feeEarner` on the team; awaiting clearance if `checkName` matches a client. */
  const openMatter = (checkName = uniqueName()) =>
    db.transaction().execute(async (trx) => {
      const clientId = await insertClient(trx);
      const check = await trx
        .insertInto('conflict_checks')
        .values({ client_id: clientId, requested_by: feeEarner.id, names: [checkName] })
        .returning('id')
        .executeTakeFirstOrThrow();
      const matter = await trx
        .insertInto('matters')
        .values({ client_id: clientId, title: 'Lease renewal', matter_type: 'commercial_property', opened_by: feeEarner.id, conflict_check_id: check.id })
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();
      await trx.insertInto('matter_team').values({ matter_id: matter.id, account_id: partner.id, role: 'supervising_partner', added_by: feeEarner.id }).execute();
      await trx.insertInto('matter_team').values({ matter_id: matter.id, account_id: feeEarner.id, role: 'fee_earner', added_by: feeEarner.id }).execute();
      return matter;
    });

  /** A version row; tests that check the database's refusals pass values the types would not allow. */
  const version = (
    documentId: string,
    uploadedBy: string,
    overrides: Partial<{ file_name: string; media_type: string; size_bytes: number; sha256: Buffer }> = {},
  ): Insertable<DocumentVersionsTable> => ({
    document_id: documentId,
    file_name: 'lease.pdf',
    media_type: 'application/pdf' as const,
    size_bytes: 1234,
    sha256: randomBytes(32),
    storage_key: randomUUID(),
    key_version: 1,
    key_nonce: randomBytes(12),
    wrapped_key: randomBytes(32),
    key_tag: randomBytes(16),
    uploaded_by: uploadedBy,
    ...(overrides as Partial<Insertable<DocumentVersionsTable>>),
  });

  /** Adds a document with its first version, in one transaction, as the app will. */
  const addDocument = (matter: string, by: string, overrides: Parameters<typeof version>[2] = {}) =>
    db.transaction().execute(async (trx) => {
      const document = await trx
        .insertInto('documents')
        .values({ matter_id: matter, title: 'Signed lease', category: 'contract', created_by: by })
        .returning('id')
        .executeTakeFirstOrThrow();
      const first = await trx
        .insertInto('document_versions')
        .values(version(document.id, by, overrides))
        .returning('number')
        .executeTakeFirstOrThrow();
      return { id: document.id, number: first.number };
    });

  const addVersion = (documentId: string, by: string) =>
    db.insertInto('document_versions').values(version(documentId, by)).returning('number').executeTakeFirstOrThrow();

  beforeAll(async () => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 1);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    partner = await staffWith('partner');
    feeEarner = await staffWith('fee_earner');
    matterId = (await openMatter()).id;
  });

  it('adds a document with its first version, and numbers later versions in order', async () => {
    const document = await addDocument(matterId, feeEarner.id);

    expect(document.number).toBe(1);
    expect((await addVersion(document.id, partner.id)).number).toBe(2);
    expect((await addVersion(document.id, feeEarner.id)).number).toBe(3);
  });

  it('refuses a document without a version, when the transaction commits', async () => {
    const insertAlone = db
      .insertInto('documents')
      .values({ matter_id: matterId, title: 'Empty', category: 'other', created_by: feeEarner.id })
      .execute();

    await expect(insertAlone).rejects.toThrow(/at least one version/);
  });

  describe('who can add', () => {
    it('refuses someone not on the team, for a document and for a version', async () => {
      const outsider = await staffWith('fee_earner');
      const document = await addDocument(matterId, feeEarner.id);

      await expect(addDocument(matterId, outsider.id)).rejects.toThrow(/matter's team/);
      await expect(addVersion(document.id, outsider.id)).rejects.toThrow(/matter's team/);
    });

    it('refuses someone removed from the team', async () => {
      const document = await addDocument(matterId, feeEarner.id);
      await db
        .updateTable('matter_team')
        .set({ removed_at: new Date(), removed_by: partner.id })
        .where('matter_id', '=', matterId)
        .where('account_id', '=', feeEarner.id)
        .execute();

      await expect(addVersion(document.id, feeEarner.id)).rejects.toThrow(/matter's team/);
    });
  });

  describe('which matters', () => {
    it('refuses a matter awaiting conflict clearance', async () => {
      const existing = uniqueName();
      await createClient(existing);
      const awaiting = await openMatter(`Test ${existing}`);

      expect(awaiting.status).toBe('awaiting_clearance');
      await expect(addDocument(awaiting.id, feeEarner.id)).rejects.toThrow(/only to open matters/);
    });

    it('refuses a closed matter, for a document and for a version', async () => {
      const document = await addDocument(matterId, feeEarner.id);
      await db.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'Lease renewed and signed' }).execute();

      await expect(addDocument(matterId, feeEarner.id)).rejects.toThrow(/only to open matters/);
      await expect(addVersion(document.id, feeEarner.id)).rejects.toThrow(/only to open matters/);
    });
  });

  describe('what the app cannot do', () => {
    it.each([
      ['change a version', (id: string) => sql`update document_versions set size_bytes = 1 where document_id = ${id}`],
      ['remove a version', (id: string) => sql`delete from document_versions where document_id = ${id}`],
      ['change a document', (id: string) => sql`update documents set title = 'Changed' where id = ${id}`],
      ['remove a document', (id: string) => sql`delete from documents where id = ${id}`],
      ['choose a version number', (id: string) =>
        sql`insert into document_versions (document_id, number, file_name, media_type, size_bytes, sha256, storage_key,
              key_version, key_nonce, wrapped_key, key_tag, uploaded_by)
            values (${id}, 7, 'a.pdf', 'application/pdf', 1, ${randomBytes(32)}, ${randomUUID()}, 1,
              ${randomBytes(12)}, ${randomBytes(32)}, ${randomBytes(16)}, ${feeEarner.id})`],
    ])('%s', async (_case, statement) => {
      const document = await addDocument(matterId, feeEarner.id);

      await expect(statement(document.id).execute(db)).rejects.toThrow(/permission denied/);
    });
  });

  describe('what a version may hold', () => {
    it.each([
      ['a file name with a slash', { file_name: 'folder/lease.pdf' }],
      ['a file name with a backslash', { file_name: `folder${String.fromCharCode(92)}lease.pdf` }],
      ['a file name with a control character', { file_name: `lease${String.fromCharCode(10)}.pdf` }],
      ['an empty file name', { file_name: '' }],
      ['a type not allowed', { media_type: 'text/html' }],
      ['an empty file', { size_bytes: 0 }],
      ['a file over 50 MB', { size_bytes: 50 * 1024 * 1024 + 1 }],
      ['a fingerprint of the wrong length', { sha256: randomBytes(20) }],
    ])('refuses %s', async (_case, overrides) => {
      await expect(addDocument(matterId, feeEarner.id, overrides)).rejects.toThrow(/violates check constraint/);
    });

    it('accepts a file of exactly 50 MB', async () => {
      await expect(addDocument(matterId, feeEarner.id, { size_bytes: 50 * 1024 * 1024 })).resolves.toMatchObject({ number: 1 });
    });
  });

  describe('withdrawal', () => {
    const withdraw = (documentId: string, by: string, reason = 'Uploaded to the wrong matter by mistake') =>
      db.insertInto('document_withdrawals').values({ document_id: documentId, withdrawn_by: by, reason }).execute();

    it('lets whoever added the document withdraw it, and then takes no new versions', async () => {
      const document = await addDocument(matterId, feeEarner.id);

      await withdraw(document.id, feeEarner.id);

      await expect(addVersion(document.id, feeEarner.id)).rejects.toThrow(/withdrawn and takes no new versions/);
    });

    it("lets the matter's supervising partner withdraw someone else's document", async () => {
      const document = await addDocument(matterId, feeEarner.id);

      await expect(withdraw(document.id, partner.id)).resolves.toBeDefined();
    });

    it('refuses another fee earner on the team, and anyone not on it', async () => {
      const colleague = await staffWith('fee_earner');
      await db.insertInto('matter_team').values({ matter_id: matterId, account_id: colleague.id, role: 'fee_earner', added_by: partner.id }).execute();
      const outsider = await staffWith('partner');
      const document = await addDocument(matterId, feeEarner.id);

      await expect(withdraw(document.id, colleague.id)).rejects.toThrow(/whoever added it or by the matter's supervising partner/);
      await expect(withdraw(document.id, outsider.id)).rejects.toThrow(/matter's team/);
    });

    it('withdraws a document once only', async () => {
      const document = await addDocument(matterId, feeEarner.id);
      await withdraw(document.id, feeEarner.id);

      await expect(withdraw(document.id, partner.id)).rejects.toThrow(/duplicate key/);
    });

    it('refuses on a closed matter', async () => {
      const document = await addDocument(matterId, feeEarner.id);
      await db.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'Lease renewed and signed' }).execute();

      await expect(withdraw(document.id, feeEarner.id)).rejects.toThrow(/only to open matters/);
    });

    it.each([
      ['too short', 'Mistake'],
      ['over 500 characters', 'x'.repeat(501)],
      ['with a control character', `Wrong matter${String.fromCharCode(10)}entirely`],
    ])('refuses a reason %s', async (_case, reason) => {
      const document = await addDocument(matterId, feeEarner.id);

      await expect(withdraw(document.id, feeEarner.id, reason)).rejects.toThrow(/violates check constraint/);
    });

    it.each([
      ['undo a withdrawal', (id: string) => sql`delete from document_withdrawals where document_id = ${id}`],
      ['change its reason', (id: string) => sql`update document_withdrawals set reason = 'Something else entirely' where document_id = ${id}`],
    ])('does not let the app %s', async (_case, statement) => {
      const document = await addDocument(matterId, feeEarner.id);
      await withdraw(document.id, feeEarner.id);

      await expect(statement(document.id).execute(db)).rejects.toThrow(/permission denied/);
    });
  });
});
