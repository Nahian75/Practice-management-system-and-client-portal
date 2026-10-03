import { fileURLToPath } from 'node:url';
import { createDatabase } from '../src/database/database.js';
import { assertNotSuperuser, createMigrator } from '../src/database/migrator.js';
import { testOwnerDatabaseUrl } from './database.js';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations/', import.meta.url));

export async function setup(): Promise<void> {
  const db = createDatabase<unknown>(testOwnerDatabaseUrl(), 1);
  try {
    await assertNotSuperuser(db);
    const { error } = await createMigrator(db, MIGRATIONS_DIRECTORY).migrateToLatest();
    if (error) {
      throw error;
    }
  } finally {
    await db.destroy();
  }
}
