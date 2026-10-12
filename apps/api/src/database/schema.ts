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

export type StaffRole = 'administrator' | 'partner' | 'fee_earner' | 'accounts' | 'compliance' | 'hr';

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

export type BankAccountKind = 'client' | 'business';
export type FinanceTransactionKind =
  | 'bill'
  | 'credit_note'
  | 'client_receipt'
  | 'business_receipt'
  | 'client_allocation'
  | 'business_allocation'
  | 'client_payment'
  | 'costs_transfer';
export type FinancePostingAccount =
  | 'client_bank'
  | 'business_bank'
  | 'client_ledger'
  | 'business_ledger'
  | 'business_control';

export interface BankAccountsTable {
  id: DatabaseSet<string>;
  kind: DatabaseSet<BankAccountKind>;
  name: DatabaseSet<string>;
  last_four: DatabaseSet<string>;
  encryption_context: DatabaseSet<string>;
  fingerprint: DatabaseSet<Buffer>;
  key_version: DatabaseSet<number>;
  nonce: DatabaseSet<Buffer>;
  ciphertext: DatabaseSet<Buffer>;
  auth_tag: DatabaseSet<Buffer>;
  opened_on: DatabaseSet<string>;
  created_by: DatabaseSet<string>;
  created_at: DatabaseSet<Date>;
}

export interface BankAccountClosuresTable {
  id: DatabaseSet<string>;
  bank_account_id: DatabaseSet<string>;
  closed_on: DatabaseSet<string>;
  reason: DatabaseSet<string>;
  closed_by: DatabaseSet<string>;
  closed_at: DatabaseSet<Date>;
}

export interface FinanceTransactionsTable {
  id: DatabaseSet<string>;
  kind: DatabaseSet<FinanceTransactionKind>;
  client_id: DatabaseSet<string>;
  matter_id: DatabaseSet<string>;
  related_matter_id: DatabaseSet<string | null>;
  bank_account_id: DatabaseSet<string | null>;
  related_bank_account_id: DatabaseSet<string | null>;
  source_bill_id: DatabaseSet<string | null>;
  source_credit_note_id: DatabaseSet<string | null>;
  source_payment_request_id: DatabaseSet<string | null>;
  reference: DatabaseSet<string | null>;
  purpose: DatabaseSet<string>;
  amount_pence: DatabaseSet<string>;
  occurred_on: DatabaseSet<string>;
  posted_by: DatabaseSet<string>;
  posted_at: DatabaseSet<Date>;
}

export type ClientPaymentKind = 'refund' | 'third_party' | 'costs_transfer';
export type ClientPaymentEventKind = 'approved' | 'rejected' | 'cancelled' | 'paid' | 'bank_rejected';

export interface ClientPaymentRequestsTable {
  id: DatabaseSet<string>;
  kind: DatabaseSet<ClientPaymentKind>;
  client_id: DatabaseSet<string>;
  matter_id: DatabaseSet<string>;
  client_bank_account_id: DatabaseSet<string>;
  business_bank_account_id: DatabaseSet<string | null>;
  bill_id: DatabaseSet<string | null>;
  evidence_document_id: DatabaseSet<string>;
  purpose: DatabaseSet<string>;
  amount_pence: DatabaseSet<string>;
  payee_context: DatabaseSet<string | null>;
  payee_key_version: DatabaseSet<number | null>;
  payee_nonce: DatabaseSet<Buffer | null>;
  payee_ciphertext: DatabaseSet<Buffer | null>;
  payee_auth_tag: DatabaseSet<Buffer | null>;
  requested_by: DatabaseSet<string>;
  requested_at: DatabaseSet<Date>;
}

export interface ClientPaymentEventsTable {
  id: DatabaseSet<string>;
  payment_request_id: DatabaseSet<string>;
  kind: DatabaseSet<ClientPaymentEventKind>;
  reason: DatabaseSet<string | null>;
  bank_reference: DatabaseSet<string | null>;
  occurred_on: DatabaseSet<string | null>;
  finance_transaction_id: DatabaseSet<string | null>;
  acted_by: DatabaseSet<string>;
  acted_at: DatabaseSet<Date>;
}

export interface BankStatementImportsTable {
  id: DatabaseSet<string>;
  bank_account_id: DatabaseSet<string>;
  period_start: DatabaseSet<string>;
  period_end: DatabaseSet<string>;
  opening_balance_pence: DatabaseSet<string>;
  closing_balance_pence: DatabaseSet<string>;
  file_name: DatabaseSet<string>;
  file_hash: DatabaseSet<Buffer>;
  row_count: DatabaseSet<number>;
  imported_by: DatabaseSet<string>;
  imported_at: DatabaseSet<Date>;
}

export interface BankStatementRowsTable {
  id: DatabaseSet<string>;
  statement_import_id: DatabaseSet<string>;
  bank_account_id: DatabaseSet<string>;
  row_number: DatabaseSet<number>;
  occurred_on: DatabaseSet<string>;
  amount_pence: DatabaseSet<string>;
  reference: DatabaseSet<string>;
  description: DatabaseSet<string>;
  row_fingerprint: DatabaseSet<Buffer>;
}

export interface BankStatementMatchEventsTable {
  id: DatabaseSet<string>;
  kind: DatabaseSet<'matched' | 'reversed'>;
  statement_row_id: DatabaseSet<string>;
  finance_transaction_id: DatabaseSet<string | null>;
  reversed_match_id: DatabaseSet<string | null>;
  reason: DatabaseSet<string | null>;
  acted_by: DatabaseSet<string>;
  acted_at: DatabaseSet<Date>;
}

export interface ClientAccountReconciliationsTable {
  id: DatabaseSet<string>;
  as_of: DatabaseSet<string>;
  bank_balance_pence: DatabaseSet<string>;
  cashbook_balance_pence: DatabaseSet<string>;
  client_ledger_balance_pence: DatabaseSet<string>;
  bank_cashbook_difference_pence: DatabaseSet<string>;
  cashbook_client_difference_pence: DatabaseSet<string>;
  prepared_by: DatabaseSet<string>;
  prepared_at: DatabaseSet<Date>;
}

export interface ClientAccountReconciliationStatementsTable {
  reconciliation_id: DatabaseSet<string>;
  statement_import_id: DatabaseSet<string>;
  bank_account_id: DatabaseSet<string>;
}

export interface ClientAccountReconciliationItemsTable {
  id: DatabaseSet<string>;
  reconciliation_id: DatabaseSet<string>;
  kind: DatabaseSet<'unmatched_statement' | 'unmatched_cashbook' | 'difference'>;
  source_key: DatabaseSet<string>;
  bank_account_id: DatabaseSet<string | null>;
  occurred_on: DatabaseSet<string | null>;
  amount_pence: DatabaseSet<string>;
  reference: DatabaseSet<string | null>;
  explanation: DatabaseSet<string>;
}

export interface ClientAccountReconciliationBalancesTable {
  id: DatabaseSet<string>;
  reconciliation_id: DatabaseSet<string>;
  client_id: DatabaseSet<string>;
  matter_id: DatabaseSet<string>;
  balance_pence: DatabaseSet<string>;
}

export interface ClientAccountReconciliationSignOffsTable {
  id: DatabaseSet<string>;
  reconciliation_id: DatabaseSet<string>;
  signed_off_by: DatabaseSet<string>;
  signed_off_at: DatabaseSet<Date>;
}

export interface FinancePostingsTable {
  id: DatabaseSet<string>;
  transaction_id: DatabaseSet<string>;
  position: DatabaseSet<number>;
  account: DatabaseSet<FinancePostingAccount>;
  direction: DatabaseSet<'debit' | 'credit'>;
  amount_pence: DatabaseSet<string>;
  client_id: DatabaseSet<string>;
  matter_id: DatabaseSet<string>;
  bank_account_id: DatabaseSet<string | null>;
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

export type AmlOfficerKind = 'nominated_officer' | 'deputy';
export type AmlControlKind =
  | 'ml_tf_risk_assessment'
  | 'proliferation_financing_risk_assessment'
  | 'sanctions_risk_assessment'
  | 'aml_policy'
  | 'sanctions_policy'
  | 'training_material';

export interface AmlOfficerAppointmentsTable {
  id: DatabaseSet<string>;
  account_id: DatabaseSet<string>;
  kind: DatabaseSet<AmlOfficerKind>;
  appointed_by: DatabaseSet<string>;
  appointed_at: DatabaseSet<Date>;
  ended_by: DatabaseSet<string | null>;
  ended_at: DatabaseSet<Date | null>;
  end_reason: DatabaseSet<string | null>;
}

export interface AmlControlVersionsTable {
  id: DatabaseSet<string>;
  kind: DatabaseSet<AmlControlKind>;
  version: DatabaseSet<number>;
  title: DatabaseSet<string>;
  content: DatabaseSet<string>;
  content_sha256: DatabaseSet<Buffer>;
  source: DatabaseSet<string>;
  effective_from: DatabaseSet<string>;
  review_due_on: DatabaseSet<string>;
  prepared_by: DatabaseSet<string>;
  prepared_at: DatabaseSet<Date>;
}

export interface AmlControlApprovalsTable {
  id: DatabaseSet<string>;
  control_version_id: DatabaseSet<string>;
  approved_by: DatabaseSet<string>;
  approved_at: DatabaseSet<Date>;
}

export interface AmlTrainingCompletionsTable {
  id: DatabaseSet<string>;
  account_id: DatabaseSet<string>;
  training_material_id: DatabaseSet<string>;
  provider: DatabaseSet<string>;
  completed_on: DatabaseSet<string>;
  evidence_reference: DatabaseSet<string>;
  recorded_by: DatabaseSet<string>;
  recorded_at: DatabaseSet<Date>;
}

export interface AmlIndependentReviewsTable {
  id: DatabaseSet<string>;
  period_start: DatabaseSet<string>;
  period_end: DatabaseSet<string>;
  completed_on: DatabaseSet<string>;
  reviewer_name: DatabaseSet<string>;
  reviewer_organisation: DatabaseSet<string | null>;
  independence_basis: DatabaseSet<string>;
  scope: DatabaseSet<string>;
  findings: DatabaseSet<string>;
  recommendations: DatabaseSet<string>;
  management_response: DatabaseSet<string>;
  recorded_by: DatabaseSet<string>;
  recorded_at: DatabaseSet<Date>;
}

export type AmlCddStatus = 'draft' | 'submitted' | 'abandoned';
export type AmlSubjectKind = 'individual' | 'legal_entity';
export type AmlSubjectRelationship = 'client' | 'authorised_representative' | 'director_senior_manager'
  | 'beneficial_owner' | 'trustee' | 'settlor' | 'beneficiary' | 'protector' | 'funder' | 'other_controller';

export interface AmlCddCasesTable {
  id: DatabaseSet<string>; client_id: DatabaseSet<string>; version: DatabaseSet<number>;
  status: DatabaseSet<AmlCddStatus>; intended_relationship: DatabaseSet<string>; reason: DatabaseSet<string>;
  client_snapshot: DatabaseSet<Record<string, unknown> | null>; prepared_by: DatabaseSet<string>;
  created_at: DatabaseSet<Date>; submitted_at: DatabaseSet<Date | null>;
  abandoned_by: DatabaseSet<string | null>; abandoned_at: DatabaseSet<Date | null>; abandonment_reason: DatabaseSet<string | null>;
}
export interface AmlCddCaseControlsTable {
  cdd_case_id: DatabaseSet<string>; control_version_id: DatabaseSet<string>; kind: DatabaseSet<AmlControlKind>;
}
export interface AmlCddSubjectsTable {
  id: DatabaseSet<string>; cdd_case_id: DatabaseSet<string>; kind: DatabaseSet<AmlSubjectKind>;
  relationship: DatabaseSet<AmlSubjectRelationship>; encryption_context: DatabaseSet<string>;
  key_version: DatabaseSet<number>; nonce: DatabaseSet<Buffer>; ciphertext: DatabaseSet<Buffer>;
  auth_tag: DatabaseSet<Buffer>; recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface AmlCddEvidenceTable {
  id: DatabaseSet<string>; cdd_case_id: DatabaseSet<string>; evidence_type: DatabaseSet<string>;
  country: DatabaseSet<string | null>; issued_on: DatabaseSet<string | null>; expires_on: DatabaseSet<string | null>;
  metadata_context: DatabaseSet<string>; metadata_key_version: DatabaseSet<number>; metadata_nonce: DatabaseSet<Buffer>;
  metadata_ciphertext: DatabaseSet<Buffer>; metadata_auth_tag: DatabaseSet<Buffer>; media_type: DatabaseSet<DocumentMediaType>;
  size_bytes: DatabaseSet<number>; sha256: DatabaseSet<Buffer>; storage_key: DatabaseSet<string>;
  file_key_version: DatabaseSet<number>; file_key_nonce: DatabaseSet<Buffer>; wrapped_file_key: DatabaseSet<Buffer>;
  file_key_tag: DatabaseSet<Buffer>; uploaded_by: DatabaseSet<string>; uploaded_at: DatabaseSet<Date>;
}
export interface AmlCddOwnershipControlsTable {
  id: DatabaseSet<string>; cdd_case_id: DatabaseSet<string>; owned_subject_id: DatabaseSet<string>;
  controller_subject_id: DatabaseSet<string>; ownership_percent: DatabaseSet<string | null>; control_kind: DatabaseSet<string>;
  details_context: DatabaseSet<string>; details_key_version: DatabaseSet<number>; details_nonce: DatabaseSet<Buffer>;
  details_ciphertext: DatabaseSet<Buffer>; details_auth_tag: DatabaseSet<Buffer>; recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface AmlCddAuthoritiesTable {
  id: DatabaseSet<string>; cdd_case_id: DatabaseSet<string>; representative_subject_id: DatabaseSet<string>;
  represented_subject_id: DatabaseSet<string>; evidence_id: DatabaseSet<string>; authority_type: DatabaseSet<string>;
  verified_on: DatabaseSet<string>; details_context: DatabaseSet<string>; details_key_version: DatabaseSet<number>;
  details_nonce: DatabaseSet<Buffer>; details_ciphertext: DatabaseSet<Buffer>; details_auth_tag: DatabaseSet<Buffer>;
  recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface AmlCddVerificationsTable {
  id: DatabaseSet<string>; cdd_case_id: DatabaseSet<string>; subject_id: DatabaseSet<string>; evidence_id: DatabaseSet<string>;
  source_type: DatabaseSet<string>; country: DatabaseSet<string | null>; checked_on: DatabaseSet<string>;
  expires_on: DatabaseSet<string | null>; method: DatabaseSet<string>; outcome: DatabaseSet<string>;
  provider: DatabaseSet<string | null>; service: DatabaseSet<string | null>; details_context: DatabaseSet<string>;
  details_key_version: DatabaseSet<number>; details_nonce: DatabaseSet<Buffer>; details_ciphertext: DatabaseSet<Buffer>;
  details_auth_tag: DatabaseSet<Buffer>; verified_by: DatabaseSet<string>; verified_at: DatabaseSet<Date>;
}

export interface AmlCountryListVersionsTable {
  id: DatabaseSet<string>; version: DatabaseSet<number>; countries: DatabaseSet<string[]>;
  source: DatabaseSet<string>; effective_from: DatabaseSet<string>;
  prepared_by: DatabaseSet<string>; prepared_at: DatabaseSet<Date>;
}
export interface AmlCountryListApprovalsTable {
  id: DatabaseSet<string>; country_list_version_id: DatabaseSet<string>;
  approved_by: DatabaseSet<string>; approved_at: DatabaseSet<Date>;
}

export type AmlRiskRating = 'low' | 'standard' | 'high';
export type AmlExpectedValue = 'none' | 'under_10k' | '10k_to_100k' | '100k_to_1m' | 'over_1m';

export interface AmlRiskAssessmentsTable {
  id: DatabaseSet<string>; matter_id: DatabaseSet<string>; client_id: DatabaseSet<string>; version: DatabaseSet<number>;
  in_scope: DatabaseSet<boolean>; cdd_case_id: DatabaseSet<string | null>; country_list_version_id: DatabaseSet<string>;
  rating: DatabaseSet<AmlRiskRating>; pep: DatabaseSet<boolean>; high_risk_country: DatabaseSet<boolean>;
  unusual_transactions: DatabaseSet<boolean>; complex_structure: DatabaseSet<boolean>; cash: DatabaseSet<boolean>;
  remote_instruction: DatabaseSet<boolean>; adverse_information: DatabaseSet<boolean>;
  sanctions_exposure: DatabaseSet<boolean>; third_party_funding: DatabaseSet<boolean>;
  jurisdictions: DatabaseSet<string[]>; expected_value: DatabaseSet<AmlExpectedValue>;
  lowers_previous: DatabaseSet<boolean>; review_due_on: DatabaseSet<string>; review_grace_days: DatabaseSet<number>;
  encryption_context: DatabaseSet<string>; key_version: DatabaseSet<number>; nonce: DatabaseSet<Buffer>;
  ciphertext: DatabaseSet<Buffer>; auth_tag: DatabaseSet<Buffer>;
  prepared_by: DatabaseSet<string>; submitted_at: DatabaseSet<Date>;
}
export interface AmlRiskAssessmentControlsTable {
  assessment_id: DatabaseSet<string>; control_version_id: DatabaseSet<string>; kind: DatabaseSet<AmlControlKind>;
}

export type AmlMeasureKind = 'identity' | 'beneficial_ownership' | 'authority' | 'purpose_nature'
  | 'ongoing_monitoring' | 'additional_sources' | 'ownership_background' | 'transaction_reasons'
  | 'source_of_funds' | 'source_of_wealth' | 'enhanced_monitoring' | 'other';
export type AmlOutcome = 'satisfied' | 'not_satisfied';
interface AmlSealedColumns {
  encryption_context: DatabaseSet<string>; key_version: DatabaseSet<number>; nonce: DatabaseSet<Buffer>;
  ciphertext: DatabaseSet<Buffer>; auth_tag: DatabaseSet<Buffer>;
}
export interface AmlMeasuresTable extends AmlSealedColumns {
  id: DatabaseSet<string>; assessment_id: DatabaseSet<string>; kind: DatabaseSet<AmlMeasureKind>;
  recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface AmlMeasureResultsTable extends AmlSealedColumns {
  id: DatabaseSet<string>; measure_id: DatabaseSet<string>; outcome: DatabaseSet<AmlOutcome>;
  evidence_ids: DatabaseSet<string[]>; recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface AmlSourceConclusionsTable extends AmlSealedColumns {
  id: DatabaseSet<string>; assessment_id: DatabaseSet<string>; kind: DatabaseSet<'funds' | 'wealth'>;
  subject_id: DatabaseSet<string | null>; amount_min_pence: DatabaseSet<string>; amount_max_pence: DatabaseSet<string>;
  outcome: DatabaseSet<AmlOutcome>; evidence_ids: DatabaseSet<string[]>;
  recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}

export interface AmlClientChangesTable {
  id: DatabaseSet<string>; client_id: DatabaseSet<string>; changed_at: DatabaseSet<Date>;
}
export interface AmlClearancesTable extends AmlSealedColumns {
  id: DatabaseSet<string>; matter_id: DatabaseSet<string>; assessment_id: DatabaseSet<string>;
  decision: DatabaseSet<'approved' | 'refused'>; needs_senior: DatabaseSet<boolean>;
  relied_measure_results: DatabaseSet<string[]>; relied_conclusions: DatabaseSet<string[]>;
  decided_by: DatabaseSet<string>; decided_at: DatabaseSet<Date>;
}
export interface AmlSeniorApprovalsTable {
  id: DatabaseSet<string>; clearance_id: DatabaseSet<string>; approved_by: DatabaseSet<string>; approved_at: DatabaseSet<Date>;
}

export interface AmlHoldsTable extends AmlSealedColumns {
  id: DatabaseSet<string>; client_id: DatabaseSet<string>; matter_id: DatabaseSet<string | null>;
  imposed_by: DatabaseSet<string>; imposed_at: DatabaseSet<Date>;
}
export interface AmlHoldLiftsTable extends AmlSealedColumns {
  id: DatabaseSet<string>; hold_id: DatabaseSet<string>; lifted_by: DatabaseSet<string>; lifted_at: DatabaseSet<Date>;
}
export interface AmlStartExceptionsTable extends AmlSealedColumns {
  id: DatabaseSet<string>; matter_id: DatabaseSet<string>; assessment_id: DatabaseSet<string>;
  permitted_actions: DatabaseSet<('documents' | 'time')[]>; expires_on: DatabaseSet<string>;
  granted_by: DatabaseSet<string>; granted_at: DatabaseSet<Date>;
}
export interface AmlExceptionApprovalsTable {
  id: DatabaseSet<string>; exception_id: DatabaseSet<string>; approved_by: DatabaseSet<string>; approved_at: DatabaseSet<Date>;
}

export interface AmlSanctionsListsTable {
  id: DatabaseSet<string>; version: DatabaseSet<number>; report_date: DatabaseSet<string>; sha256: DatabaseSet<Buffer>;
  byte_size: DatabaseSet<number>; source: DatabaseSet<'download' | 'upload'>; designation_count: DatabaseSet<number>;
  name_count: DatabaseSet<number>; imported_by: DatabaseSet<string | null>; imported_at: DatabaseSet<Date>;
}
export interface AmlSanctionsDesignationsTable {
  list_id: DatabaseSet<string>; unique_id: DatabaseSet<string>; kind: DatabaseSet<'individual' | 'entity' | 'ship'>;
  regime: DatabaseSet<string>; date_designated: DatabaseSet<string | null>; births: DatabaseSet<string[]>;
  nationalities: DatabaseSet<string[]>;
}
export interface AmlSanctionsNamesTable {
  list_id: DatabaseSet<string>; unique_id: DatabaseSet<string>; name: DatabaseSet<string>; normalized: DatabaseSet<string>;
  tokens: DatabaseSet<string[]>; is_primary: DatabaseSet<boolean>;
}
export interface AmlSanctionsChecksTable {
  id: DatabaseSet<string>; outcome: DatabaseSet<'imported' | 'unchanged' | 'failed'>; list_id: DatabaseSet<string | null>;
  failure: DatabaseSet<string | null>; checked_by: DatabaseSet<string | null>; checked_at: DatabaseSet<Date>;
}

export interface AmlScreeningsTable {
  id: DatabaseSet<string>; client_id: DatabaseSet<string>; list_id: DatabaseSet<string>; subject_ref: DatabaseSet<string>;
  screened_by: DatabaseSet<string | null>; screened_at: DatabaseSet<Date>;
}
export interface AmlScreeningCandidatesTable {
  id: DatabaseSet<string>; screening_id: DatabaseSet<string>; list_id: DatabaseSet<string>; unique_id: DatabaseSet<string>;
  matched_name: DatabaseSet<string>; birth_agreement: DatabaseSet<'match' | 'conflict' | 'unknown'>;
  designation_print: DatabaseSet<Buffer>; carried_from: DatabaseSet<string | null>;
}
export interface AmlCandidateResolutionsTable extends AmlSealedColumns {
  id: DatabaseSet<string>; candidate_id: DatabaseSet<string>; outcome: DatabaseSet<'false_positive' | 'confirmed'>;
  resolved_by: DatabaseSet<string>; resolved_at: DatabaseSet<Date>;
}

export type AmlLicenceAction = 'billing' | 'documents' | 'money' | 'time';
export interface AmlFrozenFundsTable {
  id: DatabaseSet<string>; client_id: DatabaseSet<string>; matter_id: DatabaseSet<string>; amount_pence: DatabaseSet<string>;
  reason: DatabaseSet<'balance_at_confirmation' | 'receipt'>; finance_transaction_id: DatabaseSet<string | null>;
  frozen_at: DatabaseSet<Date>;
}
export interface AmlSanctionsLicencesTable extends AmlSealedColumns {
  id: DatabaseSet<string>; client_id: DatabaseSet<string>; authority: DatabaseSet<'ofsi' | 'otsi' | 'other'>;
  licence_kind: DatabaseSet<'specific' | 'general'>; reference: DatabaseSet<string>;
  permitted_actions: DatabaseSet<AmlLicenceAction[]>; money_limit_pence: DatabaseSet<string | null>;
  effective_from: DatabaseSet<string>; expires_on: DatabaseSet<string>; recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface AmlLicenceRevocationsTable extends AmlSealedColumns {
  id: DatabaseSet<string>; licence_id: DatabaseSet<string>; revoked_by: DatabaseSet<string>; revoked_at: DatabaseSet<Date>;
}

export interface AmlInternalReportsTable extends AmlSealedColumns {
  id: DatabaseSet<string>; client_id: DatabaseSet<string>; matter_id: DatabaseSet<string | null>;
  finance_transaction_id: DatabaseSet<string | null>; observed_on: DatabaseSet<string>;
  submitted_by: DatabaseSet<string>; submitted_at: DatabaseSet<Date>;
}
export interface AmlInternalReportAttachmentsTable {
  id: DatabaseSet<string>; report_id: DatabaseSet<string>; metadata_context: DatabaseSet<string>;
  metadata_key_version: DatabaseSet<number>; metadata_nonce: DatabaseSet<Buffer>; metadata_ciphertext: DatabaseSet<Buffer>;
  metadata_auth_tag: DatabaseSet<Buffer>; media_type: DatabaseSet<DocumentMediaType>; size_bytes: DatabaseSet<number>;
  sha256: DatabaseSet<Buffer>; storage_key: DatabaseSet<string>; file_key_version: DatabaseSet<number>;
  file_key_nonce: DatabaseSet<Buffer>; wrapped_file_key: DatabaseSet<Buffer>; file_key_tag: DatabaseSet<Buffer>;
  uploaded_at: DatabaseSet<Date>;
}
export interface AmlInternalReportDecisionsTable extends AmlSealedColumns {
  id: DatabaseSet<string>; report_id: DatabaseSet<string>; external_report_required: DatabaseSet<boolean>;
  decided_by: DatabaseSet<string>; decided_at: DatabaseSet<Date>;
}
export interface AmlExternalReportsTable extends AmlSealedColumns {
  id: DatabaseSet<string>; internal_report_id: DatabaseSet<string>;
  report_kind: DatabaseSet<'sar' | 'terrorist_financing_report'>; daml_datf_requested: DatabaseSet<boolean>;
  submitted_by: DatabaseSet<string>; submitted_at: DatabaseSet<Date>; recorded_at: DatabaseSet<Date>;
}
export interface AmlDamlDatfEventsTable extends AmlSealedColumns {
  id: DatabaseSet<string>; external_report_id: DatabaseSet<string>;
  outcome: DatabaseSet<'requested' | 'granted' | 'refused' | 'withdrawn' | 'expired'>;
  received_at: DatabaseSet<Date>; expires_at: DatabaseSet<Date | null>; recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface AmlRestrictedHoldLinksTable { report_id: DatabaseSet<string>; hold_id: DatabaseSet<string> }
export interface AmlRestrictedAccessLogTable {
  id: DatabaseSet<string>; report_id: DatabaseSet<string>; attachment_id: DatabaseSet<string | null>;
  action: DatabaseSet<'view' | 'download' | 'export'>; accessed_by: DatabaseSet<string>; accessed_at: DatabaseSet<Date>;
}
export interface AmlRetentionSchedulesTable {
  id: DatabaseSet<string>; client_id: DatabaseSet<string>; relationship_ended_on: DatabaseSet<string>;
  retention_years: DatabaseSet<number>; dispose_after: DatabaseSet<string>; governing_rule: DatabaseSet<string>;
  evidence_context: DatabaseSet<string>; evidence_key_version: DatabaseSet<number>; evidence_nonce: DatabaseSet<Buffer>;
  evidence_ciphertext: DatabaseSet<Buffer>; evidence_auth_tag: DatabaseSet<Buffer>;
  recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface AmlLegalHoldEventsTable extends AmlSealedColumns {
  id: DatabaseSet<string>; schedule_id: DatabaseSet<string>; action: DatabaseSet<'imposed' | 'reviewed' | 'released'>;
  review_on: DatabaseSet<string | null>; recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface AmlExportsTable extends AmlSealedColumns {
  id: DatabaseSet<string>; client_id: DatabaseSet<string>; sha256: DatabaseSet<Buffer>; byte_size: DatabaseSet<number>;
  created_by: DatabaseSet<string>; created_at: DatabaseSet<Date>;
}
export interface AmlRestrictedExportsTable extends AmlSealedColumns {
  id: DatabaseSet<string>; report_id: DatabaseSet<string>; sha256: DatabaseSet<Buffer>; byte_size: DatabaseSet<number>;
  created_by: DatabaseSet<string>; created_at: DatabaseSet<Date>;
}
export interface AmlDisposalRunsTable {
  id: DatabaseSet<string>; schedule_id: DatabaseSet<string>; client_id: DatabaseSet<string>; governing_rule: DatabaseSet<string>;
  state: DatabaseSet<'prepared' | 'completed'>; object_keys: DatabaseSet<string[]>;
  prepared_by: DatabaseSet<string>; prepared_at: DatabaseSet<Date>; completed_by: DatabaseSet<string | null>;
  completed_at: DatabaseSet<Date | null>; record_count: DatabaseSet<number | null>;
}
export interface AmlDisposedRecordsTable {
  id: DatabaseSet<string>; run_id: DatabaseSet<string>; record_id: DatabaseSet<string>; record_kind: DatabaseSet<string>;
  governing_rule: DatabaseSet<string>; disposed_by: DatabaseSet<string>; disposed_at: DatabaseSet<Date>;
}

export type HrEngagementKind = 'employee' | 'worker' | 'llp_partner' | 'equity_partner' | 'consultant' | 'apprentice' | 'trainee';
export type HrCorrectionCategory = 'contact' | 'personal' | 'employment' | 'manager' | 'work_pattern' | 'other';
export type HrFileCategory = 'contract' | 'terms' | 'identity' | 'personal' | 'other';
export type HrLeaveKind = 'annual' | 'family' | 'compassionate' | 'unpaid' | 'other';
export type HrEntitlementKind = 'opening_grant' | 'accrual' | 'adjustment' | 'carry_over' | 'consumption' | 'cancellation_return' | 'leaving_adjustment';
export type HrFitnessStatus = 'fit' | 'not_fit' | 'may_be_fit' | 'not_assessed';

interface HrSealedColumns {
  context: DatabaseSet<string>;
  key_version: DatabaseSet<number>;
  nonce: DatabaseSet<Buffer>;
  ciphertext: DatabaseSet<Buffer>;
  auth_tag: DatabaseSet<Buffer>;
}

export interface HrPeopleTable {
  id: DatabaseSet<string>; account_id: DatabaseSet<string>; created_by: DatabaseSet<string>; created_at: DatabaseSet<Date>;
}
export interface HrContactVersionsTable extends HrSealedColumns {
  id: DatabaseSet<string>; person_id: DatabaseSet<string>; recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface HrPrivateVersionsTable extends HrSealedColumns {
  id: DatabaseSet<string>; person_id: DatabaseSet<string>; recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface HrEngagementsTable {
  id: DatabaseSet<string>; person_id: DatabaseSet<string>; engagement_kind: DatabaseSet<HrEngagementKind>;
  started_on: DatabaseSet<string>; ended_on: DatabaseSet<string | null>;
  created_by: DatabaseSet<string>; created_at: DatabaseSet<Date>;
}
export interface HrEngagementEndingsTable extends HrSealedColumns {
  id: DatabaseSet<string>; engagement_id: DatabaseSet<string>; ended_on: DatabaseSet<string>;
  recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface HrEmploymentTermsTable {
  id: DatabaseSet<string>; engagement_id: DatabaseSet<string>; effective_on: DatabaseSet<string>;
  job_title: DatabaseSet<string>; team: DatabaseSet<string | null>; work_location: DatabaseSet<string | null>;
  recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface HrManagerEventsTable {
  id: DatabaseSet<string>; person_id: DatabaseSet<string>; action: DatabaseSet<'assigned' | 'cleared'>;
  manager_person_id: DatabaseSet<string | null>; effective_on: DatabaseSet<string>;
  recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface HrWorkPatternsTable {
  id: DatabaseSet<string>; engagement_id: DatabaseSet<string>; effective_on: DatabaseSet<string>;
  time_zone: DatabaseSet<string>; monday_minutes: DatabaseSet<number>; tuesday_minutes: DatabaseSet<number>;
  wednesday_minutes: DatabaseSet<number>; thursday_minutes: DatabaseSet<number>; friday_minutes: DatabaseSet<number>;
  saturday_minutes: DatabaseSet<number>; sunday_minutes: DatabaseSet<number>;
  recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface HrCorrectionRequestsTable extends HrSealedColumns {
  id: DatabaseSet<string>; person_id: DatabaseSet<string>; category: DatabaseSet<HrCorrectionCategory>;
  submitted_by: DatabaseSet<string>; submitted_at: DatabaseSet<Date>;
}
export interface HrCorrectionEventsTable extends HrSealedColumns {
  id: DatabaseSet<string>; request_id: DatabaseSet<string>; outcome: DatabaseSet<'resolved' | 'rejected'>;
  recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface HrFilesTable {
  id: DatabaseSet<string>; person_id: DatabaseSet<string>; category: DatabaseSet<HrFileCategory>;
  worker_visible: DatabaseSet<boolean>; metadata_context: DatabaseSet<string>;
  metadata_key_version: DatabaseSet<number>; metadata_nonce: DatabaseSet<Buffer>;
  metadata_ciphertext: DatabaseSet<Buffer>; metadata_auth_tag: DatabaseSet<Buffer>;
  media_type: DatabaseSet<DocumentMediaType>; size_bytes: DatabaseSet<number>; sha256: DatabaseSet<Buffer>;
  storage_key: DatabaseSet<string>; file_key_version: DatabaseSet<number>; file_key_nonce: DatabaseSet<Buffer>;
  wrapped_file_key: DatabaseSet<Buffer>; file_key_tag: DatabaseSet<Buffer>;
  uploaded_by: DatabaseSet<string>; uploaded_at: DatabaseSet<Date>;
}
export interface HrLeavePoliciesTable {
  id: DatabaseSet<string>; version: DatabaseSet<number>; effective_from: DatabaseSet<string>;
  leave_year_month: DatabaseSet<number>; leave_year_day: DatabaseSet<number>;
  standard_entitlement_minutes: DatabaseSet<number>; carry_over_limit_minutes: DatabaseSet<number>;
  booking_notice_days: DatabaseSet<number>; annual_approval_route: DatabaseSet<'manager_or_hr' | 'hr_only'>;
  recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface HrLeaveRequestsTable extends HrSealedColumns {
  id: DatabaseSet<string>; person_id: DatabaseSet<string>; policy_id: DatabaseSet<string>; kind: DatabaseSet<HrLeaveKind>;
  starts_on: DatabaseSet<string>; ends_on: DatabaseSet<string>; leave_year_start: DatabaseSet<string>;
  submitted_by: DatabaseSet<string>; submitted_at: DatabaseSet<Date>;
}
export interface HrLeaveRequestEventsTable extends HrSealedColumns {
  id: DatabaseSet<string>; request_id: DatabaseSet<string>; action: DatabaseSet<'approved' | 'refused' | 'cancelled'>;
  recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface HrLeaveRequestDaysTable {
  id: DatabaseSet<string>; request_id: DatabaseSet<string>; person_id: DatabaseSet<string>;
  leave_on: DatabaseSet<string>; minutes: DatabaseSet<number>; recorded_at: DatabaseSet<Date>;
}
export interface HrLeaveEntitlementEntriesTable extends HrSealedColumns {
  id: DatabaseSet<string>; person_id: DatabaseSet<string>; leave_year_start: DatabaseSet<string>;
  kind: DatabaseSet<HrEntitlementKind>; minutes: DatabaseSet<number>; leave_request_id: DatabaseSet<string | null>;
  recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface HrHolidayPayRecordsTable {
  id: DatabaseSet<string>; person_id: DatabaseSet<string>; leave_request_id: DatabaseSet<string>;
  period_starts_on: DatabaseSet<string>; period_ends_on: DatabaseSet<string>; amount_pence: DatabaseSet<string>;
  basis: DatabaseSet<'normal' | 'basic' | 'rolled_up' | 'other'>;
  included_elements: DatabaseSet<Array<{ name: string; amountPence: number }>>;
  retention_until: DatabaseSet<string>; recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface HrSicknessAbsencesTable {
  id: DatabaseSet<string>; person_id: DatabaseSet<string>; started_on: DatabaseSet<string>;
  ended_on: DatabaseSet<string | null>; notified_at: DatabaseSet<Date>; fitness_status: DatabaseSet<HrFitnessStatus>;
  recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface HrHealthRecordsTable extends HrSealedColumns {
  id: DatabaseSet<string>; person_id: DatabaseSet<string>;
  kind: DatabaseSet<'sickness_detail' | 'fit_note' | 'occupational_health' | 'adjustment_ground'>;
  valid_from: DatabaseSet<string | null>; valid_to: DatabaseSet<string | null>;
  recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface HrAdjustmentRequestsTable extends HrSealedColumns {
  id: DatabaseSet<string>; person_id: DatabaseSet<string>; submitted_by: DatabaseSet<string>; submitted_at: DatabaseSet<Date>;
}
export interface HrAdjustmentDecisionsTable {
  id: DatabaseSet<string>; request_id: DatabaseSet<string>; outcome: DatabaseSet<'agreed' | 'refused'>;
  private_context: DatabaseSet<string>; private_key_version: DatabaseSet<number>; private_nonce: DatabaseSet<Buffer>;
  private_ciphertext: DatabaseSet<Buffer>; private_auth_tag: DatabaseSet<Buffer>;
  operational_context: DatabaseSet<string | null>; operational_key_version: DatabaseSet<number | null>;
  operational_nonce: DatabaseSet<Buffer | null>; operational_ciphertext: DatabaseSet<Buffer | null>;
  operational_auth_tag: DatabaseSet<Buffer | null>; effective_on: DatabaseSet<string | null>;
  review_on: DatabaseSet<string | null>; recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}
export interface HrAdjustmentProgressEventsTable extends HrSealedColumns {
  id: DatabaseSet<string>; decision_id: DatabaseSet<string>;
  action: DatabaseSet<'implemented' | 'reviewed' | 'closed'>; recorded_by: DatabaseSet<string>; recorded_at: DatabaseSet<Date>;
}

export interface Database {
  account_roles: AccountRolesTable;
  accounts: AccountsTable;
  aml_control_approvals: AmlControlApprovalsTable;
  aml_control_versions: AmlControlVersionsTable;
  aml_candidate_resolutions: AmlCandidateResolutionsTable;
  aml_cdd_authorities: AmlCddAuthoritiesTable;
  aml_cdd_case_controls: AmlCddCaseControlsTable;
  aml_cdd_cases: AmlCddCasesTable;
  aml_cdd_evidence: AmlCddEvidenceTable;
  aml_cdd_ownership_controls: AmlCddOwnershipControlsTable;
  aml_cdd_subjects: AmlCddSubjectsTable;
  aml_cdd_verifications: AmlCddVerificationsTable;
  aml_clearances: AmlClearancesTable;
  aml_client_changes: AmlClientChangesTable;
  aml_country_list_approvals: AmlCountryListApprovalsTable;
  aml_country_list_versions: AmlCountryListVersionsTable;
  aml_exception_approvals: AmlExceptionApprovalsTable;
  aml_frozen_funds: AmlFrozenFundsTable;
  aml_hold_lifts: AmlHoldLiftsTable;
  aml_licence_revocations: AmlLicenceRevocationsTable;
  aml_holds: AmlHoldsTable;
  aml_internal_reports: AmlInternalReportsTable;
  aml_internal_report_attachments: AmlInternalReportAttachmentsTable;
  aml_internal_report_decisions: AmlInternalReportDecisionsTable;
  aml_external_reports: AmlExternalReportsTable;
  aml_daml_datf_events: AmlDamlDatfEventsTable;
  aml_restricted_hold_links: AmlRestrictedHoldLinksTable;
  aml_restricted_access_log: AmlRestrictedAccessLogTable;
  aml_retention_schedules: AmlRetentionSchedulesTable;
  aml_legal_hold_events: AmlLegalHoldEventsTable;
  aml_exports: AmlExportsTable;
  aml_restricted_exports: AmlRestrictedExportsTable;
  aml_disposal_runs: AmlDisposalRunsTable;
  aml_disposed_records: AmlDisposedRecordsTable;
  aml_measure_results: AmlMeasureResultsTable;
  aml_measures: AmlMeasuresTable;
  aml_risk_assessment_controls: AmlRiskAssessmentControlsTable;
  aml_risk_assessments: AmlRiskAssessmentsTable;
  aml_sanctions_checks: AmlSanctionsChecksTable;
  aml_sanctions_designations: AmlSanctionsDesignationsTable;
  aml_sanctions_licences: AmlSanctionsLicencesTable;
  aml_sanctions_lists: AmlSanctionsListsTable;
  aml_sanctions_names: AmlSanctionsNamesTable;
  aml_screening_candidates: AmlScreeningCandidatesTable;
  aml_screenings: AmlScreeningsTable;
  aml_senior_approvals: AmlSeniorApprovalsTable;
  aml_source_conclusions: AmlSourceConclusionsTable;
  aml_start_exceptions: AmlStartExceptionsTable;
  aml_independent_reviews: AmlIndependentReviewsTable;
  aml_officer_appointments: AmlOfficerAppointmentsTable;
  aml_training_completions: AmlTrainingCompletionsTable;
  audit_events: AuditEventsTable;
  backup_codes: BackupCodesTable;
  bank_account_closures: BankAccountClosuresTable;
  bank_accounts: BankAccountsTable;
  bank_statement_imports: BankStatementImportsTable;
  bank_statement_match_events: BankStatementMatchEventsTable;
  bank_statement_rows: BankStatementRowsTable;
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
  client_payment_events: ClientPaymentEventsTable;
  client_payment_requests: ClientPaymentRequestsTable;
  client_account_reconciliation_items: ClientAccountReconciliationItemsTable;
  client_account_reconciliation_balances: ClientAccountReconciliationBalancesTable;
  client_account_reconciliation_sign_offs: ClientAccountReconciliationSignOffsTable;
  client_account_reconciliation_statements: ClientAccountReconciliationStatementsTable;
  client_account_reconciliations: ClientAccountReconciliationsTable;
  document_versions: DocumentVersionsTable;
  document_sharing_changes: DocumentSharingChangesTable;
  document_withdrawals: DocumentWithdrawalsTable;
  documents: DocumentsTable;
  email_outbox: EmailOutboxTable;
  email_outbox_changes: EmailOutboxChangesTable;
  finance_postings: FinancePostingsTable;
  finance_transactions: FinanceTransactionsTable;
  hr_contact_versions: HrContactVersionsTable;
  hr_adjustment_decisions: HrAdjustmentDecisionsTable;
  hr_adjustment_progress_events: HrAdjustmentProgressEventsTable;
  hr_adjustment_requests: HrAdjustmentRequestsTable;
  hr_correction_events: HrCorrectionEventsTable;
  hr_correction_requests: HrCorrectionRequestsTable;
  hr_employment_terms: HrEmploymentTermsTable;
  hr_engagement_endings: HrEngagementEndingsTable;
  hr_engagements: HrEngagementsTable;
  hr_files: HrFilesTable;
  hr_health_records: HrHealthRecordsTable;
  hr_holiday_pay_records: HrHolidayPayRecordsTable;
  hr_leave_entitlement_entries: HrLeaveEntitlementEntriesTable;
  hr_leave_policies: HrLeavePoliciesTable;
  hr_leave_request_days: HrLeaveRequestDaysTable;
  hr_leave_request_events: HrLeaveRequestEventsTable;
  hr_leave_requests: HrLeaveRequestsTable;
  hr_manager_events: HrManagerEventsTable;
  hr_people: HrPeopleTable;
  hr_private_versions: HrPrivateVersionsTable;
  hr_sickness_absences: HrSicknessAbsencesTable;
  hr_work_patterns: HrWorkPatternsTable;
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
