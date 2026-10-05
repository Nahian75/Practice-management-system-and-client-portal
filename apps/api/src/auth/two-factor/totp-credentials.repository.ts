import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { SealedSecret } from '../../common/crypto/secret-box.js';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/schema.js';

export interface StoredTotpCredential {
  sealed: SealedSecret;
  confirmed: boolean;
  // bigint in PostgreSQL arrives as a string; time steps fit safely in a JS number.
  lastUsedStep: number | null;
}

@Injectable()
export class TotpCredentialsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async find(accountId: string): Promise<StoredTotpCredential | undefined> {
    const row = await this.db
      .selectFrom('totp_credentials')
      .selectAll()
      .where('account_id', '=', accountId)
      .executeTakeFirst();

    return (
      row && {
        sealed: { keyVersion: row.key_version, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag },
        confirmed: row.confirmed_at !== null,
        lastUsedStep: row.last_used_step === null ? null : Number(row.last_used_step),
      }
    );
  }

  /**
   * Stores a new, unconfirmed secret, replacing an earlier unconfirmed one.
   * Returns false when the account already has a confirmed secret.
   */
  async storePending(accountId: string, sealed: SealedSecret, at: Date): Promise<boolean> {
    const values = {
      key_version: sealed.keyVersion,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      auth_tag: sealed.authTag,
      created_at: at,
      confirmed_at: null,
      last_used_step: null,
    };
    const result = await this.db
      .insertInto('totp_credentials')
      .values({ account_id: accountId, ...values })
      .onConflict((conflict) => conflict.column('account_id').doUpdateSet(values).where('totp_credentials.confirmed_at', 'is', null))
      .executeTakeFirst();
    return result.numInsertedOrUpdatedRows === 1n;
  }

  async confirm(accountId: string, step: number, at: Date): Promise<boolean> {
    const result = await this.db
      .updateTable('totp_credentials')
      .set({ confirmed_at: at, last_used_step: step })
      .where('account_id', '=', accountId)
      .where('confirmed_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  /**
   * Records that a code for `step` was used. Atomic: when two requests carry
   * the same code at the same moment, only one of them succeeds.
   */
  async markStepUsed(accountId: string, step: number): Promise<boolean> {
    const result = await this.db
      .updateTable('totp_credentials')
      .set({ last_used_step: step })
      .where('account_id', '=', accountId)
      .where('confirmed_at', 'is not', null)
      .where((eb) => eb.or([eb('last_used_step', 'is', null), eb('last_used_step', '<', String(step))]))
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }
}
