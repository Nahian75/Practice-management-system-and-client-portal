import type { ColumnType } from 'kysely';

// One interface per table, kept in step with the SQL in /migrations.
// ColumnType<Select, Insert, Update>: `never` means the app may not write it.

type DatabaseSet<T> = ColumnType<T, never, never>;
type InsertOnly<T> = ColumnType<T, T, never>;
type Writable<T> = ColumnType<T, T, T>;
type WritableWithDefault<T> = ColumnType<T, T | undefined, T>;
type UpdateOnly<T> = ColumnType<T, never, T>;

export type AccountKind = 'staff' | 'client';
export type AccountStatus = 'invited' | 'active' | 'disabled';

export interface AccountsTable {
  id: DatabaseSet<string>;
  kind: InsertOnly<AccountKind>;
  email: InsertOnly<string>;
  display_name: Writable<string>;
  status: WritableWithDefault<AccountStatus>;
  password_hash: Writable<string | null>;
  password_changed_at: Writable<Date | null>;
  created_at: DatabaseSet<Date>;
}

export interface AuditEventsTable {
  id: DatabaseSet<string>;
  occurred_at: DatabaseSet<Date>;
  actor_type: InsertOnly<'user' | 'client' | 'system' | 'anonymous'>;
  actor_id: InsertOnly<string | null>;
  action: InsertOnly<string>;
  outcome: InsertOnly<'success' | 'denied' | 'failure'>;
  resource_type: InsertOnly<string | null>;
  resource_id: InsertOnly<string | null>;
  ip_address: InsertOnly<string | null>;
  user_agent: InsertOnly<string | null>;
  metadata: InsertOnly<Record<string, AuditMetadataValue>>;
}

export type AuditMetadataValue = string | number | boolean | null;

export type SessionStage = 'two_factor_pending' | 'authenticated';
export type SessionEndReason = 'signed_out' | 'expired' | 'revoked';

export interface SessionsTable {
  id: DatabaseSet<string>;
  account_id: InsertOnly<string>;
  token_hash: InsertOnly<Buffer>;
  stage: Writable<SessionStage>;
  created_at: DatabaseSet<Date>;
  authenticated_at: Writable<Date | null>;
  last_seen_at: Writable<Date>;
  expires_at: Writable<Date>;
  ended_at: UpdateOnly<Date | null>;
  end_reason: UpdateOnly<SessionEndReason | null>;
  ip_address: InsertOnly<string | null>;
  user_agent: InsertOnly<string | null>;
}

export type SignInFailureReason = 'unknown_account' | 'wrong_password' | 'account_not_active';

export interface SignInFailuresTable {
  id: DatabaseSet<string>;
  account_id: InsertOnly<string | null>;
  reason: InsertOnly<SignInFailureReason>;
  ip_address: InsertOnly<string | null>;
  occurred_at: InsertOnly<Date>;
}

export interface TotpCredentialsTable {
  account_id: InsertOnly<string>;
  key_version: Writable<number>;
  nonce: Writable<Buffer>;
  ciphertext: Writable<Buffer>;
  auth_tag: Writable<Buffer>;
  created_at: Writable<Date>;
  confirmed_at: Writable<Date | null>;
  last_used_step: ColumnType<string | null, number | null, number | null>;
}

export interface Database {
  accounts: AccountsTable;
  audit_events: AuditEventsTable;
  sessions: SessionsTable;
  sign_in_failures: SignInFailuresTable;
  totp_credentials: TotpCredentialsTable;
}
