import { Inject, Injectable } from '@nestjs/common';
import type { Insertable, Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module.js';
import type { Database, SessionEndReason, SessionsTable } from '../../database/schema.js';

@Injectable()
export class SessionsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async insert(row: Insertable<SessionsTable>): Promise<string> {
    const { id } = await this.db.insertInto('sessions').values(row).returning('id').executeTakeFirstOrThrow();
    return id;
  }

  /** Open sessions only, joined with the account they belong to. */
  findOpenByTokenHash(tokenHash: Buffer) {
    return this.db
      .selectFrom('sessions')
      .innerJoin('accounts', 'accounts.id', 'sessions.account_id')
      .select([
        'sessions.id',
        'sessions.stage',
        'sessions.last_seen_at',
        'sessions.expires_at',
        'accounts.id as account_id',
        'accounts.kind as account_kind',
        'accounts.status as account_status',
        'accounts.display_name as account_display_name',
      ])
      .where('sessions.token_hash', '=', tokenHash)
      .where('sessions.ended_at', 'is', null)
      .executeTakeFirst();
  }

  async touch(sessionId: string, at: Date): Promise<void> {
    await this.db.updateTable('sessions').set({ last_seen_at: at }).where('id', '=', sessionId).execute();
  }

  async endAllForAccount(accountId: string, reason: SessionEndReason, at: Date): Promise<number> {
    const result = await this.db
      .updateTable('sessions')
      .set({ ended_at: at, end_reason: reason })
      .where('account_id', '=', accountId)
      .where('ended_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async end(sessionId: string, reason: SessionEndReason, at: Date, executor: Kysely<Database> = this.db): Promise<void> {
    await executor
      .updateTable('sessions')
      .set({ ended_at: at, end_reason: reason })
      .where('id', '=', sessionId)
      .where('ended_at', 'is', null)
      .execute();
  }
}
