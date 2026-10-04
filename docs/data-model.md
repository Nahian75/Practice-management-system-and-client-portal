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
| `audit_events` | `0001_audit_events.sql` | `SELECT`; `INSERT` on descriptive columns only | [audit.md](audit.md) |

TypeScript types for each table live in `apps/api/src/database/schema.ts`.
Columns the app may not write are typed `never` for insert and update, so the
compiler rejects what the database would also reject.
