import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/schema.js';

export interface NewInvitation {
  accountId: string;
  tokenHash: Buffer;
  createdAt: Date;
  expiresAt: Date;
  createdBy: string | null;
}

@Injectable()
export class InvitationsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  /** Closes any open invitation for the account and stores the new one, in one transaction. */
  async replaceOpen(invitation: NewInvitation): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('invitations')
        .set({ closed_at: invitation.createdAt, close_reason: 'replaced' })
        .where('account_id', '=', invitation.accountId)
        .where('closed_at', 'is', null)
        .execute();
      await trx
        .insertInto('invitations')
        .values({
          account_id: invitation.accountId,
          token_hash: invitation.tokenHash,
          created_at: invitation.createdAt,
          expires_at: invitation.expiresAt,
          created_by: invitation.createdBy,
        })
        .execute();
    });
  }

  /** The open invitation for a token, with the account it belongs to. Expiry is checked by the caller. */
  findOpenByTokenHash(tokenHash: Buffer) {
    return this.db
      .selectFrom('invitations')
      .innerJoin('accounts', 'accounts.id', 'invitations.account_id')
      .select([
        'invitations.id',
        'invitations.expires_at',
        'accounts.id as account_id',
        'accounts.kind as account_kind',
        'accounts.email as account_email',
        'accounts.display_name as account_display_name',
        'accounts.status as account_status',
      ])
      .where('invitations.token_hash', '=', tokenHash)
      .where('invitations.closed_at', 'is', null)
      .executeTakeFirst();
  }

  async close(invitationId: string, at: Date, executor: Kysely<Database> = this.db): Promise<boolean> {
    const result = await executor
      .updateTable('invitations')
      .set({ closed_at: at, close_reason: 'accepted' })
      .where('id', '=', invitationId)
      .where('closed_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  /** Runs `work` in a transaction, for changes that must commit together. */
  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }
}
