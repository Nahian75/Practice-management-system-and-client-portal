import { Logger } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

const MAX_POOL_CONNECTIONS = 10;

// A DATE stays a 'YYYY-MM-DD' string. pg would otherwise turn it into a Date at
// local midnight, which moves a date of birth by a day in some time zones.
const types: pg.CustomTypesConfig = {
  getTypeParser: (oid: number, format?: 'text' | 'binary') =>
    oid === pg.types.builtins.DATE && format !== 'binary'
      ? (value: string) => value
      : pg.types.getTypeParser(oid, format),
};

export function createDatabase<Schema>(connectionString: string, maxConnections = MAX_POOL_CONNECTIONS): Kysely<Schema> {
  const pool = new pg.Pool({ connectionString, max: maxConnections, types, connectionTimeoutMillis: 3000 });

  // An idle connection can drop (database restart, network blip). Without a
  // listener, pg rethrows that error and the whole process exits.
  pool.on('error', (error) => {
    new Logger('Database').error(`Idle connection error: ${error.message}`);
  });

  return new Kysely<Schema>({ dialect: new PostgresDialect({ pool }) });
}
