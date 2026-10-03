import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount } from '../../../test/accounts.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../../../test/database.js';
import { createDatabase } from '../../database/database.js';
import type { Database } from '../../database/schema.js';

describe('sessions table', () => {
  let appDb: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let sessionId: string;
  let accountId: string;

  const insertSession = (overrides: Record<string, unknown> = {}) =>
    appDb
      .insertInto('sessions')
      .values({
        account_id: accountId,
        token_hash: randomBytes(32),
        stage: 'two_factor_pending',
        authenticated_at: null,
        last_seen_at: new Date(),
        expires_at: new Date(Date.now() + 60_000),
        ...overrides,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();

  beforeAll(() => {
    appDb = createDatabase<Database>(testAppDatabaseUrl(), 1);
    ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 1);
  });

  afterAll(async () => {
    await appDb.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    accountId = (await createTestAccount(appDb, 'staff')).id;
    sessionId = (await insertSession()).id;
  });

  it.each<[string, Record<string, unknown>]>([
    ['a token hash of the wrong length', { token_hash: randomBytes(16) }],
    ['an unknown stage', { stage: 'half_signed_in' }],
    ['an authenticated session without its time', { stage: 'authenticated' }],
  ])('rejects %s', async (_case, overrides) => {
    await expect(insertSession(overrides)).rejects.toThrow(/violates check constraint/);
  });

  it('rejects a session for an account that does not exist', async () => {
    await expect(insertSession({ account_id: '00000000-0000-7000-8000-000000000000' })).rejects.toThrow(
      /foreign key/,
    );
  });

  it.each([
    ['create a session already ended', () => insertSession({ ended_at: new Date(), end_reason: 'expired' })],
    ['move a session to another account', () => sql`update sessions set account_id = ${accountId} where id = ${sessionId}`.execute(appDb)],
    ['change a session token', () => sql`update sessions set token_hash = ${randomBytes(32)} where id = ${sessionId}`.execute(appDb)],
    ['delete a session', () => sql`delete from sessions where id = ${sessionId}`.execute(appDb)],
  ])('the app role cannot %s', async (_case, attempt) => {
    await expect(attempt()).rejects.toThrow(/permission denied/);
  });

  describe('transitions', () => {
    const end = () =>
      appDb.updateTable('sessions').set({ ended_at: new Date(), end_reason: 'signed_out' }).where('id', '=', sessionId).execute();
    const authenticate = () =>
      appDb.updateTable('sessions').set({ stage: 'authenticated', authenticated_at: new Date() }).where('id', '=', sessionId).execute();

    it('allows pending → authenticated → ended', async () => {
      await expect(authenticate()).resolves.toBeDefined();
      await expect(end()).resolves.toBeDefined();
    });

    it('never reopens an ended session, even for the table owner', async () => {
      await end();

      await expect(
        ownerDb.updateTable('sessions').set({ ended_at: null, end_reason: null }).where('id', '=', sessionId).execute(),
      ).rejects.toThrow(/has ended and cannot change/);
    });

    it('never moves an authenticated session back to pending', async () => {
      await authenticate();

      await expect(
        appDb.updateTable('sessions').set({ stage: 'two_factor_pending', authenticated_at: null }).where('id', '=', sessionId).execute(),
      ).rejects.toThrow(/cannot return to an earlier stage/);
    });
  });
});
