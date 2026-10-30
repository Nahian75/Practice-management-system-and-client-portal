import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module.js';
import type { AccountKind, Database } from '../../database/schema.js';

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

  /** `email` must already be normalised (trimmed, lower case). */
  findByEmail(email: string) {
    return this.db
      .selectFrom('accounts')
      .select(['id', 'kind', 'email', 'display_name', 'status'])
      .where('email', '=', email)
      .executeTakeFirst();
  }

  findById(accountId: string, executor: Kysely<Database> = this.db) {
    return executor
      .selectFrom('accounts')
      .select(['id', 'kind', 'email', 'display_name', 'status'])
      .where('id', '=', accountId)
      .executeTakeFirst();
  }

  async createInvited(account: { kind: AccountKind; email: string; displayName: string }): Promise<string> {
    const { id } = await this.db
      .insertInto('accounts')
      .values({ kind: account.kind, email: account.email, display_name: account.displayName, status: 'invited' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return id;
  }

  async setPassword(accountId: string, passwordHash: string, at: Date, executor: Kysely<Database> = this.db): Promise<void> {
    await executor
      .updateTable('accounts')
      .set({ password_hash: passwordHash, password_changed_at: at })
      .where('id', '=', accountId)
      .execute();
  }

  async replacePasswordHash(accountId: string, passwordHash: string): Promise<void> {
    await this.db.updateTable('accounts').set({ password_hash: passwordHash }).where('id', '=', accountId).execute();
  }

  /** Only an invited account with a password can be activated. Returns false otherwise. */
  async activate(accountId: string, executor: Kysely<Database> = this.db): Promise<boolean> {
    const result = await executor
      .updateTable('accounts')
      .set({ status: 'active' })
      .where('id', '=', accountId)
      .where('status', '=', 'invited')
      .where('password_hash', 'is not', null)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }
}
