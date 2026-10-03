import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/schema.js';

@Injectable()
export class BackupCodesRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  /** Retires every unspent code for the account and stores the new set, in one transaction. */
  async replaceAll(accountId: string, codeHashes: Buffer[], at: Date): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('backup_codes')
        .set({ spent_at: at, spent_reason: 'replaced' })
        .where('account_id', '=', accountId)
        .where('spent_at', 'is', null)
        .execute();
      await trx
        .insertInto('backup_codes')
        .values(codeHashes.map((code_hash) => ({ account_id: accountId, code_hash, created_at: at })))
        .execute();
    });
  }

  /**
   * Spends a matching unspent code. Atomic: two requests with the same code at
   * the same moment cannot both succeed.
   */
  async spend(accountId: string, codeHash: Buffer, at: Date): Promise<boolean> {
    const result = await this.db
      .updateTable('backup_codes')
      .set({ spent_at: at, spent_reason: 'used' })
      .where('account_id', '=', accountId)
      .where('code_hash', '=', codeHash)
      .where('spent_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async countUnspent(accountId: string): Promise<number> {
    const { count } = await this.db
      .selectFrom('backup_codes')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('account_id', '=', accountId)
      .where('spent_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(count);
  }
}
