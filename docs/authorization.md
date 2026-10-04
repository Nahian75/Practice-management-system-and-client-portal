# Authorization

**Current state (2026-10-04):** Layer 1 built. Layer 2 built: roles, permissions and
`@RequirePermission`; staff-management endpoints next (6b). Layer 3 (records)
designed in outline, built with Matters.

Three layers, each checked by the server on every request. A request must pass
all that apply. Hiding something in the user interface is never a control.

```
Layer 1  Who may call the route?      signed in? staff or client?        (built)
Layer 2  What may this person do?     roles → permissions                 (this module)
Layer 3  Which records?               assigned to this matter or client?  (Matters module)
```

## Layer 1: route audience (built)

`SessionGuard` (`apps/api/src/auth/sessions/session.guard.ts`) runs before
every route and is registered in `configureApp`, so the app cannot start
without it.

- Every route must carry `@Public()`, `@StaffOnly()`, `@ClientOnly()` or
  `@AnyAccount()`. A route with none returns 500 and never runs.
- A staff session on a client route, or a client session on a staff route,
  gets 403 and is recorded as `auth.access_denied`.
- A session still waiting for its 2FA code is treated as signed out.

## Layer 2: roles and permissions (designed)

### Decisions

| Topic | Decision | Decided by |
|---|---|---|
| Staff roles | Administrator, Partner, Fee earner, Accounts, Compliance. A person may hold several | Project owner |
| Who invites staff | Administrator only | Project owner |
| Four-eyes approval | Client money payments out (built with Finance) | Project owner |
| Role and permission model | Fixed permissions in code; roles grant sets of permissions; assignments in the database | ADR-009 |

Clients have no roles. What a client may see is decided by layer 3 only.

### Roles

| Role | Purpose |
|---|---|
| `administrator` | Manages staff accounts and roles. Not tied to seniority: can be held by a partner or an office manager |
| `partner` | Supervises matters and fee earners |
| `fee_earner` | Runs matters day to day |
| `accounts` | Client and office money, bills, reconciliation |
| `compliance` | Regulatory oversight: COLP, COFA, MLRO duties, audit log |

### Permissions in this module

Each module adds its own permissions when it is built. Only these exist now:

| Permission | Administrator | Partner | Fee earner | Accounts | Compliance |
|---|---|---|---|---|---|
| `staff.view` — list staff and their roles | ✓ | ✓ | | | ✓ |
| `staff.invite` — invite a staff account | ✓ | | | | |
| `staff.roles.manage` — grant and revoke roles | ✓ | | | | |
| `staff.disable` — disable a staff account | ✓ | | | | |
| `audit.view` — read the audit log | | | | | ✓ |

Administrators deliberately cannot read the audit log: the people who change
accounts should not be the only ones checking what changed.

### Rules

- **Checked on every request from the database.** Permissions are not copied
  into the session, so revoking a role takes effect on the next request.
- **Routes declare the permission they need** with `@RequirePermission(...)`,
  which also makes the route staff-only, so the two cannot disagree. A route
  without it is open to any signed-in account its audience allows; that is a
  choice made per route, reviewed like any other code.
- **Two guards, in order:** `SessionGuard` (layer 1) then `PermissionGuard`
  (layer 2), both registered in `configureApp`. Swapping the order fails the tests.
- **The permission table is pinned by a test** (`permissions.spec.ts`), so
  widening a role always shows up in review.
- **Role history is kept.** A revoked role is marked revoked, never deleted,
  so the database shows who held which role and when.
- **Safeguards on account management:**
  - Nobody can change their own roles, grant or revoke. Otherwise an
    administrator could grant themselves `compliance` and read the audit log.
  - Nobody can disable their own account.
  - The last active administrator cannot be removed or disabled.
  - Disabling an account ends all its sessions immediately.
  - Only staff accounts can hold roles; the database enforces it.
- **Everything is audited:** invitations, role grants and revocations, disabling,
  and every 403 caused by a missing permission.

### First administrator

The command-line invitation gains `--role administrator`, so the first
account can be created with the role it needs. After that, staff are
invited through the API by an administrator.

## Layer 3: matters and clients (outline, built with Matters)

Decided by the project owner: **only people assigned to a matter can open it.**

- A matter has a team: fee earners and a supervising partner.
- Staff see a matter, its documents and its client only through a team they
  belong to. Holding the `partner` role alone does not open every matter.
- Compliance can open a matter they are not on only by recording a reason,
  which is audited and visible to the matter's supervising partner.
- Clients see only their own matters, and only what is marked as shared with
  them. Internal notes, internal documents and AML records are never shared.
- Every query for records filters by these rules in the database query
  itself, so a forgotten check cannot return another matter's data.
