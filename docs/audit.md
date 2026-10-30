# Audit

**Current state (2026-10-13):** The protected audit table and `AuditService`
are used by authentication, staff, clients, matters, documents, portal access,
Tasks, Notifications, Finance, Compliance and People / HR steps 16a to 16f.

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

**Privileged database compromise:** a superuser can disable triggers. Independent
Ed25519-signed checkpoints and write-once storage tooling are now available in
`infra/hosting/audit-checkpoint.mjs`; see [security operations](security-operations.md).
This protection requires separate credentials, a trusted initial checkpoint,
scheduled runs and alerts. It is not active merely because the script exists,
and cannot detect every change before the independent observer sees it.

## Rules for callers

- Never put passwords, tokens, session IDs, document contents or full request
  bodies in `metadata`. Record IDs and outcomes.
- Record denied attempts as well as successes: they show attacks.
- For an action that changes data, record inside the same transaction.

People / HR step 16a records `hr.person_created`, `hr.contact_updated`,
`hr.private_details_updated`, `hr.engagement_created`, `hr.terms_recorded`,
`hr.work_pattern_recorded`, `hr.manager_recorded`, `hr.engagement_ended`,
`hr.correction_requested`, `hr.correction_decided`, `hr.file_uploaded`,
`hr.file_downloaded` and HR viewing another person's full record as
`hr.record_viewed`. Change events share the protected database transaction.
Metadata is limited to ids, dates, engagement/category/state facts and file
type/size/visibility. It never copies personal contact data, date of birth,
ending or correction text, filename, file content or encryption material.

Step 16b adds `hr.leave_policy_created`, `hr.leave_entitlement_recorded`,
`hr.leave_requested`, `hr.leave_approved`, `hr.leave_refused`,
`hr.leave_cancelled`, `hr.holiday_pay_recorded`, `hr.sickness_recorded`,
`hr.health_recorded`, `hr.health_viewed`, `hr.adjustment_requested`,
`hr.adjustment_decided`, `hr.adjustment_progress_recorded` and
`hr.adjustments_viewed`. Mutations are recorded in the same transaction. Safe
metadata can include person/request ids, leave kind, dates, minute or pence
totals, fitness status, adjustment outcome/action and retention facts. Leave or
decision reasons, entitlement notes, medical facts, adjustment grounds and
instructions, included narrative, ciphertext and key material never enter the
ordinary audit row.

Step 16c adds `hr.lifecycle_created`, `hr.lifecycle_item_completed`,
`hr.lifecycle_item_reopened`, `hr.lifecycle_completed`,
`hr.lifecycle_reopened`, `hr.right_to_work_recorded`, `hr.vetting_viewed`,
`hr.professional_recorded` and `hr.professional_check_recorded`. Changes and
their audit entry share one transaction. Metadata contains only record/person/
engagement ids, checklist kind/date/item count, version, professional kind or
check status/date. Checklist notes, right-to-work outcomes and private detail,
professional identifiers/restrictions/source/notes, ciphertext, filenames and
encryption material never enter the ordinary audit row.

Step 16d adds `hr.development_cycle_created`,
`hr.development_event_recorded`, `hr.learning_assigned`,
`hr.learning_completed`, `hr.learning_reopened`, `hr.review_recorded`,
`hr.review_acknowledged`, `hr.review_response`, `hr.review_disagreement` and
`hr.competence_viewed`. Mutations and their audit event share one transaction.
Metadata is limited to person/record ids, event kind/state and relevant dates;
reflection, needs, plans, activity/evaluation evidence, requirements, learning
detail/evidence, objective/appraisal text and worker responses never enter it.

Step 16e adds `hr.case_opened`, `hr.case_member_added`,
`hr.case_member_ended`, `hr.case_event_recorded`, `hr.case_viewed`,
`hr.retention_rule_created`, `hr.retention_scheduled`,
`hr.legal_hold_imposed`, `hr.legal_hold_reviewed`, `hr.legal_hold_released`,
`hr.record_disposed`, `hr.export_prepared`, `hr.export_reviewed`,
`hr.export_approved`, `hr.export_rejected` and `hr.export_downloaded`.
Metadata is limited to record, person, case, membership, rule, schedule, run
and export ids plus kinds, states, scopes, versions, dates and counts. It never
copies the issue, evidence, meeting or decision narrative, separation override,
membership-ending reason, retention rationale, schedule evidence, legal-hold
reason, export purpose/content, review note, ciphertext or key material.

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

Finance step 14f records the read/export events
`finance.matter_ledger_exported`, `finance.cash_book_exported` and
`finance.reconciliation_exported`. Metadata is limited to the exported record
id, row/item count, reconciliation date and sign-off state. Ledger purposes,
references and reconciliation explanations are in the authorised attachment,
not copied into audit metadata.
