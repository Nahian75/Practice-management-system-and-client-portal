import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
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
}
