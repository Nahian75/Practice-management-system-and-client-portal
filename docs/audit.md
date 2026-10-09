# Audit

**Current state (2026-10-09):** The protected audit table and `AuditService`
are used by authentication, staff, clients, matters, documents, portal access,
Tasks, Notifications and Finance steps 14a to 14e.

## Purpose

A permanent record of security-sensitive actions: who did what, to which
record, when, and whether it was allowed. Used for investigations, SRA and
regulatory questions, and spotting attacks.

## What gets recorded

Each module adds its events as it is built. Required by the engineering rules:

- sign-in, failed sign-in, sign-out, 2FA changes, password resets
- permission and role changes
- access to client and matter records
- document upload, download, share
- task creation and later task changes
- AML decisions
- financial transactions and approvals
- HR record access
- security and configuration changes

## Table: `app.audit_events`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Set by the database (`uuidv7()`, time-ordered) |
| `occurred_at` | timestamptz | Set by the database clock |
| `actor_type` | text | `user`, `client`, `system`, `anonymous` |
| `actor_id` | uuid, nullable | Who acted. No foreign key: the record must survive the account being removed |
| `action` | text | `domain.verb`, lower case, e.g. `auth.sign_in_failed` |
| `outcome` | text | `success`, `denied`, `failure` |
| `resource_type`, `resource_id` | text, nullable | What was acted on. Both or neither |
| `ip_address` | inet, nullable | |
| `user_agent` | text, nullable | Max 512 characters |
| `metadata` | jsonb | JSON object, max 4 KB. Extra detail |

## Protections

| Threat | Control |
|---|---|
| The API (or an attacker in it) edits or deletes history | `pms_app` has no `UPDATE`, `DELETE` or `TRUNCATE` privilege |
| A migration or the table owner edits or deletes history | Triggers reject every `UPDATE`, `DELETE` and `TRUNCATE`, including for `pms_owner` |
| Backdated or forged entries | `pms_app` may insert only the descriptive columns. `id` and `occurred_at` always come from the database |
| Junk or oversized entries | Check constraints on every column |
| An action succeeds but its audit entry is lost | `AuditService.record` accepts the caller's transaction, so the action and its audit entry commit or roll back together |

**Not yet covered:** a database superuser can still disable triggers. Detecting
that needs tamper evidence outside the database's control (a hash chain
anchored externally, or shipping events to write-once storage). Planned
before production.

## Rules for callers

- Never put passwords, tokens, session IDs, document contents or full request
  bodies in `metadata`. Record IDs and outcomes.
- Record denied attempts as well as successes: they show attacks.
- For an action that changes data, record inside the same transaction.

Tasks records `task.created` with the task and matter ids, assignee id,
priority, and whether a due date exists. Detail changes use `task.updated`
with changed field names. Assignment uses `task.reassigned` with the old and
new account ids. Status uses `task.completed`, `task.cancelled` or
`task.reopened` with the old and new status. These events are written in the
same transaction as the task and its history, and never copy the title,
description, names or due date into audit metadata. No-op requests create no
event.

Finance records rate and time actions and the billing events
`bill.draft_created`, `bill.draft_updated`, `bill.issued`, `bill.credited`,
`bill.delivered`, `bill.downloaded` and `bill.credit_downloaded`. Bill audit
metadata contains only ids, references, counts, methods and pence totals; it
does not copy supplier/client addresses, line descriptions, credit reasons or
delivery notes. Every billing change and its audit event share one transaction.

Finance step 14c records `finance.bank_account_created`,
`finance.bank_account_closed`, `finance.client_money_received`,
`finance.business_money_received`, `finance.client_money_allocated` and
`finance.business_money_allocated`. Metadata contains only ids, bank kind,
dates, ledger side and exact pence amounts. It never contains a full or partial
bank account number, sort code, bank-account name, receipt reference/purpose,
allocation reason or encryption material. Each change and audit event shares
one database transaction.

Finance step 14d records `finance.client_money_payment_requested`,
`finance.client_money_payment_approved`,
`finance.client_money_payment_rejected`,
`finance.client_money_payment_cancelled`,
`finance.client_money_payment_bank_rejected`, `finance.client_money_paid` and
the sensitive read `finance.client_money_payment_payee_viewed`. Refused
self-approval, invalid-state and insufficient-funds attempts use the same
action with outcome `denied`. Metadata is limited to request, matter, kind,
state and exact pence facts; it never contains the payee, bank reference,
purpose, evidence contents, reason or encryption material. Every successful
state change and its audit event share one transaction.

Finance step 14e records `finance.bank_statement_imported`,
`finance.bank_transaction_matched`,
`finance.bank_transaction_match_reversed`,
`finance.reconciliation_prepared` and `finance.reconciliation_signed_off`.
Metadata is limited to record/account ids, statement dates and row/item counts.
It never copies filenames, statement references/descriptions, reconciliation
explanations or bank details. Every successful change and its audit event share
one transaction; invalid match, reversal and sign-off state is recorded as a
denied event without the sensitive request body.
