# Architecture

**Current state (2026-10-08):** The API foundation and the Clients, Matters,
Documents and client portal modules are built, with separate staff and client
screens. The client portal and Tasks module are security-reviewed. Tasks steps
12a to 12c include protected history, the complete staff API and staff
screens. Notifications steps 13a and 13b add the persistent encrypted email
outbox and insert-only staff task notifications with list/read API routes.

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
| Notifications | Steps 13a and 13b built: persistent encrypted email outbox, leased worker and retries; insert-only staff task notifications, transactional audit and list/read API. Step 13c reminders and generic task email are next ([notifications.md](notifications.md)) |
| Finance | Not started |
| Compliance / AML | Not started |
| HR | Not started |
| AI | Not started |
| Web app | Staff screens and the read-only client portal are built: set-up, security headers, API pass-through, account set-up and recovery, clients, matters, documents, tasks and staff administration (`apps/web/`). Both staff and client sides are security-reviewed through the portal work ([web.md](web.md)) |
