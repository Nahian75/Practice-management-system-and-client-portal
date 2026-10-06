import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, setAccountStatus, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database } from '../database/schema.js';

describe('portal links table', () => {
  let db: Kysely<Database>;
  let staff: TestAccount;
  let person: TestAccount;

  /** An individual client whose email on record is `email`. */
  const individualClient = (email: string | null) =>
    db.transaction().execute(async (trx) => {
      const { id } = await trx.insertInto('clients').values({ kind: 'individual', created_by: staff.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({ client_id: id, given_names: 'Jane', family_name: 'Doe', email }).execute();
      return id;
    });

  /** An organisation client with one contact whose email on record is `email`. */
  const organisationClient = (email: string | null) =>
    db.transaction().execute(async (trx) => {
      const { id } = await trx.insertInto('clients').values({ kind: 'organisation', created_by: staff.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_organisations').values({ client_id: id, legal_name: 'Acme Ltd', organisation_type: 'company' }).execute();
      const contact = await trx
        .insertInto('client_contacts')
        .values({ client_id: id, given_names: 'Kim', family_name: 'Ray', email })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { clientId: id, contactId: contact.id };
    });

  const link = (values: { accountId?: string; clientId: string; contactId?: string | null; linkedBy?: string }) =>
    db
      .insertInto('portal_links')
      .values({ account_id: values.accountId ?? person.id, client_id: values.clientId, contact_id: values.contactId ?? null, linked_by: values.linkedBy ?? staff.id })
      .returning('id')
      .executeTakeFirstOrThrow();

  const end = (linkId: string, by = staff.id) =>
    db.updateTable('portal_links').set({ ended_at: new Date(), ended_by: by }).where('id', '=', linkId).execute();

  beforeAll(() => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 1);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    staff = await createTestAccount(db, 'staff');
    person = await createTestAccount(db, 'client');
  });

  describe('an individual client', () => {
    it("links the client's own login, at the address on record", async () => {
      const clientId = await individualClient(person.email);

      await expect(link({ clientId })).resolves.toMatchObject({ id: expect.any(String) });
    });

    it('refuses a login at any other address, or a client with none on record', async () => {
      await expect(link({ clientId: await individualClient('someone.else@example.com') })).rejects.toThrow(/only to the email address on the client's record/);
      await expect(link({ clientId: await individualClient(null) })).rejects.toThrow(/only to the email address on the client's record/);
    });

    it('refuses a contact on a link to an individual', async () => {
      const clientId = await individualClient(person.email);
      const { contactId } = await organisationClient(person.email);

      await expect(link({ clientId, contactId })).rejects.toThrow(/for the client themself/);
    });
  });

  describe('an organisation client', () => {
    it('links one of its active contacts, at the address on record', async () => {
      const { clientId, contactId } = await organisationClient(person.email);

      await expect(link({ clientId, contactId })).resolves.toMatchObject({ id: expect.any(String) });
    });

    it('refuses no contact, a contact of another client, or a contact no longer active', async () => {
      const { clientId, contactId } = await organisationClient(person.email);
      const other = await organisationClient(person.email);

      await expect(link({ clientId })).rejects.toThrow(/one of its active contacts/);
      await expect(link({ clientId, contactId: other.contactId })).rejects.toThrow(/one of its active contacts/);
      await db.updateTable('client_contacts').set({ active: false }).where('id', '=', contactId).execute();
      await expect(link({ clientId, contactId })).rejects.toThrow(/one of its active contacts/);
    });
  });

  describe('accounts', () => {
    it('refuses a staff account, a disabled client account, and a link made by a client', async () => {
      const clientId = await individualClient(person.email);
      const otherStaff = await createTestAccount(db, 'staff');
      const otherClient = await createTestAccount(db, 'client');

      await expect(link({ accountId: otherStaff.id, clientId })).rejects.toThrow(/client accounts that are not disabled/);
      await expect(link({ clientId, linkedBy: otherClient.id })).rejects.toThrow(/made by staff/);
      await setAccountStatus(db, person.id, 'disabled');
      await expect(link({ clientId })).rejects.toThrow(/client accounts that are not disabled/);
    });
  });

  describe('ending a link', () => {
    it('allows one active link per person and client, and a new one once it has ended', async () => {
      const clientId = await individualClient(person.email);
      const first = await link({ clientId });

      await expect(link({ clientId })).rejects.toThrow(/duplicate key/);
      await end(first.id);
      await expect(link({ clientId })).resolves.toMatchObject({ id: expect.any(String) });
    });

    it('ends once, by staff, and stays ended', async () => {
      const clientId = await individualClient(person.email);
      const { id } = await link({ clientId });

      await expect(end(id, person.id)).rejects.toThrow(/ended by staff/);
      await end(id);
      await expect(end(id)).rejects.toThrow(/already ended/);
      await expect(db.updateTable('portal_links').set({ ended_at: null, ended_by: null }).where('id', '=', id).execute()).rejects.toThrow(/already ended/);
    });

    it.each([
      ['remove a link', (id: string) => sql`delete from portal_links where id = ${id}`],
      ['move a link to another client', (id: string) => sql`update portal_links set client_id = client_id where id = ${id}`],
      ['change who it is for', (id: string) => sql`update portal_links set account_id = account_id where id = ${id}`],
    ])('does not let the app %s', async (_case, statement) => {
      const { id } = await link({ clientId: await individualClient(person.email) });

      await expect(statement(id).execute(db)).rejects.toThrow(/permission denied/);
    });
  });
});
