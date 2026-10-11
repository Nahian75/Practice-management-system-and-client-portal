# Architecture

**Current state (2026-10-11):** The API foundation and the Clients, Matters,
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
step 15f adds retention/disposal, separated exports and the staff/Compliance screens.

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
| Compliance / AML | Steps 15a to 15f built: firm controls and appointments, versioned CDD/evidence, matter risk and gate enforcement, sanctions screening/freezes/licences, separately encrypted internal disclosures with nominated-officer-only SAR/DAML records, controlled retention/disposal, separated regulatory exports and staff screens ([compliance.md](compliance.md)) |
| HR | Not started |
| AI | Not started |
| Web app | Staff screens and the read-only client portal are built: set-up, security headers, API pass-through, account set-up and recovery, clients, matters, documents, tasks, notifications, Finance, Compliance and staff administration (`apps/web/`). The web foundation, portal and every implemented domain through Finance are security-reviewed; Compliance review follows step 15f ([web.md](web.md)) |
