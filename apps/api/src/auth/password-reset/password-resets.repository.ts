import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/schema.js';

export interface NewPasswordReset {
  accountId: string;
  tokenHash: Buffer;
  createdAt: Date;
  expiresAt: Date;
  requestedIp: string | undefined;
}

@Injectable()
export class PasswordResetsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  /** Closes any open reset for the account and stores the new one, in one transaction. */
  async replaceOpen(reset: NewPasswordReset): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('password_resets')
        .set({ closed_at: reset.createdAt, close_reason: 'replaced' })
        .where('account_id', '=', reset.accountId)
        .where('closed_at', 'is', null)
        .execute();
      await trx
        .insertInto('password_resets')
        .values({
          account_id: reset.accountId,
          token_hash: reset.tokenHash,
          created_at: reset.createdAt,
          expires_at: reset.expiresAt,
          requested_ip: reset.requestedIp ?? null,
        })
        .execute();
    });
  }

  async countRequestedSince(accountId: string, since: Date): Promise<number> {
    const { count } = await this.db
      .selectFrom('password_resets')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('account_id', '=', accountId)
      .where('created_at', '>', since)
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  /** The open reset for a token, with its account. Expiry is checked by the caller. */
  findOpenByTokenHash(tokenHash: Buffer) {
    return this.db
      .selectFrom('password_resets')
      .innerJoin('accounts', 'accounts.id', 'password_resets.account_id')
      .select([
        'password_resets.id',
        'password_resets.expires_at',
        'accounts.id as account_id',
        'accounts.kind as account_kind',
        'accounts.email as account_email',
        'accounts.status as account_status',
      ])
      .where('password_resets.token_hash', '=', tokenHash)
      .where('password_resets.closed_at', 'is', null)
      .executeTakeFirst();
  }

  /** Atomic: of two requests using the same token at once, only one succeeds. */
  async close(resetId: string, at: Date): Promise<boolean> {
    const result = await this.db
      .updateTable('password_resets')
      .set({ closed_at: at, close_reason: 'used' })
      .where('id', '=', resetId)
      .where('closed_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }
}
