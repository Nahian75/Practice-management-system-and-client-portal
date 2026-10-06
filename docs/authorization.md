# Authorization

**Current state (2026-10-04):** Layers 1 and 2 built, including the
staff-management endpoints. Layer 3 (records) built for clients, matter teams, and compliance access with
a reason.

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

## Layer 2: roles and permissions (built)

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

Each module adds its own permissions when it is built. These exist now:

| Permission | Administrator | Partner | Fee earner | Accounts | Compliance |
|---|---|---|---|---|---|
| `staff.view` — list staff and their roles | ✓ | ✓ | | | ✓ |
| `staff.invite` — invite a staff account | ✓ | | | | |
| `staff.roles.manage` — grant and revoke roles | ✓ | | | | |
| `staff.disable` — disable a staff account | ✓ | | | | |
| `audit.view` — read the audit log | | | | | ✓ |
| `clients.create` — create a client | | ✓ | ✓ | | |
| `clients.view` — open a client you can see ([visibility](clients.md#who-can-do-what)) | | ✓ | ✓ | | |
| `clients.search` — find any client by name or reference (summary only) | | ✓ | ✓ | | |
| `clients.edit` — change the details of a client you can see | | ✓ | ✓ | | |
| `matters.open` — open matters for clients you can see | | ✓ | ✓ | | |
| `matters.view` — open matters you are on the team of | | ✓ | ✓ | | |
| `matters.edit` — change the title and type of your matters | | ✓ | ✓ | | |
| `matters.access_with_reason` — open any matter read-only, for one request, by recording a reason | | | | | ✓ |
| `matters.supervise` — clear conflicts and change the team on matters you supervise; take over supervision from a partner who can no longer act; close matters you supervise ([rules](matters.md#opening-a-matter)) | | ✓ | | | |
| `documents.view` — list and download the documents of matters you are on the team of | | ✓ | ✓ | | |
| `documents.add` — add documents to open matters you are on the team of ([rules](documents.md#who-can-do-what)) | | ✓ | ✓ | | |
| `documents.withdraw` — withdraw a document you added, or any on a matter you supervise, with a reason | | ✓ | ✓ | | |
| `documents.share` — share a document with the client, or stop sharing it | | ✓ | ✓ | | |
| `portal.invite` — invite a client's person to the portal, at the address on record, and end their access ([rules](portal.md)) | | ✓ | ✓ | | |
| `clients.take_over` — become responsible for a client whose responsible person can no longer see it ([rules](clients.md#taking-over-a-client)) | | ✓ | | | |

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
  - The last active administrator, and the last active `compliance` holder,
    cannot be removed or disabled.
  - Disabling an account ends all its sessions immediately.
  - Only staff accounts can hold roles; the database enforces it.
- **Everything is audited:** invitations, role grants and revocations, disabling,
  and every 403 caused by a missing permission. Each change is recorded in the
  same transaction as the change, with the caller's address and browser, so a
  change without its record cannot happen.
- **Role changes are emailed.** The person is told whenever a role is granted
  or revoked, and every active compliance holder is told when `administrator`,
  `compliance` or `accounts` is granted, so a misused administrator account
  cannot hand out access quietly. See the notice table in
  [authentication.md](authentication.md#security-notice-emails).
- **Refusals are audited too.** Trying to change your own account, or to remove
  the last administrator or compliance holder, is recorded as
  `staff.change_refused`.

### Staff management

`apps/api/src/staff/`. Endpoints are listed in [api.md](api.md).

| Action | Permission | Audit event |
|---|---|---|
| List staff and their roles | `staff.view` | — |
| Invite a staff member | `staff.invite` | `account.invited` |
| Grant a role | `staff.roles.manage` | `staff.role_granted` |
| Revoke a role | `staff.roles.manage` | `staff.role_revoked` |
| Disable an account | `staff.disable` | `staff.disabled` (with how many sessions were ended) |
| Re-enable an account | `staff.disable` | `staff.enabled`, then `account.invited` |
| Any of the above refused by a safeguard | — | `staff.change_refused` (with the reason) |

- Invitations carry no roles. Roles are granted separately, which can be done
  while the person is still invited.
- Disabling keeps the account's roles, so the record shows what the person
  could do while it was in use.
- Re-enabling does not restore the old password. The account goes back to
  `invited`, its password is removed and a new invitation is emailed; the
  person chooses a new password and confirms with their existing authenticator
  app. Earlier sessions stay ended. The kept roles apply again once the
  invitation is accepted.
- Only staff accounts are found by these endpoints. A client account's id
  gives 404.

### The last administrator and compliance holder

Removing the administrator role, and disabling an administrator, both check
that another **active** administrator remains (invited and disabled ones do not
count). Over the API this can only be reached by a race: since nobody can
change their own account, whoever makes the change is another administrator.
Two administrators removing each other at the same moment would each see the
other still there. Both changes therefore take a PostgreSQL advisory lock
(`pg_advisory_xact_lock`) before counting, so they run one after the other and
the second is refused. `last-holder.exclusive.spec.ts` makes that race
happen on every run.

The same rule protects `compliance`: without it nobody can read the audit log
in the app, and the only record of that gap would be a later grant. The roles
covered are listed in `PROTECTED_ROLES` (`permissions.ts`); both share one lock.
The 409 names the role that would be left without a holder.

### First administrator

The command-line invitation gains `--role administrator`, so the first
account can be created with the role it needs. After that, staff are
invited through the API by an administrator.

## Layer 3: matters and clients (built)

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
