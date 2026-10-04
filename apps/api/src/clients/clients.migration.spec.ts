import { sql, type Insertable, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestAccount, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { ClientIndividualsTable, ClientKind, ClientOrganisationsTable, Database } from '../database/schema.js';

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

  it('stores a date of birth as the same calendar day', async () => {
    const client = await createClient('individual', { individual: individual({ date_of_birth: '1980-02-29' }) });

    const row = await db
      .selectFrom('client_individuals')
      .select('date_of_birth')
      .where('client_id', '=', client.id)
      .executeTakeFirstOrThrow();
    expect(row.date_of_birth).toBe('1980-02-29');
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
