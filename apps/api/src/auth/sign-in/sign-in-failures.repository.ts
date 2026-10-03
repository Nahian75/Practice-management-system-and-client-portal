import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module.js';
import type { Database, SignInFailureReason } from '../../database/schema.js';

/** Failures that mean someone tried a credential for this account and got it wrong. */
const GUESSES: SignInFailureReason[] = ['wrong_password', 'wrong_two_factor_code'];

export interface SignInFailure {
  accountId: string | null;
  reason: SignInFailureReason;
  ipAddress: string | undefined;
  sessionId?: string;
}

@Injectable()
export class SignInFailuresRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async record(failure: SignInFailure, at: Date): Promise<void> {
    await this.db
      .insertInto('sign_in_failures')
      .values({
        account_id: failure.accountId,
        reason: failure.reason,
        session_id: failure.sessionId ?? null,
        ip_address: failure.ipAddress ?? null,
        occurred_at: at,
      })
      .execute();
  }

  /**
   * Wrong passwords and wrong 2FA codes for the account since `since`,
   * ignoring any made before the account last completed a full sign-in.
   */
  async countGuessesSince(accountId: string, since: Date): Promise<number> {
    const { count } = await this.db
      .selectFrom('sign_in_failures')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('account_id', '=', accountId)
      .where('reason', 'in', GUESSES)
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

  /** Every kind of sign-in failure from one network address since `since`, across all accounts. */
  async countForAddressSince(ipAddress: string, since: Date): Promise<number> {
    const { count } = await this.db
      .selectFrom('sign_in_failures')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('ip_address', '=', ipAddress)
      .where('occurred_at', '>', since)
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  async countForSession(sessionId: string): Promise<number> {
    const { count } = await this.db
      .selectFrom('sign_in_failures')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('session_id', '=', sessionId)
      .executeTakeFirstOrThrow();
    return Number(count);
  }
}
