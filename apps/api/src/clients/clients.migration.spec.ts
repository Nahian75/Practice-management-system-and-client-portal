import { sql, type Insertable, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, revokeTestRole, setAccountStatus, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl } from '../../test/database.js';
import { permissionsFor, STAFF_ROLES } from '../auth/permissions/permissions.js';
import { createDatabase } from '../database/database.js';
import type {
  ClientContactsTable,
  ClientIndividualsTable,
  ClientKind,
  ClientOrganisationsTable,
  Database,
} from '../database/schema.js';

describe('clients tables', () => {
  let db: Kysely<Database>;
  let staff: TestAccount;

  // Takes loose values on purpose: the tests below send rows the types would forbid,
  // to prove the database rejects them too.
  const individual = (overrides: Record<string, unknown> = {}) =>
    ({ given_names: 'Jane', family_name: 'Doe', ...overrides }) as Omit<Insertable<ClientIndividualsTable>, 'client_id'>;
  const organisation = (overrides: Record<string, unknown> = {}) =>
    ({ legal_name: 'Acme Ltd', organisation_type: 'company', ...overrides }) as Omit<
      Insertable<ClientOrganisationsTable>,
      'client_id'
    >;

  async function createClient(
    kind: ClientKind,
    details: { individual?: ReturnType<typeof individual>; organisation?: ReturnType<typeof organisation> },
    createdBy = staff.id,
  ) {
    return db.transaction().execute(async (trx) => {
      const client = await trx
        .insertInto('clients')
        .values({ kind, created_by: createdBy })
        .returning(['id', 'number', 'reference', 'status'])
        .executeTakeFirstOrThrow();
      if (details.individual) {
        await trx.insertInto('client_individuals').values({ client_id: client.id, ...details.individual }).execute();
      }
      if (details.organisation) {
        await trx.insertInto('client_organisations').values({ client_id: client.id, ...details.organisation }).execute();
      }
      return client;
    });
  }

  beforeAll(async () => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 1);
    staff = await createTestAccount(db, 'staff');
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('numbers clients in order, with a C- reference padded to six digits', async () => {
    const first = await createClient('individual', { individual: individual() });
    const second = await createClient('organisation', { organisation: organisation() });

    expect(first.reference).toBe(`C-${first.number.padStart(6, '0')}`);
    expect(BigInt(second.number)).toBeGreaterThan(BigInt(first.number));
    expect(first.status).toBe('active');
  });

  it('does not let the app choose the number', async () => {
    await expect(
      sql`insert into clients (number, kind, created_by) overriding system value
          values (1, 'individual', ${staff.id})`.execute(db),
    ).rejects.toThrow(/permission denied/);
  });

  it('refuses a client created by a client account', async () => {
    const clientAccount = await createTestAccount(db, 'client');

    await expect(createClient('individual', { individual: individual() }, clientAccount.id)).rejects.toThrow(
      /created by staff accounts/,
    );
  });

  it('refuses a client without details, when the transaction commits', async () => {
    await expect(createClient('individual', {})).rejects.toThrow(/has no details/);
  });

  it('refuses details of the other kind', async () => {
    await expect(createClient('individual', { organisation: organisation() })).rejects.toThrow(
      /is not an organisation client/,
    );
  });

  it('refuses a second details row', async () => {
    await expect(
      createClient('individual', { individual: individual() }).then((client) =>
        db.insertInto('client_individuals').values({ client_id: client.id, ...individual() }).execute(),
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it.each<[string, Record<string, unknown>]>([
    ['blank given names', { given_names: '  ' }],
    ['an email with capitals', { email: 'Jane@Example.com' }],
    ['an email without @', { email: 'jane.example.com' }],
    ['a phone number with letters', { phone: '0207 CALL ME' }],
    ['a lower-case country', { address_line1: '1 High St', town: 'London', country: 'gb' }],
    ['an address without a town', { address_line1: '1 High St', country: 'GB' }],
    ['a postcode without an address', { postcode: 'SW1A 1AA' }],
    ['a date of birth before 1900', { date_of_birth: '1899-12-31' }],
  ])('refuses an individual with %s', async (_case, overrides) => {
    await expect(createClient('individual', { individual: individual(overrides) })).rejects.toThrow(
      /violates check constraint/,
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown organisation type', { organisation_type: 'club' }],
    ['a lower-case registration number', { registration_number: 'sc123456' }],
    ['a blank legal name', { legal_name: ' ' }],
  ])('refuses an organisation with %s', async (_case, overrides) => {
    await expect(createClient('organisation', { organisation: organisation(overrides) })).rejects.toThrow(
      /violates check constraint/,
    );
  });

  // Review C4: the database refuses these too, whatever path the text came by.
  describe('unsafe characters', () => {
    const UNSAFE: [string, number][] = [
      ['a tab', 0x09],
      ['a line break', 0x0a],
      ['a delete character', 0x7f],
      ['a line separator', 0x2028],
      ['a right-to-left override', 0x202e],
      ['a right-to-left isolate', 0x2067],
    ];

    it.each(UNSAFE)('refuses %s in an individual, an organisation, a contact and a takeover reason', async (_case, codePoint) => {
      const bad = `Doe${String.fromCodePoint(codePoint)}x`;
      const organisationId = (await createClient('organisation', { organisation: organisation() })).id;
      const disabled = await createTestAccount(db, 'staff', { status: 'disabled' });
      const takerOver = await createTestAccount(db, 'staff');
      const theirClient = (await createClient('individual', { individual: individual() }, disabled.id)).id;

      await expect(createClient('individual', { individual: individual({ family_name: bad }) })).rejects.toThrow(/text_safe/);
      await expect(createClient('organisation', { organisation: organisation({ legal_name: bad }) })).rejects.toThrow(/text_safe/);
      await expect(
        db.insertInto('client_contacts').values({ client_id: organisationId, given_names: 'Sam', family_name: bad }).execute(),
      ).rejects.toThrow(/text_safe/);
      await expect(
        db
          .insertInto('client_responsibility_changes')
          .values({ client_id: theirClient, from_account_id: disabled.id, to_account_id: takerOver.id, reason: `Left the firm ${bad}` })
          .execute(),
      ).rejects.toThrow(/reason_safe/);
    });

    it.each([
      ['accents', 'Zoë Brontë'],
      ['Arabic', 'محمد'],
      ['Chinese', '李小龙'],
      ['an apostrophe and a hyphen', "O'Brien-Smith"],
    ])('accepts a name with %s', async (_case, name) => {
      await expect(createClient('individual', { individual: individual({ family_name: name }) })).resolves.toBeDefined();
    });
  });

  it('stores a date of birth as the same calendar day', async () => {
    const client = await createClient('individual', { individual: individual({ date_of_birth: '1980-02-29' }) });

    const row = await db
      .selectFrom('client_individuals')
      .select('date_of_birth')
      .where('client_id', '=', client.id)
      .executeTakeFirstOrThrow();
    expect(row.date_of_birth).toBe('1980-02-29');
  });

  describe('responsibility', () => {
    let creator: TestAccount;
    let partner: TestAccount;
    let clientId: string;

    const responsibleFor = async (id: string) =>
      (await db.selectFrom('clients').select('responsible_id').where('id', '=', id).executeTakeFirstOrThrow()).responsible_id;

    const recordChange = (overrides: Record<string, unknown> = {}) =>
      db
        .insertInto('client_responsibility_changes')
        .values({
          client_id: clientId,
          from_account_id: creator.id,
          to_account_id: partner.id,
          reason: 'Creator left the firm before a matter was opened',
          ...overrides,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

    beforeEach(async () => {
      creator = await createTestAccount(db, 'staff');
      await grantTestRole(db, creator.id, 'fee_earner');
      partner = await createTestAccount(db, 'staff');
      clientId = (await createClient('individual', { individual: individual() }, creator.id)).id;
    });

    it('starts with the creator', async () => {
      expect(await responsibleFor(clientId)).toBe(creator.id);
    });

    it('moves to the new person when a change is recorded for a disabled account', async () => {
      await setAccountStatus(db, creator.id, 'disabled');

      await recordChange();

      expect(await responsibleFor(clientId)).toBe(partner.id);
    });

    it('moves to the new person when the responsible person no longer holds a role that sees clients', async () => {
      await revokeTestRole(db, creator.id, 'fee_earner');
      await grantTestRole(db, creator.id, 'accounts');

      await recordChange();

      expect(await responsibleFor(clientId)).toBe(partner.id);
    });

    it.each<[string, () => Promise<unknown>, RegExp]>([
      ['from someone who can still see the client', () => recordChange(), /can no longer see it/],
      ['from someone who is not responsible', () => recordChange({ from_account_id: partner.id, to_account_id: creator.id }), /is not the responsibility of/],
    ])('refuses a change %s', async (_case, attempt, error) => {
      await expect(attempt()).rejects.toThrow(error);
      expect(await responsibleFor(clientId)).toBe(creator.id);
    });

    // The trigger keeps its own list of roles that see clients; this keeps it in step with permissions.ts.
    it.each(STAFF_ROLES)('agrees with the permission table about an active %s', async (role) => {
      const holder = await createTestAccount(db, 'staff');
      await grantTestRole(db, holder.id, role);
      const theirClient = (await createClient('individual', { individual: individual() }, holder.id)).id;

      const attempt = recordChange({ client_id: theirClient, from_account_id: holder.id });

      if (permissionsFor([role]).has('clients.view')) {
        await expect(attempt).rejects.toThrow(/can no longer see it/);
      } else {
        await expect(attempt).resolves.toBeDefined();
      }
    });

    it.each<[string, () => Promise<TestAccount>]>([
      ['a client account', () => createTestAccount(db, 'client')],
      ['a disabled staff account', () => createTestAccount(db, 'staff', { status: 'disabled' })],
    ])('refuses a change to %s', async (_case, makeAccount) => {
      await setAccountStatus(db, creator.id, 'disabled');
      const recipient = await makeAccount();

      await expect(recordChange({ to_account_id: recipient.id })).rejects.toThrow(/by an active staff account/);
      expect(await responsibleFor(clientId)).toBe(creator.id);
    });

    it('refuses a short reason', async () => {
      await setAccountStatus(db, creator.id, 'disabled');

      await expect(recordChange({ reason: 'left' })).rejects.toThrow(/violates check constraint/);
    });

    // The trigger runs before the CHECK and already refuses it (a disabled account is not
    // active staff); the CHECK stays as a second line.
    it('refuses a change to the same person', async () => {
      await setAccountStatus(db, creator.id, 'disabled');

      await expect(recordChange({ to_account_id: creator.id })).rejects.toThrow(/active staff account|violates check constraint/);
    });

    it.each([
      ['set the responsible person on creation', () =>
        sql`insert into clients (kind, created_by, responsible_id) values ('individual', ${creator.id}, ${partner.id})`],
      ['change the responsible person directly', () => sql`update clients set responsible_id = ${partner.id} where id = ${clientId}`],
    ])('does not let the app %s', async (_case, statement) => {
      await expect(statement().execute(db)).rejects.toThrow(/permission denied/);
    });

    it('keeps every recorded change as it was', async () => {
      await setAccountStatus(db, creator.id, 'disabled');
      const { id } = await recordChange();

      await expect(sql`update client_responsibility_changes set reason = 'Rewritten afterwards' where id = ${id}`.execute(db)).rejects.toThrow(
        /permission denied/,
      );
      await expect(sql`delete from client_responsibility_changes where id = ${id}`.execute(db)).rejects.toThrow(/permission denied/);
    });
  });

  describe('contacts', () => {
    let organisationId: string;

    const addContact = (overrides: Record<string, unknown> = {}, clientId = organisationId) =>
      db
        .insertInto('client_contacts')
        .values({ client_id: clientId, given_names: 'Sam', family_name: 'Lee', ...overrides } as Insertable<ClientContactsTable>)
        .returning(['id', 'active'])
        .executeTakeFirstOrThrow();

    beforeAll(async () => {
      organisationId = (await createClient('organisation', { organisation: organisation() })).id;
    });

    it('adds an active contact to an organisation', async () => {
      expect((await addContact()).active).toBe(true);
    });

    it('refuses a contact for an individual client', async () => {
      const individualId = (await createClient('individual', { individual: individual() })).id;

      await expect(addContact({}, individualId)).rejects.toThrow(/is not an organisation client/);
    });

    it.each<[string, Record<string, unknown>]>([
      ['blank given names', { given_names: ' ' }],
      ['an email with capitals', { email: 'Sam@Example.com' }],
      ['a phone number with letters', { phone: 'call reception' }],
      ['a blank job title', { job_title: '' }],
    ])('refuses %s', async (_case, overrides) => {
      await expect(addContact(overrides)).rejects.toThrow(/violates check constraint/);
    });

    it.each([
      ['add a contact that is already inactive', () =>
        sql`insert into client_contacts (client_id, given_names, family_name, active) values (${organisationId}, 'A', 'B', false)`],
      ['move a contact to another client', (id: string) => sql`update client_contacts set client_id = uuidv7() where id = ${id}`],
      ['delete a contact', (id: string) => sql`delete from client_contacts where id = ${id}`],
    ])('does not let the app %s', async (_case, statement) => {
      const { id } = await addContact();

      await expect(statement(id).execute(db)).rejects.toThrow(/permission denied/);
    });
  });

  describe('app role restrictions', () => {
    let clientId: string;

    beforeAll(async () => {
      clientId = (await createClient('individual', { individual: individual() })).id;
    });

    it.each([
      ['turn an individual into an organisation', (id: string) => sql`update clients set kind = 'organisation' where id = ${id}`],
      ['change the creator', (id: string) => sql`update clients set created_by = created_by where id = ${id}`],
      ['archive a client (comes with Matters)', (id: string) => sql`update clients set status = 'archived' where id = ${id}`],
      ['move details to another client', (id: string) => sql`update client_individuals set client_id = uuidv7() where client_id = ${id}`],
      ['delete a client', (id: string) => sql`delete from clients where id = ${id}`],
      ['delete details', (id: string) => sql`delete from client_individuals where client_id = ${id}`],
    ])('may not %s', async (_case, statement) => {
      await expect(statement(clientId).execute(db)).rejects.toThrow(/permission denied/);
    });

    it('may change details, within the same checks as on creation', async () => {
      await expect(
        db.updateTable('client_individuals').set({ family_name: 'Smith' }).where('client_id', '=', clientId).execute(),
      ).resolves.toBeDefined();
      await expect(
        db.updateTable('client_individuals').set({ email: 'Not An Email' }).where('client_id', '=', clientId).execute(),
      ).rejects.toThrow(/violates check constraint/);
    });
  });
});
