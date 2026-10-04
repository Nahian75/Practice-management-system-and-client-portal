import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { AccountStatus, Database, StaffRole } from '../database/schema.js';

export interface StaffMember {
  id: string;
  email: string;
  displayName: string;
  status: AccountStatus;
  roles: StaffRole[];
}

@Injectable()
export class StaffRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  /** Every staff account, whatever its status, with its active roles. */
  async list(): Promise<StaffMember[]> {
    const accounts = await this.db
      .selectFrom('accounts')
      .select(['id', 'email', 'display_name', 'status'])
      .where('kind', '=', 'staff')
      .orderBy('display_name')
      .orderBy('email')
      .execute();

    const roles = await this.db
      .selectFrom('account_roles')
      .innerJoin('accounts', 'accounts.id', 'account_roles.account_id')
      .select(['account_roles.account_id', 'account_roles.role'])
      .where('accounts.kind', '=', 'staff')
      .where('account_roles.revoked_at', 'is', null)
      .orderBy('account_roles.role')
      .execute();

    const rolesByAccount = new Map<string, StaffRole[]>();
    for (const row of roles) {
      rolesByAccount.set(row.account_id, [...(rolesByAccount.get(row.account_id) ?? []), row.role]);
    }
    return accounts.map((account) => ({
      id: account.id,
      email: account.email,
      displayName: account.display_name,
      status: account.status,
      roles: rolesByAccount.get(account.id) ?? [],
    }));
  }

  /** A staff account by id. Client accounts are not found here. */
  findStaff(accountId: string) {
    return this.db
      .selectFrom('accounts')
      .select(['id', 'status'])
      .where('id', '=', accountId)
      .where('kind', '=', 'staff')
      .executeTakeFirst();
  }

  /** Returns false when the account was already disabled. */
  async disable(accountId: string, executor: Kysely<Database> = this.db): Promise<boolean> {
    const result = await executor
      .updateTable('accounts')
      .set({ status: 'disabled' })
      .where('id', '=', accountId)
      .where('kind', '=', 'staff')
      .where('status', '<>', 'disabled')
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }
}
