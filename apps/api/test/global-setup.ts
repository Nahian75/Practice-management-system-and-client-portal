import { fileURLToPath } from 'node:url';
import { createDatabase } from '../src/database/database.js';
import { assertNotSuperuser, createMigrator } from '../src/database/migrator.js';
import { testOwnerDatabaseUrl } from './database.js';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations/', import.meta.url));

export async function setup(): Promise<void> {
  let db;
  try {
    db = createDatabase<unknown>(testOwnerDatabaseUrl(), 1);
    await assertNotSuperuser(db);
    const { error } = await createMigrator(db, MIGRATIONS_DIRECTORY).migrateToLatest();
    if (error) {
      throw error;
    }
  } catch (err: unknown) {
    const error = err as { code?: string; message?: string };
    if (error?.code === 'ECONNREFUSED' || error?.message?.includes('ECONNREFUSED')) {
      // eslint-disable-next-line no-console
      console.warn('PostgreSQL test database not available; running unit tests only.');
      return;
    }
    throw err;
  } finally {
    if (db) {
      await db.destroy();
    }
  }
}
