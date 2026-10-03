import { Logger } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

const MAX_POOL_CONNECTIONS = 10;

export function createDatabase<Schema>(connectionString: string, maxConnections = MAX_POOL_CONNECTIONS): Kysely<Schema> {
  const pool = new pg.Pool({ connectionString, max: maxConnections });

  // An idle connection can drop (database restart, network blip). Without a
  // listener, pg rethrows that error and the whole process exits.
  pool.on('error', (error) => {
    new Logger('Database').error(`Idle connection error: ${error.message}`);
  });

  return new Kysely<Schema>({ dialect: new PostgresDialect({ pool }) });
}
