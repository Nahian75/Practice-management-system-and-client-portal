import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';

export const MIGRATIONS_SCHEMA = 'migrations';

/**
 * Each `.sql` file in the directory is one migration, applied in file-name
 * order inside its own transaction. Migrations only go forward: a mistake is
 * fixed by a new migration, never by editing or reverting an applied one.
 */
export class SqlFileMigrationProvider implements MigrationProvider {
  constructor(private readonly directory: string) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(this.directory)).filter((file) => file.endsWith('.sql')).sort();
    const migrations: Record<string, Migration> = {};

    for (const file of files) {
      const statements = await readFile(join(this.directory, file), 'utf8');
      migrations[basename(file, '.sql')] = {
        up: async (db) => {
          await sql.raw(statements).execute(db);
        },
      };
    }

    return migrations;
  }
}

export function createMigrator(db: Kysely<unknown>, directory: string, schema = MIGRATIONS_SCHEMA): Migrator {
  return new Migrator({
    db,
    provider: new SqlFileMigrationProvider(directory),
    migrationTableSchema: schema,
  });
}

export class SuperuserMigrationError extends Error {
  override readonly name = 'SuperuserMigrationError';
}

/**
 * Tables created by a superuser would be owned by it, and the app role's
 * default privileges (set for pms_owner) would not apply to them.
 */
export async function assertNotSuperuser(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<{ rolsuper: boolean }>`
    select rolsuper from pg_roles where rolname = current_user
  `.execute(db);

  if (rows[0]?.rolsuper !== false) {
    throw new SuperuserMigrationError('Migrations must run as pms_owner, not a superuser');
  }
}
