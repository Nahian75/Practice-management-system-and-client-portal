# Data Model

**Current state (2026-10-03):** Databases, roles, the migration runner, the audit table and the accounts table exist.

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
| `matter_team` | `0016_matters.sql` | `SELECT`; `INSERT` of matter, account, role and adder. No `UPDATE` or `DELETE` yet. One active membership per person and one supervising partner per matter (partial unique indexes). Trigger: active staff holding a role that allows the team role | [matters.md](matters.md) |
| `client_responsibility_changes` | `0012_client_takeover.sql` | `SELECT`; `INSERT` of client, from, to and reason only. A `SECURITY DEFINER` trigger checks the takeover rules and applies the change to `clients.responsible_id`. No row can be changed or deleted, for every role | [clients.md](clients.md#taking-over-a-client) |
| `client_individuals`, `client_organisations` | `0010_clients.sql`, `0011_client_editing.sql` | `SELECT`, `INSERT`; `UPDATE` of every detail column, not `client_id`. No `DELETE`. One row per client (primary key); a trigger keeps it to the client's kind | [clients.md](clients.md) |
| (client text) | `0015_client_text_safe.sql` | `app.is_safe_text()` checks every client text column and the takeover reason: no control characters, line separators or direction overrides. `pms_app` is granted `EXECUTE` on it, since new functions carry no rights by default | [review C4](reviews/2026-10-04-clients.md) |
| `audit_events` | `0001_audit_events.sql` | `SELECT`; `INSERT` on descriptive columns only | [audit.md](audit.md) |

TypeScript types for each table live in `apps/api/src/database/schema.ts`.
Columns the app may not write are typed `never` for insert and update, so the
compiler rejects what the database would also reject.
