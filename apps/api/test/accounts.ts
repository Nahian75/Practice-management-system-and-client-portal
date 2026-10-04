import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { AccountKind, AccountStatus, Database, StaffRole } from '../src/database/schema.js';

// A well-formed Argon2id string. Tests that need a real, verifiable password hash it themselves.
const PLACEHOLDER_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g';

export interface TestAccount {
  id: string;
  kind: AccountKind;
  email: string;
}

export async function createTestAccount(
  db: Kysely<Database>,
  kind: AccountKind,
  options: { status?: AccountStatus; passwordHash?: string } = {},
): Promise<TestAccount> {
  const status = options.status ?? 'active';
  const email = `${kind}-${randomUUID()}@example.com`;
  const hasPassword = status === 'active' || options.passwordHash !== undefined;

  const { id } = await db
    .insertInto('accounts')
    .values({
      kind,
      email,
      display_name: `Test ${kind}`,
      status,
      password_hash: hasPassword ? (options.passwordHash ?? PLACEHOLDER_HASH) : null,
      password_changed_at: hasPassword ? new Date() : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { id, kind, email };
}

export async function setAccountStatus(db: Kysely<Database>, accountId: string, status: AccountStatus) {
  await db.updateTable('accounts').set({ status }).where('id', '=', accountId).execute();
}

export async function grantTestRole(db: Kysely<Database>, accountId: string, role: StaffRole): Promise<void> {
  await db.insertInto('account_roles').values({ account_id: accountId, role, granted_by: null, granted_at: new Date() }).execute();
}

export async function revokeTestRole(db: Kysely<Database>, accountId: string, role: StaffRole): Promise<void> {
  await db
    .updateTable('account_roles')
    .set({ revoked_at: new Date() })
    .where('account_id', '=', accountId)
    .where('role', '=', role)
    .where('revoked_at', 'is', null)
    .execute();
}
