# Architecture

**Current state (2026-10-13):** The API foundation and the Clients, Matters,
Documents and client portal modules are built, with separate staff and client
screens. The client portal, Tasks and Notifications modules are
security-reviewed. Tasks steps
12a to 12c include protected history, the complete staff API and staff
screens. Notifications steps 13a to 13d add the persistent encrypted email
outbox, insert-only staff task notifications, list/read API routes, generic
assignment email, database-deduplicated due-date reminders and staff screens.
The notification review fixes future reminder windows and mismatched task-mail
recipient addresses. Finance steps 14a to 14f and its security review add exact
money conversion,
permanent staff rates and time history, billing snapshots, an encrypted bank
register, balanced postings, receipts, allocation corrections and derived
matter ledgers/cash books, encrypted client-payment requests, four-eyes
approval, reservations, recorded bank outcomes, safe statement imports,
immutable matching, fixed client reconciliations, Compliance sign-off and
five-week status, staff workspaces and reviewed balance, authority and VAT
safeguards. The Compliance / AML design is approved; steps 15a and 15b add the
firm-wide foundations plus versioned client CDD, identity/ownership/authority
facts and separately encrypted evidence; steps 15c and 15d add risk assessments,
clearance, the enforced compliance gate, and sanctions screening, holds, freezes
and licences; step 15e adds the separately encrypted nominated-officer restricted-report boundary;
step 15f adds retention/disposal, separated exports and the staff/Compliance screens,
and the Compliance security review is complete. The People / HR design is
approved; steps 16a and 16b add the separate HR role, protected employment
history, encrypted personnel data/files, exact leave evidence, reason-free
sickness administration, restricted health records and operational adjustment
projections; step 16c adds protected lifecycle checklists, right-to-work
versioning/follow-ups and professional-status history without giving HR account
or owning-module authority; step 16d adds encrypted competence/review history
and a narrow Compliance-owned AML-training status projection; step 16e adds
membership-scoped confidential cases, category retention/disposal and
two-person reviewed fixed exports; step 16f adds the staff, current-manager and
least-privilege HR screens over those filtered API boundaries.
The client-onboarding addendum is implemented in steps 17a to 17f: central
policy library, staff acknowledgements, contact verification, requested portal evidence,
identity and company review with Companies House adapter, enhanced conflicts with
safeguards and activation gates, versioned engagement documents, wet/portal signing,
and fee estimates, budgets, initial payment requests and manual bank reconciliation handoff
([onboarding.md](onboarding.md), [review](reviews/2026-10-13-onboarding.md)).
The Artificial Intelligence & Legal Drafting Assistant module is implemented in steps 18a to 18f:
foundation schema, permissions, provider-neutral architecture and offline mock (18a);
matter boundary enforcement, pre-prompt UK PII/financial redaction and delimiter injection defense (18b);
document summarisation, chronology extraction and citation grounding verification (18c);
correspondence drafting, attendance note structuring and human-in-the-loop review state machine with
document/task promotion (18d); token budgeting, rate limits and supervisory audit controls (18e);
staff web workbench and supervisory governance dashboard (18f); and security review with
adversarial penetration verification ([ai.md](ai.md), [ai-security.md](ai-security.md)).
Pre-production hardening and go-live readiness is implemented in steps 19a to 19d:
edge reverse proxy configurations for Nginx and Caddy with streaming upload boundaries and sign-in
brute-force rate limiting (19a); automated ephemeral security data retention sweep for expired sessions,
failures, resets, invitations and outbox rows via migration 0075 and CLI command (19b); encrypted storage,
backup immutability, RPO/RTO targets and post-restore disposal replay runbook (19c); and production
hygiene gate script (19d) ([deployment.md](deployment.md), [disaster-recovery.md](disaster-recovery.md), [security.md](security.md)).

This file describes the target shape. Sections are updated as each part is built.

## Shape

```
Browser (staff)  ─┐
                  ├─► Next.js ──► NestJS API ──► PostgreSQL
Browser (client) ─┘                   │
                                      └──► Private object storage (documents)
```

- **Next.js** renders the staff app and the client portal. It holds no business rules.
- **NestJS** is the only component that reads or writes data and the only
  place authorization is decided.
- **PostgreSQL** is private and never reachable from the internet.

See [decisions.md](decisions.md) for why.

## Backend layering

```
Controller   validates input with a DTO, calls one service method,
             returns the response
Service      business rules and authorization decisions
Repository   database queries only
```

Controllers never touch the database. Repositories never make business or
authorization decisions.

## Modules

| Module | Status |
|---|---|
| Audit | Built; used by Auth, Users / Roles and Clients |
| Auth | Built: sign-in with password and 2FA, sessions, route guard, invitations, password reset, notices, per-account and per-address limits |
| Users / Roles | Built: roles, permissions, permission guard, staff-management endpoints (`apps/api/src/auth/permissions/`, `apps/api/src/staff/`) |
| Clients | Built: create, open, list, search, edit and take over clients, and contacts (`apps/api/src/clients/`). Security-reviewed: C1–C4, C8 and C10 fixed; C5 with Matters, C6 before production ([review](reviews/2026-10-04-clients.md)) |
| Matters | Built: opening matters with teams and a required conflict check, other parties, conflict clearance, team changes, supervision takeover, editing and closing, compliance access with a reason, team visibility (`apps/api/src/matters/`). Security-reviewed: M1, M2 and M4 fixed; M5 open for design ([review](reviews/2026-10-05-matters.md)) |
| Documents | Built (10a to 10d, and portal 11b): API and staff screens, including sharing with the client ([documents.md](documents.md)) |
| Client portal | Steps 11a to 11d built and security-reviewed: portal access for clients' people, document sharing, staff controls, the read-only client API and separate client screens ([portal.md](portal.md), [review](reviews/2026-10-07-portal.md)) |
| Tasks | Steps 12a to 12c built and security-reviewed: database safeguards and insert-only history, permissions, audit, create/read/change staff API and staff screens (`apps/api/src/tasks/`, `apps/web/src/app/(staff)/tasks/`, [tasks.md](tasks.md), [review](reviews/2026-10-07-tasks.md)) |
| Notifications | Steps 13a to 13d built and security-reviewed: persistent encrypted email outbox, leased worker and retries; insert-only staff task notifications, transactional audit and list/read API; generic assignment email and 09:00 Europe/London due reminders with database-bounded catch-up and final live-state/address checks; staff header count and inbox ([notifications.md](notifications.md), [review](reviews/2026-10-08-notifications.md)) |
| Finance | Steps 14a to 14f built and security-reviewed: exact GBP strings, permissions, immutable rates/time corrections, billing snapshots, encrypted bank/payee details, balanced postings, receipts, allocations, running ledgers/cash books, client-payment reservations, four-eyes approval, bank outcomes, safe CSV statements, immutable matching/reversals, fixed client reconciliation with liability balances, Compliance sign-off, five-week status, numeric VAT documents, audited exports and role-sensitive staff screens (`apps/api/src/finance/`, `apps/web/src/app/(staff)/finance/`, [finance.md](finance.md), [review](reviews/2026-10-10-finance.md)) |
| Compliance / AML | Steps 15a to 15f built and security-reviewed: firm controls and appointments, versioned CDD/evidence, matter risk and gate enforcement, sanctions screening/freezes/licences, separately encrypted internal disclosures with nominated-officer-only SAR/DAML records, controlled retention/disposal, separated regulatory exports and staff screens ([compliance.md](compliance.md), [review](reviews/2026-10-11-compliance.md)) |
| People / HR | Steps 16a to 16f built and security-reviewed: separate HR authority; protected employment/work-pattern and lifecycle history; encrypted personal data/files, right-to-work detail and competence/review narratives; safe self/manager views; exact minute leave ledger and serialized decisions; payroll-supplied holiday-pay evidence; reason-free sickness; restricted health and operational adjustment projections; leaver blockers; qualifications/professional checks; development, required learning, objectives, appraisals and worker responses; explicit confidential-case teams and role separation; category rules, legal holds, controlled disposal and reviewed fixed exports; complete People, My team and least-privilege HR screens ([hr.md](hr.md), [review](reviews/2026-10-14-hr.md)) |
| Client onboarding | Steps 17a to 17f built and security-reviewed: provider-neutral/manual-first policy, contact, evidence, identity/company, conflicts, engagement, fee estimates, budgets, initial payment handoff and staff/portal screens ([onboarding.md](onboarding.md), [review](reviews/2026-10-13-onboarding.md)) |
| AI | Step 18a built: provider-neutral architecture, governance schema (`app.ai_*`), permissions (`ai.use`, `ai.manage_config`, `ai.audit`), immutability triggers, matter access enforcement (`app.assert_matter_ai_access`), token budget accounting, and deterministic offline mock provider (`OfflineMockAiProvider`). Steps 18b to 18f in progress ([ai.md](ai.md), [ai-security.md](ai-security.md)) |
| Web app | Staff screens and the read-only client portal are built: set-up, security headers, API pass-through, account set-up and recovery, clients, matters, documents, tasks, notifications, Finance, Compliance, HR, Client onboarding and staff administration (`apps/web/`). The web foundation, portal and every implemented domain through HR and Onboarding are security-reviewed ([web.md](web.md)) |
