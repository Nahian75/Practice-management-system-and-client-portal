import { Test } from '@nestjs/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testEnv } from '../../test/database.js';
import { ConfigModule } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DATABASE, DatabaseModule } from './database.module.js';

async function startDatabaseModule(env: Env) {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot(env), DatabaseModule],
  })
    .setLogger({ log() {}, error() {}, warn() {} })
    .compile();
  await moduleRef.init();
  return moduleRef;
}

describe('DatabaseModule', () => {
  let close: () => Promise<void>;
  let db: Kysely<unknown>;

  beforeAll(async () => {
    const moduleRef = await startDatabaseModule(testEnv());
    db = moduleRef.get(DATABASE);
    close = () => moduleRef.close();
  });

  afterAll(async () => {
    await close();
  });

  it('connects as the least-privileged app role', async () => {
    const { rows } = await sql<{ user: string }>`select current_user as user`.execute(db);

    expect(rows[0]?.user).toBe('pms_app');
  });

  it('refuses to start when the credentials are wrong', async () => {
    const wrongPassword = new URL(testEnv().DATABASE_URL);
    wrongPassword.password = 'wrong-password';

    await expect(startDatabaseModule(testEnv({ DATABASE_URL: wrongPassword.href }))).rejects.toThrow(
      /password authentication failed/,
    );
  });
});

describe('pms_app database privileges', () => {
  let close: () => Promise<void>;
  let db: Kysely<unknown>;

  beforeAll(async () => {
    const moduleRef = await startDatabaseModule(testEnv());
    db = moduleRef.get(DATABASE);
    close = () => moduleRef.close();
  });

  afterAll(async () => {
    await close();
  });

  it.each([
    ['create a table', sql`create table app.intruder (id int)`],
    ['create a table in public', sql`create table public.intruder (id int)`],
    ['create a schema', sql`create schema intruder`],
    ['read migration history', sql`select * from migrations.kysely_migration`],
    ['create a role', sql`create role intruder superuser`],
    ['read password hashes', sql`select rolpassword from pg_authid`],
    ['read server files', sql`select pg_read_file('/etc/passwd')`],
    ['run shell commands', sql`copy (select 1) to program 'id'`],
  ])('cannot %s', async (_action, statement) => {
    await expect(statement.execute(db)).rejects.toThrow(/permission denied|must be|only roles/i);
  });

  it('has short timeouts so a stuck query cannot hold the database', async () => {
    const { rows } = await sql<{ statement: string; idle: string }>`
      select current_setting('statement_timeout') as statement,
             current_setting('idle_in_transaction_session_timeout') as idle
    `.execute(db);

    expect(rows[0]).toEqual({ statement: '15s', idle: '30s' });
  });
});
