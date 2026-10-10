# Data Model

**Current state (2026-10-10):** The database foundation through Compliance
step 15c-4 exists, with separate owner and application roles and forward-only
migrations through `0053`.

## Database

- PostgreSQL 18.6, database `pms`, all application tables in schema `app`.
- Schema `migrations` holds Kysely's migration history. Owned by `pms_owner`; `pms_app` has no access.
- Database `pms_test` has the same roles and schemas, for integration tests.
  There `pms_owner` may also create schemas, so tests can use throwaway ones.
- The `public` schema is locked: no role but the superuser can use it.

## Roles

See [ADR-006](decisions.md#adr-006-postgresql-18-with-separate-owner-and-app-roles).

| Role | Login | Privileges |
|---|---|---|
| `postgres` | Local only | Superuser. Used by the container to initialise. Never used by the app. |
| `pms_owner` | Yes | Owns schema `app`. Runs migrations. |
| `pms_app` | Yes | `USAGE` on `app`. `SELECT`, `INSERT` on new tables by default. No DDL. |

`pms_app` settings: `statement_timeout = 15s`,
`idle_in_transaction_session_timeout = 30s`, at most 50 connections.

## Migrations

Plain SQL files in `apps/api/migrations/`, named `NNNN_description.sql`.

- Applied in file-name order, each in its own transaction. If any statement
  fails, the whole file is rolled back.
- Forward only. An applied file is never edited, renamed or deleted; a mistake
  is fixed with a new migration. The runner refuses to continue if an applied
  file is missing or a new file sorts before an applied one.
- Known gap: the runner does not detect an applied file whose contents were
  edited afterwards. Code review is the control for now.

## Rules for migrations

- A table that needs `UPDATE` or `DELETE` from the app grants it explicitly in
  its migration, with the reason in the migration file.
- Audit and posted financial tables never get `UPDATE` or `DELETE`.

## Tables

| Table | Migration | `pms_app` privileges | Details |
|---|---|---|---|
| `accounts` | `0002_accounts.sql` | `SELECT`, `INSERT`; `UPDATE` on `display_name`, `status`, `password_hash`, `password_changed_at` only. No `DELETE` | [authentication.md](authentication.md) |
| `sessions` | `0003_sessions.sql` | `SELECT`; `INSERT` without `id`, `created_at`, `ended_at`; `UPDATE` of stage, timestamps and end only. No `DELETE`. A trigger stops ended sessions changing and authenticated sessions going back to pending, for every role | [authentication.md](authentication.md#sessions) |
| `sign_in_failures` | `0004`, `0006` (adds `session_id`, `wrong_two_factor_code`) | `SELECT`, `INSERT`. No `UPDATE` or `DELETE` | [authentication.md](authentication.md#lockout-and-rate-limits) |
| `totp_credentials` | `0005_totp_credentials.sql` | `SELECT`, `INSERT`; `UPDATE` of everything except `account_id`. No `DELETE`. A trigger stops the used time step moving backwards, for every role | [authentication.md](authentication.md#secret-storage) |
| `backup_codes` | `0006_two_factor_sign_in.sql` | `SELECT`, `INSERT`; `UPDATE` of `spent_at`, `spent_reason` only. No `DELETE`. A trigger stops a spent code being changed, for every role | [authentication.md](authentication.md#sign-in) |
| `invitations` | `0007_invitations.sql` | `SELECT`, `INSERT`; `UPDATE` of `closed_at`, `close_reason` only. No `DELETE`. One open invitation per account (unique index). A trigger keeps closed invitations closed, for every role | [authentication.md](authentication.md#invitations-and-password-reset) |
| `password_resets` | `0008_password_resets.sql` | `SELECT`, `INSERT`; `UPDATE` of `closed_at`, `close_reason` only. No `DELETE`. One open reset per account. A trigger keeps closed resets closed, for every role | [authentication.md](authentication.md#invitations-and-password-reset) |
| `account_roles` | `0009_account_roles.sql` | `SELECT`, `INSERT`; `UPDATE` of `revoked_at`, `revoked_by` only. No `DELETE`. One active row per account and role. Triggers: only staff accounts hold roles; a revoked row stays revoked. Checks: nobody grants or revokes their own role | [authorization.md](authorization.md#layer-2-roles-and-permissions-designed) |
| `clients` | `0010_clients.sql`, `0012_client_takeover.sql` | `SELECT`; `INSERT` of `kind` and `created_by` only, so the number, reference and responsible person come from the database. No `UPDATE` or `DELETE`. Triggers: created by a staff account; responsible person starts as the creator. Checked at commit: every client has its details row | [clients.md](clients.md) |
| `client_contacts` | `0013_client_contacts.sql` | `SELECT`; `INSERT` without `active` (new contacts are active); `UPDATE` of details and `active`, not `client_id`. No `DELETE`: a contact who leaves is marked inactive. Trigger: organisation clients only | [clients.md](clients.md) |
| `matters` | `0016_matters.sql` | `SELECT`; `INSERT` of client, title, type and opener only: number, reference and status come from the database. No `UPDATE` or `DELETE` yet. Triggers: opened by staff; numbered per client under an advisory lock. Checked at commit: a supervising partner exists | [matters.md](matters.md) |
| `conflict_checks` | `0017_conflict_checks.sql` | `SELECT`; `INSERT` of client, requester and names only. A trigger adds the client's name and fills `matches` (the 50 strongest) and `match_count` itself, through `app.find_possible_conflicts`. No `UPDATE` or `DELETE` | [matters.md](matters.md#conflict-checks) |
| `matter_parties` | `0017_conflict_checks.sql` | `SELECT`; `INSERT` of matter, role, kind, name and adder. No `UPDATE` or `DELETE` yet. Trigger: the name must have been in the matter's conflict check | [matters.md](matters.md#conflict-checks) |
| (matters, 0017) | `0017_conflict_checks.sql` | `matters.conflict_check_id`: required for new matters (`NOT VALID` check, so rows from before are left alone), unique, and checked by a trigger (same client, same opener, under 24 hours). The trigger sets the status from the check's match count | [matters.md](matters.md#conflict-checks) |
| `conflict_clearances` | `0018_conflict_clearances.sql` | `SELECT`; `INSERT` of matter, clearer and reason. One per matter. A `SECURITY DEFINER` trigger checks the matter is awaiting clearance and the clearer is its active supervising partner, then opens it. No row can be changed or deleted, for every role | [matters.md](matters.md#opening-a-matter) |
| (conflict indexes) | `0023_conflict_check_indexes.sql` | Trigram indexes on the normalised names of individuals, organisations, contacts and other parties; `app.find_possible_conflicts` finds candidates through them | [review M1](reviews/2026-10-05-matters.md) |
| `matter_compliance_accesses` | `0022_matter_compliance_access.sql` | `SELECT`; `INSERT` of matter, accessor and reason. Trigger: the accessor is an active compliance holder. No row can be changed or deleted, for every role | [matters.md](matters.md#compliance-access) |
| `matter_closures` | `0021_matter_editing_closing.sql` | `SELECT`; `INSERT` of matter, closer and reason. One per matter. A `SECURITY DEFINER` trigger checks the closer is the active supervising partner, then closes the matter. No row can be changed or deleted, for every role. From 0021, `matters` allows `UPDATE` of title and type, and a trigger refuses any change to a closed matter or its team | [matters.md](matters.md#editing-and-closing) |
| `matter_supervision_takeovers` | `0020_matter_supervision_takeover.sql` | `SELECT`; `INSERT` of matter, from, to and reason. A `SECURITY DEFINER` trigger checks the supervising partner can no longer act and the taker is an active partner, then changes the team. No row can be changed or deleted, for every role | [matters.md](matters.md#taking-over-supervision) |
| `matter_team` | `0016_matters.sql`, `0019_matter_team_changes.sql` | `SELECT`; `INSERT` of matter, account, role and adder; `UPDATE` of `removed_at`, `removed_by` only, once (trigger). No `DELETE`. Checked at commit: an active supervising partner remains. One active membership per person and one supervising partner per matter (partial unique indexes). Trigger: active staff holding a role that allows the team role | [matters.md](matters.md) |
| `client_responsibility_changes` | `0012_client_takeover.sql` | `SELECT`; `INSERT` of client, from, to and reason only. A `SECURITY DEFINER` trigger checks the takeover rules and applies the change to `clients.responsible_id`. No row can be changed or deleted, for every role | [clients.md](clients.md#taking-over-a-client) |
| `client_individuals`, `client_organisations` | `0010_clients.sql`, `0011_client_editing.sql` | `SELECT`, `INSERT`; `UPDATE` of every detail column, not `client_id`. No `DELETE`. One row per client (primary key); a trigger keeps it to the client's kind | [clients.md](clients.md) |
| (client text) | `0015_client_text_safe.sql` | `app.is_safe_text()` checks every client text column and the takeover reason: no control characters, line separators or direction overrides. `pms_app` is granted `EXECUTE` on it, since new functions carry no rights by default | [review C4](reviews/2026-10-04-clients.md) |
| `tasks` | `0029_tasks.sql` to `0032_task_changes.sql` | `SELECT`; `INSERT` of matter, text, due date, priority, assignee and creator only. The database supplies id, open status and creation time. No direct `UPDATE` or `DELETE`; owner-level triggers allow only the nested current-value update made by the history trigger. Creation locks and checks the open matter, active creator membership and active assignee membership | [tasks.md](tasks.md) |
| `task_changes` | `0032_task_changes.sql` | `SELECT`; app `INSERT` of task, kind, requested new values and actor only. A `SECURITY DEFINER` trigger locks and checks the open matter, task, actor and assignee, supplies trusted before values, updates the task, and removes no-ops. No `UPDATE`, `DELETE` or `TRUNCATE`, including for the owner. Matter closure uses the same matter lock and refuses open tasks | [tasks.md](tasks.md) |
| `staff_rates`, `time_entries`, `time_entry_corrections` | `0042_finance_time.sql` | Rates and posted time history are insert-only. Narrow grants and triggers supply trusted rate snapshots, recheck live actors/team/matter state and reject owner changes | [finance.md](finance.md#step-14a-api) |
| `bill_drafts`, `bill_draft_lines` | `0043_finance_billing.sql` | Draft writes use narrow security-definer functions and require live Accounts staff. Drafts can change only before issue; issue freezes their source rows | [finance.md](finance.md#step-14b-api) |
| `issued_bills`, `issued_bill_lines`, `credit_notes`, `credit_note_lines`, `bill_deliveries` | `0043_finance_billing.sql` | No direct application writes. Database functions serialise numbering and snapshot trusted client, supplier, time, VAT and totals. Posted rows reject update, deletion and truncation even by the owner | [finance.md](finance.md#step-14b-api) |
| `bank_accounts`, `bank_account_closures` | `0044_finance_ledgers.sql` | Full details are encrypted by the API; PostgreSQL receives ciphertext, integrity fields, a keyed fingerprint and last four digits. Accounts-only functions add register/closure rows. No direct app writes or later owner changes | [finance.md](finance.md#step-14c-api) |
| `finance_transactions`, `finance_postings` | `0044_finance_ledgers.sql`, `0045_finance_payments.sql` | Narrow functions and bill/credit/payment triggers create immutable headers and balanced postings: two normally, four for a client-to-business billed-cost transfer. Deferred checks enforce client/matter/account shape and nonnegative client balances; the app has no direct write rights | [finance.md](finance.md#step-14c-api) |
| `client_payment_requests`, `client_payment_events` | `0045_finance_payments.sql` | Requests fix matter, accounts, evidence, purpose, exact amount and encrypted external-payee details. Insert-only events implement approval, rejection, requester cancellation, paid and bank-rejected states. Security-definer functions recheck live Accounts actors, four eyes, evidence, bank history, client-money and bill reservations; direct app writes and all later owner edits are refused | [finance.md](finance.md#step-14d-api) |
| `bank_statement_imports`, `bank_statement_rows`, `bank_statement_match_events` | `0046_finance_reconciliation.sql` | Imports fix account, range, balances, content hash, importer and normalized rows. Account-scoped unique hashes/fingerprints refuse duplicate files/rows. Match and reversal events are insert-only; narrow functions require live Accounts and verify bank account, signed amount, date and reference against immutable postings | [finance.md](finance.md#step-14e-api) |
| `client_account_reconciliations`, `client_account_reconciliation_statements`, `client_account_reconciliation_items`, `client_account_reconciliation_sign_offs` | `0046_finance_reconciliation.sql` | Preparation selects one same-date statement per open client bank, recomputes the three totals, and fixes every outstanding item/difference with its explanation. A different active Compliance holder adds the only sign-off. Direct app writes and every later owner edit/delete/truncate are refused | [finance.md](finance.md#step-14e-api) |
| `aml_officer_appointments`, `aml_control_versions`, `aml_control_approvals`, `aml_training_completions`, `aml_independent_reviews` | `0048_compliance_foundations.sql` | Narrow functions recheck live Administrator, Compliance or Partner roles, serialize officer continuity/control numbering and keep final controls, approvals, training and reviews immutable. App direct writes and owner update/delete/truncate are refused | [compliance.md](compliance.md#step-15a-api) |
| `aml_cdd_cases`, `aml_cdd_case_controls` | `0049_compliance_cdd.sql` | One database-serialized draft version per client. Protected submission locks it, requires complete current verification/authority, snapshots the client and five current approved controls, then makes the case immutable. Direct inserts and owner changes/truncation are refused | [compliance.md](compliance.md#step-15b-api) |
| `aml_cdd_subjects`, `aml_cdd_ownership_controls`, `aml_cdd_authorities`, `aml_cdd_verifications`, `aml_cdd_evidence` | `0049_compliance_cdd.sql` | Protected draft-only functions recheck live record access and same-case graph links. Identity/narrative/exact-source metadata and per-file keys are authenticated ciphertext bound to record/purpose contexts. Submitted facts are append-only; direct app writes and later owner insert/update/delete/truncate are refused | [compliance.md](compliance.md#step-15b-api) |
| `aml_country_list_versions`, `aml_country_list_approvals` | `0050_compliance_risk.sql` | Compliance publishes sorted, distinct ISO code lists; a different active Partner approves each once. Inserts happen only inside the protected functions; owner update/delete/truncate are refused | [compliance.md](compliance.md#step-15c-1-api) |
| `aml_risk_assessments`, `aml_risk_assessment_controls` | `0050_compliance_risk.sql` | One serialized, permanent version per submission. PostgreSQL derives the high-risk-country flag, relied-on CDD case, lowered-rating flag and governing controls, forces `high` for mandatory factors and rechecks matter-team access. Written answers are AES-GCM ciphertext bound to `aml-risk:<id>` | [compliance.md](compliance.md#step-15c-1-api) |
| `aml_measures`, `aml_measure_results`, `aml_source_conclusions` | `0051_compliance_measures.sql` | Append-only work on the latest assessment of an open, visible matter. Evidence and people must belong to the relied-on CDD case. Reasoning is AES-GCM ciphertext bound to its record id. Inserts only through protected functions; owner update/delete/truncate refused | [compliance.md](compliance.md#step-15c-2-api) |
| `aml_clearances`, `aml_senior_approvals`, `aml_client_changes` | `0052_compliance_clearance.sql` | One decision per assessment by a non-preparing Compliance holder, fixing the relied-on result and conclusion ids; separate senior approval by another partner. Client identity edits are recorded by trigger. `app.aml_gate` derives the live state. Inserts only through protected functions or the trigger; owner update/delete/truncate refused | [compliance.md](compliance.md#step-15c-3-api) |
| `aml_holds`, `aml_hold_lifts`, `aml_start_exceptions`, `aml_exception_approvals` | `0053_compliance_gate.sql` | Insert-only holds and lifts by Compliance; time- and document-only early starts approved by a separate partner. `zz_aml_gate` triggers on time, billing, document and money tables call `app.assert_aml_gate`; `app.aml_review_queue` lists matters needing attention | [compliance.md](compliance.md#step-15c-4-enforcement-and-api) |
| `audit_events` | `0001_audit_events.sql` | `SELECT`; `INSERT` on descriptive columns only | [audit.md](audit.md) |

TypeScript types for each table live in `apps/api/src/database/schema.ts`.
Columns the app may not write are typed `never` for insert and update, so the
compiler rejects what the database would also reject.
