# Architecture

**Current state (2026-10-04):** API foundation, audit log, authentication, and users and roles. No business modules yet.
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
| Documents | Designed and approved; building from step 10a ([documents.md](documents.md)) |
| Client portal | Not started |
| Tasks | Not started |
| Notifications | Not started |
| Finance | Not started |
| Compliance / AML | Not started |
| HR | Not started |
| AI | Not started |
| Web app (staff) | Steps 9a to 9e built: set-up, security headers, pass-through to the API, sign in and out, accepting invitations, password reset, client screens, matters, staff administration (`apps/web/`). Security review of the web app next ([web.md](web.md)) |
