import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module.js';
import type { Database, StaffRole } from '../../database/schema.js';

@Injectable()
export class RolesRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async activeRoles(accountId: string, executor: Kysely<Database> = this.db): Promise<StaffRole[]> {
    const rows = await executor
      .selectFrom('account_roles')
      .select('role')
      .where('account_id', '=', accountId)
      .where('revoked_at', 'is', null)
      .orderBy('role')
      .execute();
    return rows.map((row) => row.role);
  }

  /** Returns false when the account already holds the role. */
  async grant(
    grant: { accountId: string; role: StaffRole; grantedBy: string | null; at: Date },
    executor: Kysely<Database> = this.db,
  ): Promise<boolean> {
    const result = await executor
      .insertInto('account_roles')
      .values({ account_id: grant.accountId, role: grant.role, granted_by: grant.grantedBy, granted_at: grant.at })
      .onConflict((conflict) => conflict.columns(['account_id', 'role']).where('revoked_at', 'is', null).doNothing())
      .executeTakeFirst();
    return result.numInsertedOrUpdatedRows === 1n;
  }

  /** Returns false when the account does not hold the role. */
  async revoke(
    revoke: { accountId: string; role: StaffRole; revokedBy: string | null; at: Date },
    executor: Kysely<Database> = this.db,
  ): Promise<boolean> {
    const result = await executor
      .updateTable('account_roles')
      .set({ revoked_at: revoke.at, revoked_by: revoke.revokedBy })
      .where('account_id', '=', revoke.accountId)
      .where('role', '=', revoke.role)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  /**
   * Serialises every change that could remove a protected role's holder, until
   * the transaction ends. Without it, two administrators removing each other at
   * the same moment would each see the other still there, and both succeed.
   */
  async lockProtectedRoleChanges(trx: Kysely<Database>): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended('app.protected_roles', 0))`.execute(trx);
  }

  /** Active accounts holding `role`, not counting `accountId`. */
  async countOtherActiveHolders(role: StaffRole, accountId: string, executor: Kysely<Database> = this.db): Promise<number> {
    const { count } = await executor
      .selectFrom('account_roles')
      .innerJoin('accounts', 'accounts.id', 'account_roles.account_id')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('account_roles.role', '=', role)
      .where('account_roles.revoked_at', 'is', null)
      .where('accounts.status', '=', 'active')
      .where('accounts.id', '<>', accountId)
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  /** Ids of the active accounts holding `role`. */
  async activeHolders(role: StaffRole): Promise<string[]> {
    const rows = await this.db
      .selectFrom('account_roles')
      .innerJoin('accounts', 'accounts.id', 'account_roles.account_id')
      .select('accounts.id')
      .where('account_roles.role', '=', role)
      .where('account_roles.revoked_at', 'is', null)
      .where('accounts.status', '=', 'active')
      .execute();
    return rows.map((row) => row.id);
  }

  /** Runs `work` in a transaction, for changes that must commit together. */
  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }
}
