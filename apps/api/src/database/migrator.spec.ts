import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from './database.js';
import { assertNotSuperuser, createMigrator } from './migrator.js';

describe('SQL file migrations', () => {
  let db: Kysely<unknown>;
  let directory: string;
  let schema: string;

  const migrate = () => createMigrator(db, directory, `${schema}_migrations`).migrateToLatest();
  const write = (file: string, statements: string) => writeFile(join(directory, file), statements);

  async function tableExists(table: string): Promise<boolean> {
    const { rows } = await sql<{ exists: boolean }>`
      select to_regclass(${`${schema}.${table}`}) is not null as exists
    `.execute(db);
    return rows[0]?.exists === true;
  }

  beforeAll(() => {
    db = createDatabase<unknown>(testOwnerDatabaseUrl(), 1);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    schema = `test_${randomBytes(6).toString('hex')}`;
    directory = await mkdtemp(join(tmpdir(), 'migrations-'));
    await sql`create schema ${sql.id(schema)}`.execute(db);
  });

  afterEach(async () => {
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await sql`drop schema if exists ${sql.id(`${schema}_migrations`)} cascade`.execute(db);
    await rm(directory, { recursive: true, force: true });
  });

  it('applies pending files in name order', async () => {
    await write('0002_add_column.sql', `alter table ${schema}.matters add column title text;`);
    await write('0001_create_table.sql', `create table ${schema}.matters (id int primary key);`);

    const { error, results } = await migrate();

    expect(error).toBeUndefined();
    expect(results?.map((r) => [r.migrationName, r.status])).toEqual([
      ['0001_create_table', 'Success'],
      ['0002_add_column', 'Success'],
    ]);
  });

  it('does nothing when every file is already applied', async () => {
    await write('0001_create_table.sql', `create table ${schema}.matters (id int primary key);`);
    await migrate();

    const { error, results } = await migrate();

    expect(error).toBeUndefined();
    expect(results).toEqual([]);
  });

  it('runs a file with several statements', async () => {
    await write(
      '0001_two_tables.sql',
      `create table ${schema}.clients (id int primary key);
       create table ${schema}.matters (id int primary key, client_id int references ${schema}.clients(id));`,
    );

    await migrate();

    expect(await tableExists('clients')).toBe(true);
    expect(await tableExists('matters')).toBe(true);
  });

  it('rolls back the whole file when one statement fails', async () => {
    await write(
      '0001_half_broken.sql',
      `create table ${schema}.clients (id int primary key);
       create table ${schema}.matters (id int references ${schema}.no_such_table(id));`,
    );

    const { error } = await migrate();

    expect(error).toBeDefined();
    expect(await tableExists('clients')).toBe(false);
  });

  it('refuses to run when an applied migration file has been removed', async () => {
    await write('0001_create_table.sql', `create table ${schema}.matters (id int primary key);`);
    await migrate();
    await unlink(join(directory, '0001_create_table.sql'));
    await write('0002_next.sql', `create table ${schema}.clients (id int primary key);`);

    const { error } = await migrate();

    expect(error).toBeDefined();
    expect(await tableExists('clients')).toBe(false);
  });

  it('refuses a new file that sorts before an applied one', async () => {
    await write('0002_create_table.sql', `create table ${schema}.matters (id int primary key);`);
    await migrate();
    await write('0001_late_arrival.sql', `create table ${schema}.clients (id int primary key);`);

    const { error } = await migrate();

    expect(error).toBeDefined();
    expect(await tableExists('clients')).toBe(false);
  });

  it('runs as a role that is not a superuser', async () => {
    await expect(assertNotSuperuser(db)).resolves.toBeUndefined();
  });
});
