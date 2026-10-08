import type { ColumnType } from 'kysely';

// One interface per table, kept in step with the SQL in /migrations.
// ColumnType<Select, Insert, Update>: `never` means the app may not write it.

type DatabaseSet<T> = ColumnType<T, never, never>;
type InsertOnly<T> = ColumnType<T, T, never>;
type InsertWithDefault<T> = ColumnType<T, T | undefined, never>;
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

export type EmailKind =
  | 'account_invitation'
  | 'password_reset'
  | 'security_notice'
  | 'task_assignment'
  | 'task_reminder';
export type EmailOutboxStatus = 'pending' | 'sent' | 'discarded' | 'failed';
export type EmailFailureClass =
  | 'temporary'
  | 'malformed'
  | 'invalid_payload'
  | 'provider_rejected'
  | 'delivery_expired';

export interface EmailOutboxTable {
  id: DatabaseSet<string>;
  kind: InsertOnly<EmailKind>;
  recipient_account_id: InsertOnly<string | null>;
  resource_type: InsertOnly<string | null>;
  resource_id: InsertOnly<string | null>;
  deduplication_key: InsertOnly<string | null>;
  key_version: ColumnType<number | null, number, never>;
  nonce: ColumnType<Buffer | null, Buffer, never>;
  ciphertext: ColumnType<Buffer | null, Buffer, never>;
  auth_tag: ColumnType<Buffer | null, Buffer, never>;
  status: DatabaseSet<EmailOutboxStatus>;
  queued_at: DatabaseSet<Date>;
  not_before: InsertWithDefault<Date>;
  expires_at: DatabaseSet<Date>;
  discard_after: InsertOnly<Date | null>;
  attempt_count: DatabaseSet<number>;
  lease_id: DatabaseSet<string | null>;
  leased_until: DatabaseSet<Date | null>;
  completed_at: DatabaseSet<Date | null>;
  failure_class: DatabaseSet<EmailFailureClass | null>;
}

export interface EmailOutboxChangesTable {
  id: DatabaseSet<string>;
  email_outbox_id: DatabaseSet<string>;
  action: DatabaseSet<'claimed' | 'retry' | 'sent' | 'discarded' | 'failed'>;
  lease_id: DatabaseSet<string>;
  retry_seconds: DatabaseSet<number | null>;
  failure_class: DatabaseSet<EmailFailureClass | null>;
  changed_at: DatabaseSet<Date>;
}

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
  title: Writable<string>;
  matter_type: Writable<MatterType>;
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
  removed_by: UpdateOnly<string | null>;
  removed_at: UpdateOnly<Date | null>;
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

export interface MatterSupervisionTakeoversTable {
  id: DatabaseSet<string>;
  matter_id: InsertOnly<string>;
  from_account_id: InsertOnly<string>;
  to_account_id: InsertOnly<string>;
  reason: InsertOnly<string>;
  taken_at: DatabaseSet<Date>;
}

export interface MatterClosuresTable {
  id: DatabaseSet<string>;
  matter_id: InsertOnly<string>;
  closed_by: InsertOnly<string>;
  reason: InsertOnly<string>;
  closed_at: DatabaseSet<Date>;
}

export interface MatterComplianceAccessesTable {
  id: DatabaseSet<string>;
  matter_id: InsertOnly<string>;
  accessed_by: InsertOnly<string>;
  reason: InsertOnly<string>;
  accessed_at: DatabaseSet<Date>;
}

export type DocumentCategory = 'correspondence' | 'contract' | 'evidence' | 'identity' | 'court' | 'other';
export type DocumentMediaType =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  | 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  | 'text/plain'
  | 'image/jpeg'
  | 'image/png'
  | 'message/rfc822';

export interface DocumentsTable {
  id: DatabaseSet<string>;
  matter_id: InsertOnly<string>;
  title: InsertOnly<string>;
  category: InsertOnly<DocumentCategory>;
  created_by: InsertOnly<string>;
  created_at: DatabaseSet<Date>;
  /** Changed only by inserting a document_sharing_changes row. */
  shared_with_client: DatabaseSet<boolean>;
}

export interface DocumentVersionsTable {
  id: DatabaseSet<string>;
  document_id: InsertOnly<string>;
  /** Set by the database: the next number for this document. */
  number: DatabaseSet<number>;
  file_name: InsertOnly<string>;
  media_type: InsertOnly<DocumentMediaType>;
  size_bytes: InsertOnly<number>;
  sha256: InsertOnly<Buffer>;
  storage_key: InsertOnly<string>;
  key_version: InsertOnly<number>;
  key_nonce: InsertOnly<Buffer>;
  wrapped_key: InsertOnly<Buffer>;
  key_tag: InsertOnly<Buffer>;
  uploaded_by: InsertOnly<string>;
  uploaded_at: DatabaseSet<Date>;
}

export interface DocumentWithdrawalsTable {
  id: DatabaseSet<string>;
  document_id: InsertOnly<string>;
  withdrawn_by: InsertOnly<string>;
  reason: InsertOnly<string>;
  withdrawn_at: DatabaseSet<Date>;
}

export interface DocumentSharingChangesTable {
  id: DatabaseSet<string>;
  document_id: InsertOnly<string>;
  shared: InsertOnly<boolean>;
  changed_by: InsertOnly<string>;
  changed_at: DatabaseSet<Date>;
}

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskStatus = 'open' | 'completed' | 'cancelled';

export interface TasksTable {
  id: DatabaseSet<string>;
  matter_id: InsertOnly<string>;
  title: InsertOnly<string>;
  description: InsertOnly<string | null>;
  /** A date column arrives as a string (YYYY-MM-DD), so no time zone can shift it. */
  due_on: InsertOnly<string | null>;
  priority: InsertOnly<TaskPriority>;
  status: DatabaseSet<TaskStatus>;
  assigned_to: InsertOnly<string>;
  created_by: InsertOnly<string>;
  created_at: DatabaseSet<Date>;
}

export type TaskChangeKind = 'details' | 'assignment' | 'status';

export interface TaskChangesTable {
  id: DatabaseSet<string>;
  task_id: InsertOnly<string>;
  kind: InsertOnly<TaskChangeKind>;
  from_title: DatabaseSet<string | null>;
  to_title: InsertOnly<string | null>;
  from_description: DatabaseSet<string | null>;
  to_description: InsertOnly<string | null>;
  from_due_on: DatabaseSet<string | null>;
  to_due_on: InsertOnly<string | null>;
  from_priority: DatabaseSet<TaskPriority | null>;
  to_priority: InsertOnly<TaskPriority | null>;
  from_assigned_to: DatabaseSet<string | null>;
  to_assigned_to: InsertOnly<string | null>;
  from_status: DatabaseSet<TaskStatus | null>;
  to_status: InsertOnly<TaskStatus | null>;
  changed_by: InsertOnly<string>;
  changed_at: DatabaseSet<Date>;
}

export type NotificationKind =
  | 'task_assigned'
  | 'task_unassigned'
  | 'task_completed'
  | 'task_cancelled'
  | 'task_reopened'
  | 'task_due_soon'
  | 'task_due_today'
  | 'task_overdue';

export interface NotificationsTable {
  id: DatabaseSet<string>;
  recipient_id: InsertOnly<string>;
  kind: InsertOnly<NotificationKind>;
  task_id: InsertOnly<string>;
  deduplication_key: InsertOnly<string>;
  created_at: DatabaseSet<Date>;
  /** Set once by inserting the immutable notification_reads record. */
  read_at: DatabaseSet<Date | null>;
}

export interface NotificationReadsTable {
  notification_id: InsertOnly<string>;
  recipient_id: InsertOnly<string>;
  read_at: DatabaseSet<Date>;
}

export interface StaffRatesTable {
  id: DatabaseSet<string>;
  account_id: InsertOnly<string>;
  hourly_rate_pence: InsertOnly<string>;
  effective_from: InsertOnly<string>;
  created_by: InsertOnly<string>;
  created_at: DatabaseSet<Date>;
}

export interface TimeEntriesTable {
  id: DatabaseSet<string>;
  matter_id: InsertOnly<string>;
  worker_id: InsertOnly<string>;
  worked_on: InsertOnly<string>;
  minutes: InsertOnly<number>;
  description: InsertOnly<string>;
  hourly_rate_pence: DatabaseSet<string>;
  voided: DatabaseSet<boolean>;
  recorded_by: InsertOnly<string>;
  recorded_at: DatabaseSet<Date>;
}

export interface TimeEntryCorrectionsTable {
  id: DatabaseSet<string>;
  time_entry_id: InsertOnly<string>;
  from_worked_on: DatabaseSet<string>;
  to_worked_on: InsertOnly<string | null>;
  from_minutes: DatabaseSet<number>;
  to_minutes: InsertOnly<number | null>;
  from_description: DatabaseSet<string>;
  to_description: InsertOnly<string | null>;
  from_hourly_rate_pence: DatabaseSet<string>;
  to_hourly_rate_pence: DatabaseSet<string | null>;
  reason: InsertOnly<string>;
  corrected_by: InsertOnly<string>;
  corrected_at: DatabaseSet<Date>;
}

export interface BillDraftsTable {
  id: DatabaseSet<string>;
  matter_id: DatabaseSet<string>;
  tax_point: DatabaseSet<string>;
  due_on: DatabaseSet<string>;
  supplier_name: DatabaseSet<string>;
  supplier_address_line1: DatabaseSet<string>;
  supplier_address_line2: DatabaseSet<string | null>;
  supplier_town: DatabaseSet<string>;
  supplier_postcode: DatabaseSet<string | null>;
  supplier_country: DatabaseSet<string>;
  supplier_vat_registration_number: DatabaseSet<string | null>;
  created_by: DatabaseSet<string>;
  created_at: DatabaseSet<Date>;
  updated_by: DatabaseSet<string>;
  updated_at: DatabaseSet<Date>;
}

export interface BillDraftLinesTable {
  id: DatabaseSet<string>;
  draft_id: DatabaseSet<string>;
  position: DatabaseSet<number>;
  kind: DatabaseSet<'fee' | 'recharge' | 'disbursement'>;
  description: DatabaseSet<string>;
  net_pence: DatabaseSet<string>;
  vat_treatment: DatabaseSet<'standard' | 'reduced' | 'zero' | 'exempt' | 'outside_scope'>;
  time_entry_id: DatabaseSet<string | null>;
}

export interface IssuedBillsTable {
  id: DatabaseSet<string>;
  draft_id: DatabaseSet<string>;
  number: DatabaseSet<string>;
  reference: DatabaseSet<string>;
  matter_id: DatabaseSet<string>;
  client_id: DatabaseSet<string>;
  matter_reference: DatabaseSet<string>;
  client_reference: DatabaseSet<string>;
  client_name: DatabaseSet<string>;
  client_address_line1: DatabaseSet<string>;
  client_address_line2: DatabaseSet<string | null>;
  client_town: DatabaseSet<string>;
  client_postcode: DatabaseSet<string | null>;
  client_country: DatabaseSet<string>;
  supplier_name: DatabaseSet<string>;
  supplier_address_line1: DatabaseSet<string>;
  supplier_address_line2: DatabaseSet<string | null>;
  supplier_town: DatabaseSet<string>;
  supplier_postcode: DatabaseSet<string | null>;
  supplier_country: DatabaseSet<string>;
  supplier_vat_registration_number: DatabaseSet<string | null>;
  tax_point: DatabaseSet<string>;
  due_on: DatabaseSet<string>;
  net_pence: DatabaseSet<string>;
  vat_pence: DatabaseSet<string>;
  gross_pence: DatabaseSet<string>;
  issued_by: DatabaseSet<string>;
  issued_on: DatabaseSet<string>;
  issued_at: DatabaseSet<Date>;
}

export interface IssuedBillLinesTable {
  id: DatabaseSet<string>;
  bill_id: DatabaseSet<string>;
  position: DatabaseSet<number>;
  kind: DatabaseSet<'fee' | 'recharge' | 'disbursement'>;
  description: DatabaseSet<string>;
  net_pence: DatabaseSet<string>;
  vat_treatment: DatabaseSet<'standard' | 'reduced' | 'zero' | 'exempt' | 'outside_scope'>;
  vat_rate_percent: DatabaseSet<number>;
  vat_pence: DatabaseSet<string>;
  gross_pence: DatabaseSet<string>;
  source_time_entry_id: DatabaseSet<string | null>;
  time_worker_name: DatabaseSet<string | null>;
  time_worked_on: DatabaseSet<string | null>;
  time_minutes: DatabaseSet<number | null>;
  time_hourly_rate_pence: DatabaseSet<string | null>;
}

export interface CreditNotesTable {
  id: DatabaseSet<string>;
  number: DatabaseSet<string>;
  reference: DatabaseSet<string>;
  bill_id: DatabaseSet<string>;
  reason: DatabaseSet<string>;
  net_pence: DatabaseSet<string>;
  vat_pence: DatabaseSet<string>;
  gross_pence: DatabaseSet<string>;
  issued_by: DatabaseSet<string>;
  issued_on: DatabaseSet<string>;
  issued_at: DatabaseSet<Date>;
}

export interface CreditNoteLinesTable {
  id: DatabaseSet<string>;
  credit_note_id: DatabaseSet<string>;
  position: DatabaseSet<number>;
  bill_line_id: DatabaseSet<string>;
  net_pence: DatabaseSet<string>;
  vat_pence: DatabaseSet<string>;
  gross_pence: DatabaseSet<string>;
}

export interface BillDeliveriesTable {
  id: DatabaseSet<string>;
  bill_id: DatabaseSet<string | null>;
  credit_note_id: DatabaseSet<string | null>;
  document_type: DatabaseSet<'bill' | 'credit_note'>;
  method: DatabaseSet<'email' | 'post' | 'hand' | 'other'>;
  note: DatabaseSet<string | null>;
  delivered_by: DatabaseSet<string>;
  delivered_at: DatabaseSet<Date>;
}

export interface PortalLinksTable {
  id: DatabaseSet<string>;
  account_id: InsertOnly<string>;
  client_id: InsertOnly<string>;
  contact_id: InsertOnly<string | null>;
  linked_by: InsertOnly<string>;
  linked_at: DatabaseSet<Date>;
  ended_by: UpdateOnly<string | null>;
  ended_at: UpdateOnly<Date | null>;
}

export interface Database {
  account_roles: AccountRolesTable;
  accounts: AccountsTable;
  audit_events: AuditEventsTable;
  backup_codes: BackupCodesTable;
  bill_deliveries: BillDeliveriesTable;
  bill_draft_lines: BillDraftLinesTable;
  bill_drafts: BillDraftsTable;
  client_contacts: ClientContactsTable;
  client_individuals: ClientIndividualsTable;
  client_organisations: ClientOrganisationsTable;
  client_responsibility_changes: ClientResponsibilityChangesTable;
  conflict_checks: ConflictChecksTable;
  conflict_clearances: ConflictClearancesTable;
  credit_note_lines: CreditNoteLinesTable;
  credit_notes: CreditNotesTable;
  clients: ClientsTable;
  document_versions: DocumentVersionsTable;
  document_sharing_changes: DocumentSharingChangesTable;
  document_withdrawals: DocumentWithdrawalsTable;
  documents: DocumentsTable;
  email_outbox: EmailOutboxTable;
  email_outbox_changes: EmailOutboxChangesTable;
  invitations: InvitationsTable;
  issued_bill_lines: IssuedBillLinesTable;
  issued_bills: IssuedBillsTable;
  matter_closures: MatterClosuresTable;
  matter_compliance_accesses: MatterComplianceAccessesTable;
  matter_parties: MatterPartiesTable;
  matter_supervision_takeovers: MatterSupervisionTakeoversTable;
  matter_team: MatterTeamTable;
  matters: MattersTable;
  notification_reads: NotificationReadsTable;
  notifications: NotificationsTable;
  password_resets: PasswordResetsTable;
  portal_links: PortalLinksTable;
  sessions: SessionsTable;
  sign_in_failures: SignInFailuresTable;
  staff_rates: StaffRatesTable;
  task_changes: TaskChangesTable;
  tasks: TasksTable;
  time_entries: TimeEntriesTable;
  time_entry_corrections: TimeEntryCorrectionsTable;
  totp_credentials: TotpCredentialsTable;
}
