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
export type SessionEndReason = 'signed_out' | 'expired' | 'revoked' | 'replaced';

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

export type SignInFailureReason =
  | 'unknown_account'
  | 'wrong_password'
  | 'account_not_active'
  | 'wrong_two_factor_code';

export interface SignInFailuresTable {
  id: DatabaseSet<string>;
  account_id: InsertOnly<string | null>;
  reason: InsertOnly<SignInFailureReason>;
  session_id: InsertOnly<string | null>;
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

export interface BackupCodesTable {
  id: DatabaseSet<string>;
  account_id: InsertOnly<string>;
  code_hash: InsertOnly<Buffer>;
  created_at: InsertOnly<Date>;
  spent_at: UpdateOnly<Date | null>;
  spent_reason: UpdateOnly<'used' | 'replaced' | null>;
}

export interface InvitationsTable {
  id: DatabaseSet<string>;
  account_id: InsertOnly<string>;
  token_hash: InsertOnly<Buffer>;
  created_at: InsertOnly<Date>;
  expires_at: InsertOnly<Date>;
  created_by: InsertOnly<string | null>;
  closed_at: UpdateOnly<Date | null>;
  close_reason: UpdateOnly<'accepted' | 'replaced' | null>;
}

export interface PasswordResetsTable {
  id: DatabaseSet<string>;
  account_id: InsertOnly<string>;
  token_hash: InsertOnly<Buffer>;
  created_at: InsertOnly<Date>;
  expires_at: InsertOnly<Date>;
  requested_ip: InsertOnly<string | null>;
  closed_at: UpdateOnly<Date | null>;
  close_reason: UpdateOnly<'used' | 'replaced' | null>;
}

export type StaffRole = 'administrator' | 'partner' | 'fee_earner' | 'accounts' | 'compliance';

export interface AccountRolesTable {
  id: DatabaseSet<string>;
  account_id: InsertOnly<string>;
  role: InsertOnly<StaffRole>;
  granted_at: InsertOnly<Date>;
  granted_by: InsertOnly<string | null>;
  revoked_at: UpdateOnly<Date | null>;
  revoked_by: UpdateOnly<string | null>;
}


export type ClientKind = 'individual' | 'organisation';
export type ClientStatus = 'active' | 'archived';
export type OrganisationType = 'company' | 'llp' | 'partnership' | 'charity' | 'trust' | 'other';

export interface ClientsTable {
  id: DatabaseSet<string>;
  // bigint arrives as a string, so large values are never rounded.
  number: DatabaseSet<string>;
  reference: DatabaseSet<string>;
  kind: InsertOnly<ClientKind>;
  status: DatabaseSet<ClientStatus>;
  created_by: InsertOnly<string>;
  created_at: DatabaseSet<Date>;
  /** Set by the database: the creator, then changed only through client_responsibility_changes. */
  responsible_id: DatabaseSet<string>;
}

export interface ClientContactsTable {
  id: DatabaseSet<string>;
  client_id: InsertOnly<string>;
  given_names: Writable<string>;
  family_name: Writable<string>;
  job_title: Writable<string | null>;
  email: Writable<string | null>;
  phone: Writable<string | null>;
  active: UpdateOnly<boolean>;
  created_at: DatabaseSet<Date>;
}

export interface ClientResponsibilityChangesTable {
  id: DatabaseSet<string>;
  client_id: InsertOnly<string>;
  from_account_id: InsertOnly<string>;
  to_account_id: InsertOnly<string>;
  reason: InsertOnly<string>;
  changed_at: DatabaseSet<Date>;
}

interface ClientCorrespondenceColumns {
  email: Writable<string | null>;
  phone: Writable<string | null>;
  address_line1: Writable<string | null>;
  address_line2: Writable<string | null>;
  town: Writable<string | null>;
  postcode: Writable<string | null>;
  country: Writable<string | null>;
}

export interface ClientIndividualsTable extends ClientCorrespondenceColumns {
  client_id: InsertOnly<string>;
  title: Writable<string | null>;
  given_names: Writable<string>;
  family_name: Writable<string>;
  // A date column arrives as a string (YYYY-MM-DD), so no time zone can shift it.
  date_of_birth: Writable<string | null>;
}

export interface ClientOrganisationsTable extends ClientCorrespondenceColumns {
  client_id: InsertOnly<string>;
  legal_name: Writable<string>;
  organisation_type: Writable<OrganisationType>;
  registration_number: Writable<string | null>;
}

export type MatterType =
  | 'residential_property'
  | 'commercial_property'
  | 'family'
  | 'litigation'
  | 'employment'
  | 'wills_probate'
  | 'corporate'
  | 'immigration'
  | 'crime'
  | 'other';
export type MatterStatus = 'awaiting_clearance' | 'open' | 'closed';
export type MatterTeamRole = 'supervising_partner' | 'fee_earner';

export interface MattersTable {
  id: DatabaseSet<string>;
  client_id: InsertOnly<string>;
  /** Set by the database: the next number for this client. */
  number: DatabaseSet<number>;
  /** Set by the database: the client's reference and the number, C-000123/001. */
  reference: DatabaseSet<string>;
  title: InsertOnly<string>;
  matter_type: InsertOnly<MatterType>;
  status: DatabaseSet<MatterStatus>;
  opened_by: InsertOnly<string>;
  opened_at: DatabaseSet<Date>;
  /** Required for every matter opened from migration 0017 on. */
  conflict_check_id: InsertOnly<string | null>;
}

export interface MatterTeamTable {
  id: DatabaseSet<string>;
  matter_id: InsertOnly<string>;
  account_id: InsertOnly<string>;
  role: InsertOnly<MatterTeamRole>;
  added_by: InsertOnly<string>;
  added_at: DatabaseSet<Date>;
  removed_by: DatabaseSet<string | null>;
  removed_at: DatabaseSet<Date | null>;
}

export type PartyRole = 'opponent' | 'opponent_solicitor' | 'other';

export interface MatterPartiesTable {
  id: DatabaseSet<string>;
  matter_id: InsertOnly<string>;
  role: InsertOnly<PartyRole>;
  kind: InsertOnly<ClientKind>;
  name: InsertOnly<string>;
  added_by: InsertOnly<string>;
  added_at: DatabaseSet<Date>;
}

/** One possible match, as the database's find_possible_conflicts records it. */
export interface ConflictMatchRow {
  checkedName: string;
  matchedName: string;
  relation: 'client' | 'contact' | 'opponent' | 'opponent_solicitor' | 'other_party';
  clientId: string;
  matterId: string | null;
  score: number;
}

export interface ConflictChecksTable {
  id: DatabaseSet<string>;
  client_id: InsertOnly<string>;
  requested_by: InsertOnly<string>;
  /** As given, with the client's own name added by the database. */
  names: InsertOnly<string[]>;
  /** Found by the database when the check is recorded; the app cannot write it. */
  matches: DatabaseSet<ConflictMatchRow[]>;
  /** How many possible matches were found; `matches` holds the 50 strongest. */
  match_count: DatabaseSet<number>;
  created_at: DatabaseSet<Date>;
}

export interface ConflictClearancesTable {
  id: DatabaseSet<string>;
  matter_id: InsertOnly<string>;
  cleared_by: InsertOnly<string>;
  reason: InsertOnly<string>;
  cleared_at: DatabaseSet<Date>;
}

export interface Database {
  account_roles: AccountRolesTable;
  accounts: AccountsTable;
  audit_events: AuditEventsTable;
  backup_codes: BackupCodesTable;
  client_contacts: ClientContactsTable;
  client_individuals: ClientIndividualsTable;
  client_organisations: ClientOrganisationsTable;
  client_responsibility_changes: ClientResponsibilityChangesTable;
  conflict_checks: ConflictChecksTable;
  conflict_clearances: ConflictClearancesTable;
  clients: ClientsTable;
  invitations: InvitationsTable;
  matter_parties: MatterPartiesTable;
  matter_team: MatterTeamTable;
  matters: MattersTable;
  password_resets: PasswordResetsTable;
  sessions: SessionsTable;
  sign_in_failures: SignInFailuresTable;
  totp_credentials: TotpCredentialsTable;
}
