import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module.js';
import type { Database, SignInFailureReason } from '../../database/schema.js';

@Injectable()
export class SignInFailuresRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async record(
    accountId: string | null,
    reason: SignInFailureReason,
    ipAddress: string | undefined,
    at: Date,
  ): Promise<void> {
    await this.db
      .insertInto('sign_in_failures')
      .values({ account_id: accountId, reason, ip_address: ipAddress ?? null, occurred_at: at })
      .execute();
  }

  /**
   * Wrong passwords for the account since `since`, ignoring any made before
   * the account last completed a full sign-in.
   */
  async countWrongPasswordsSince(accountId: string, since: Date): Promise<number> {
    const { count } = await this.db
      .selectFrom('sign_in_failures')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('account_id', '=', accountId)
      .where('reason', '=', 'wrong_password')
      .where('occurred_at', '>', since)
      .where(
        'occurred_at',
        '>',
        sql<Date>`coalesce((
          select max(authenticated_at) from sessions where account_id = ${accountId}
        ), '-infinity')`,
      )
      .executeTakeFirstOrThrow();
    return Number(count);
  }
}
