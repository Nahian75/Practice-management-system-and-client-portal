import type { ColumnType } from 'kysely';

// One interface per table, kept in step with the SQL in /migrations.
// ColumnType<Select, Insert, Update>: `never` means the app may not write it.

type DatabaseSet<T> = ColumnType<T, never, never>;
type InsertOnly<T> = ColumnType<T, T, never>;
type Writable<T> = ColumnType<T, T, T>;
type WritableWithDefault<T> = ColumnType<T, T | undefined, T>;

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

export interface Database {
  accounts: AccountsTable;
  audit_events: AuditEventsTable;
}
