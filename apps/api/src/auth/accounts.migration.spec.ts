import { randomUUID } from 'node:crypto';
import { sql, type Insertable, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testAppDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { AccountsTable, Database } from '../database/schema.js';

const VALID_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g';

describe('accounts table', () => {
  let db: Kysely<Database>;

  const uniqueEmail = () => `user-${randomUUID()}@example.com`;

  // Takes loose values on purpose: the tests below send rows the types would forbid,
  // to prove the database rejects them too.
  const insert = (overrides: Record<string, unknown> = {}) =>
    db
      .insertInto('accounts')
      .values({ kind: 'client', email: uniqueEmail(), display_name: 'Test Client', ...overrides } as Insertable<AccountsTable>)
      .returning(['id', 'status'])
      .executeTakeFirstOrThrow();

  beforeAll(() => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 1);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('creates an invited account with no password', async () => {
    expect((await insert()).status).toBe('invited');
  });

  it('allows an active account with a password', async () => {
    await expect(
      insert({ status: 'active', password_hash: VALID_HASH, password_changed_at: new Date() }),
    ).resolves.toBeDefined();
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown kind', { kind: 'admin' }],
    ['an email with capitals', { email: 'Jane@Example.com' }],
    ['an email with surrounding spaces', { email: ' jane@example.com ' }],
    ['an email without @', { email: 'jane.example.com' }],
    ['a blank display name', { display_name: '   ' }],
    ['an unknown status', { status: 'deleted' }],
    ['an active account with no password', { status: 'active' }],
    ['a password that is not an Argon2id hash', { password_hash: 'hunter2', password_changed_at: new Date() }],
    ['a password hash without its change date', { password_hash: VALID_HASH }],
  ])('rejects %s', async (_case, overrides) => {
    await expect(insert(overrides)).rejects.toThrow(/violates check constraint/);
  });

  it('rejects a second account with the same email', async () => {
    const email = uniqueEmail();
    await insert({ email });

    await expect(insert({ email })).rejects.toThrow(/duplicate key/);
  });

  describe('app role restrictions', () => {
    let accountId: string;

    const attempts = (id: string) => ({
      'turn a client into staff': sql`update accounts set kind = 'staff' where id = ${id}`,
      'change the email': sql`update accounts set email = 'attacker@example.com' where id = ${id}`,
      'change the id': sql`update accounts set id = uuidv7() where id = ${id}`,
      'delete an account': sql`delete from accounts where id = ${id}`,
    });

    beforeAll(async () => {
      accountId = (await insert()).id;
    });

    it('may change the display name', async () => {
      await expect(
        db.updateTable('accounts').set({ display_name: 'Renamed' }).where('id', '=', accountId).execute(),
      ).resolves.toBeDefined();
    });

    it.each([
      'turn a client into staff',
      'change the email',
      'change the id',
      'delete an account',
    ] as const)('cannot %s', async (attempt) => {
      await expect(attempts(accountId)[attempt].execute(db)).rejects.toThrow(/permission denied/);
    });
  });
});
