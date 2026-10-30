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
      useFactory: (env: Env) => createDatabase<Database>(env.DATABASE_URL,env.DATABASE_POOL_MAX??10),
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>,@Inject(ENV)private readonly env:Env) {}

  async onModuleInit(): Promise<void> {
    // Fail at startup, not on the first request, if the database is unreachable
    // or the credentials are wrong.
    await sql`select 1`.execute(this.db);
    if(this.env.DATABASE_CONNECTION_BUDGET!==undefined){
      const {rows:[capacity]}=await sql<{maximum:number}>`SELECT current_setting('max_connections')::int AS maximum`.execute(this.db);
      if(this.env.DATABASE_CONNECTION_BUDGET>capacity!.maximum)throw new Error('Configured database connection budget exceeds server capacity');
      const {rows:[role]}=await sql<{limit:number}>`SELECT rolconnlimit AS limit FROM pg_roles WHERE rolname=current_user`.execute(this.db);
      if(role&&role.limit>=0&&(this.env.DATABASE_POOL_MAX??10)*(this.env.DATABASE_REPLICA_LIMIT??1)>role.limit)throw new Error('Replica pools exceed the database role connection limit');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
