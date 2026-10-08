# Audit

**Current state (2026-10-08):** The protected audit table and `AuditService`
are used by authentication, staff, clients, matters, documents, portal access,
Tasks, Notifications and Finance steps 14a and 14b.

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
