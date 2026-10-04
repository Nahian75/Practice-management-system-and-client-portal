import { Inject, Injectable } from '@nestjs/common';
import { sql, type Insertable, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { AuditEventsTable, Database } from '../database/schema.js';

@Injectable()
export class AuditRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async insert(row: Insertable<AuditEventsTable>, executor: Kysely<Database> = this.db): Promise<void> {
    await executor.insertInto('audit_events').values(row).execute();
  }

  /** Events with this action by this actor in the last `seconds`, by the database's clock. */
  async countRecent(
    query: { actorId: string; action: string; seconds: number },
    executor: Kysely<Database> = this.db,
  ): Promise<number> {
    const { count } = await executor
      .selectFrom('audit_events')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('actor_id', '=', query.actorId)
      .where('action', '=', query.action)
      .where('occurred_at', '>', sql<Date>`clock_timestamp() - make_interval(secs => ${query.seconds})`)
      .executeTakeFirstOrThrow();
    return Number(count);
  }
}
