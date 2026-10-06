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

  /**
   * The sum of `metadata.units` over events with these actions by this actor
   * in the last `seconds`, counting 1 for an event that records no units.
   */
  async sumUnitsRecent(
    query: { actorId: string; actions: readonly string[]; seconds: number },
    executor: Kysely<Database> = this.db,
  ): Promise<number> {
    const { units } = await executor
      .selectFrom('audit_events')
      .select(sql<string>`coalesce(sum(coalesce((metadata ->> 'units')::integer, 1)), 0)`.as('units'))
      .where('actor_id', '=', query.actorId)
      .where('action', 'in', query.actions)
      .where('occurred_at', '>', sql<Date>`clock_timestamp() - make_interval(secs => ${query.seconds})`)
      .executeTakeFirstOrThrow();
    return Number(units);
  }

  /**
   * How many of these events this actor had in the last `seconds`, and the
   * total of the whole number `field` in their metadata (0 where absent).
   */
  async recentTotals(
    query: { actorId: string; actions: readonly string[]; seconds: number; field: string },
    executor: Kysely<Database> = this.db,
  ): Promise<{ count: number; total: number }> {
    const row = await executor
      .selectFrom('audit_events')
      .select((eb) => [
        eb.fn.countAll<string>().as('count'),
        sql<string>`coalesce(sum(coalesce((metadata ->> ${query.field})::bigint, 0)), 0)`.as('total'),
      ])
      .where('actor_id', '=', query.actorId)
      .where('action', 'in', query.actions)
      .where('occurred_at', '>', sql<Date>`clock_timestamp() - make_interval(secs => ${query.seconds})`)
      .executeTakeFirstOrThrow();
    return { count: Number(row.count), total: Number(row.total) };
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
