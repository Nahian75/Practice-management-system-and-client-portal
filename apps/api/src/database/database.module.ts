import { Inject, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { createDatabase } from './database.js';
import type { Database } from './schema.js';

export const DATABASE = Symbol('DATABASE');

@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [ENV],
      useFactory: (env: Env) => createDatabase<Database>(env.DATABASE_URL),
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async onModuleInit(): Promise<void> {
    // Fail at startup, not on the first request, if the database is unreachable
    // or the credentials are wrong.
    await sql`select 1`.execute(this.db);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
