import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  nodeEnvSchema,
  parseEnv,
  postgresUrlSchema,
  requireVerifiedTlsInProduction,
} from '../config/env.js';
import { createDatabase } from './database.js';
import { assertNotSuperuser, createMigrator } from './migrator.js';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../migrations/', import.meta.url));

const migrationEnvSchema = z
  .object({
    NODE_ENV: nodeEnvSchema,
    MIGRATION_DATABASE_URL: postgresUrlSchema,
  })
  .superRefine(requireVerifiedTlsInProduction('MIGRATION_DATABASE_URL'));

const env = parseEnv(migrationEnvSchema, process.env);
const db = createDatabase<unknown>(env.MIGRATION_DATABASE_URL, 1);

try {
  await assertNotSuperuser(db);
  const { error, results = [] } = await createMigrator(db, MIGRATIONS_DIRECTORY).migrateToLatest();

  for (const result of results) {
    console.log(`${result.status.padEnd(8)} ${result.migrationName}`);
  }
  if (results.length === 0 && !error) {
    console.log('No pending migrations');
  }
  if (error) {
    console.error('Migration failed. The failing migration was rolled back.');
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  await db.destroy();
}
