import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/schema.js';

@Injectable()
export class AccountsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  /** `email` must already be normalised (trimmed, lower case). */
  findForSignIn(email: string) {
    return this.db
      .selectFrom('accounts')
      .select(['id', 'kind', 'status', 'password_hash'])
      .where('email', '=', email)
      .executeTakeFirst();
  }

  async replacePasswordHash(accountId: string, passwordHash: string): Promise<void> {
    await this.db.updateTable('accounts').set({ password_hash: passwordHash }).where('id', '=', accountId).execute();
  }
}
