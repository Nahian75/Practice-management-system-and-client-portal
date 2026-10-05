// Recreates the end-to-end test database, pms_e2e, and applies every
// migration, before each `npm run test:e2e`. It is separate from the API's
// test database: the two suites sign in from the same address, and sharing
// one database let one suite's deliberate failures use up the other's
// per-address sign-in allowance.
//
// Needs the local PostgreSQL container running and the API built.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { e2eDatabaseUrl } from './support/database.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
process.loadEnvFile(new URL('../../api/.env', import.meta.url));

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: ['pipe', 'inherit', 'inherit'], ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed`);
  }
}

run('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'pms', '-q', '-v', 'db=pms_e2e', '-f', '-'], {
  cwd: root,
  input: readFileSync(new URL('../../../infra/postgres/reset-test-database.sql', import.meta.url)),
});

const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL;
if (!migrationUrl) {
  throw new Error('TEST_MIGRATION_DATABASE_URL is not set in apps/api/.env');
}
run('node', ['dist/database/migrate.js'], {
  cwd: new URL('../../api/', import.meta.url),
  env: { ...process.env, MIGRATION_DATABASE_URL: e2eDatabaseUrl(migrationUrl) },
  stdio: ['ignore', 'ignore', 'inherit'],
});
