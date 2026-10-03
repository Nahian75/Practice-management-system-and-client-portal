# Architecture

**Current state (2026-10-03):** API foundation, database connection, migrations and the audit log. No business modules yet.
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
| Audit | Table and `AuditService` built; no callers yet |
| Auth | Steps 1–4 of 5: full sign-in, sessions, route guard, sign-out, email, invitations, password reset |
| Users / Roles | Not started |
| Clients | Not started |
| Matters | Not started |
| Documents | Not started |
| Client portal | Not started |
| Tasks | Not started |
| Notifications | Not started |
| Finance | Not started |
| Compliance / AML | Not started |
| HR | Not started |
| AI | Not started |
