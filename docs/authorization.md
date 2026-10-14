# Authorization

**Current state (2026-10-13):** Layers 1 and 2 built, including the
staff-management endpoints. Layer 3 (records) built for clients, matter teams,
compliance access with a reason, client portal links, matter tasks, time and
issued billing records. Finance-wide bank, cash-book and ledger reads are
restricted to Accounts and Compliance; step 14d client-payment actions are
Accounts-only and enforce different request and approval actors in PostgreSQL.
Step 14e gives statement import, matching and preparation only to Accounts and
fixed reconciliation sign-off only to a different Compliance holder.
Step 14f exposes live Finance action capabilities to the staff UI, but those
booleans are presentation only: route guards and PostgreSQL remain the controls.
Compliance steps 15a and 15b separate administrator-only officer appointments,
Compliance-only firm-control work and Partner-only approval, while allowing
Partners and fee earners to prepare CDD only for visible clients and Compliance
to do so firm-wide. Step 15c-1 applies the same split to matter risk
assessments, using active matter-team membership, and lets only a Partner other
than the preparer approve a high-risk-country list. Step 15c-3 gives `aml.approve`
only to Compliance, never to an assessment's preparer, and needs a third person,
a Partner, for high-risk or PEP senior-management approval. Step 15d adds the
Compliance-only `aml.sanctions`. Step 15e gives every staff role submission-only
`aml.internal_report`; reading and deciding require both a live Compliance role
and current nominated-officer appointment in PostgreSQL.
People / HR steps 16a to 16f add a separate `hr` role. All staff roles receive only
the safe directory; self-service and manager routes use live record
relationships, while personnel management, firm-wide leave administration and
restricted health access require the respective permission plus a live HR role
rechecked in PostgreSQL. Lifecycle administration uses `hr.manage`; full
right-to-work history/due work uses `hr.vetting`; professional writes use
`hr.competence`. Confidential cases require current explicit case membership;
retention and fixed exports require live HR authority.

Step 16f exposes `/hr/access` so the staff layout can show only HR areas the
account can use. Those booleans are presentation only. Every action is
authorised again by its controller permission, live role/relationship check and
protected PostgreSQL function. `/hr/reports` is likewise a database-derived
list, not a cached manager grant; superseding the reporting line removes the
person from both the list and detail routes on the next request.

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
| Staff roles | Administrator, Partner, Fee earner, Accounts, Compliance, HR. A person may hold several | Project owner |
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
| `hr` | Personnel records and employment lifecycle; no account, client, matter, Finance, audit or Compliance access by default |

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
| `tasks.view` - read tasks on matters you are on the team of ([rules](tasks.md)) | | ✓ | ✓ | | |
| `tasks.create` - create and assign tasks on open matters you are on the team of | | ✓ | ✓ | | |
| `tasks.manage` - edit, reassign and change status under the task rules | | ✓ | ✓ | | |
| `time.record` - record and correct your own time on a visible matter | | ✓ | ✓ | | |
| `finance.matter.view` - read time for a matter allowed by the record rule | | ✓ | ✓ | ✓ | ✓ |
| `finance.view_all` - read Finance records across matters | | | | ✓ | ✓ |
| `rates.manage` - create permanent effective staff rates | | | | ✓ | |
| `bills.manage` - prepare, issue, credit and record delivery of bills | | | | ✓ | |
| `client_money.record` - record bank accounts, receipts and allocation corrections | | | | ✓ | |
| `client_money.request` - request or cancel a client-account payment | | | | ✓ | |
| `client_money.approve` - approve or reject another Accounts holder's request | | | | ✓ | |
| `finance.reconcile` - import statements, match transactions and prepare reconciliation | | | | ✓ | |
| `finance.reconciliation_sign_off` - sign a fixed reconciliation prepared by someone else | | | | | ✓ |
| `aml.officers.manage` - record and end nominated-officer and deputy appointments, without AML-content access | ✓ | | | | |
| `aml.firm_controls` - prepare and read fixed firm controls, training records and independent reviews | | | | | ✓ |
| `aml.firm_approve` - approve a firm-control version prepared by someone else | | ✓ | | | |
| `aml.assess` - prepare CDD for a client allowed by the record rule | | ✓ | ✓ | | ✓ |
| `aml.view_evidence` - read protected CDD detail and evidence under the same record rule | | ✓ | ✓ | | ✓ |
| `aml.approve` - decide AML clearance and ordinary holds | | | | | ✓ |
| `aml.sanctions` - import/screen/resolve sanctions records and licences | | | | | ✓ |
| `aml.internal_report` - submit a confidential internal disclosure, never read it back | ✓ | ✓ | ✓ | ✓ | ✓ |
| `aml.retention` - schedule retention, record legal holds and run controlled disposal | | | | | ✓ |
| `aml.export` - create and download fixed ordinary AML regulatory bundles | | | | | ✓ |

The HR role is intentionally omitted from the established-role matrix above:
it receives none of those permissions except `aml.internal_report`, which all
active staff can use. Step 16a adds this separate matrix:

| Permission | Administrator | Partner | Fee earner | Accounts | Compliance | HR |
|---|---:|---:|---:|---:|---:|---:|
| `hr.directory` - safe work directory | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `hr.manage` - personnel and employment history | | | | | | ✓ |
| `hr.leave` - firm-wide entitlement, absence and holiday-pay evidence | | | | | | ✓ |
| `hr.health` - health facts, adjustment grounds and private decisions | | | | | | ✓ |
| `hr.vetting` - right-to-work and professional-check evidence | | | | | | ✓ |
| `hr.competence` - qualifications, development and reviews | | | | | | ✓ |
| `hr.cases` - open and participate in explicitly assigned confidential cases | | | | | | ✓ |
| `hr.retention` - define rules, schedule records, manage holds and run disposal | | | | | | ✓ |
| `hr.export` - prepare, review and download fixed HR bundles | | | | | | ✓ |

The AI module adds a separate least-privilege matrix:

| Permission | Administrator | Partner | Fee earner | Accounts | Compliance | HR |
|---|---:|---:|---:|---:|---:|---:|
| `ai.use` - generate matter summaries, chronologies and draft correspondence | | ✓ | ✓ | | | |
| `ai.manage_config` - configure providers, models and token limits | | ✓ | | | | |
| `ai.audit` - inspect AI audit events, token metrics and review statistics | | ✓ | | | ✓ | |

Self-service does not grant `hr.manage`. The database binds `/hr/me` to the
caller's account and `/hr/reports/:personId` to the current effective reporting
line. A former manager loses access on the next request. Administrator and
Partner roles do not imply personnel access.

Leave and adjustment routes add record rules after the HTTP permission check.
A worker can request and cancel their own leave and adjustment request. The
current effective manager can read a bounded leave/sickness projection, decide
only ordinary annual leave, and record operational adjustment progress, but
cannot self-approve, see holiday pay or entitlement notes, read health facts or
see adjustment grounds/private decisions. HR can administer all categories.
Every protected function rechecks the live relationship or HR role.

Lifecycle and vetting routes use the same live subject/manager/HR record rule.
The worker gets current safe status, while a current manager gets only expiry/
action and public professional status. Full right-to-work versions and private
professional fields require HR. Leaver blockers are a read-only projection:
HR cannot disable the account, remove protected roles, transfer client/matter/
task ownership or end AML appointments through the HR module.

Competence routes re-use the live subject/current-manager/HR record rule but
also enforce authorship by event kind. The worker alone owns reflection, needs,
plans, activities, evaluations and review responses; manager/HR alone add
requirements, reviews, status, objectives and appraisals. Only HR assigns firm
learning, and only the worker or HR records completion. The AML-training view
is a separate Compliance-owned projection containing status fields only.

Confidential-case routes require staff authentication and current explicit case
membership in PostgreSQL; the `hr.cases` route permission alone never reveals a
case. The opening HR holder is the first HR member. A live HR case member may
manage membership, while an assigned investigator, decision-maker or appeal
officer may act only within that role. A designated Partner or other active
staff member can therefore participate without broad HR access. Membership as
an HR member additionally requires the account to retain its live HR role, so
revocation takes effect on the next request and serializes with an in-flight
read. Both preparer and reviewer must retain membership in every included case.

Retention and export routes require `hr.retention` or `hr.export` plus a live HR
role rechecked by the protected database function. Export approval requires a
different active HR holder from the preparer; only an approved fixed bundle may
be downloaded. Small-firm procedural-role overlap is exceptional and requires
an encrypted reason, while the last live HR case owner cannot be removed.

Restricted-report reads and decisions deliberately have no role permission that
an administrator can grant. Each protected database function locks and rechecks
the active account, active `compliance` role and current nominated-officer
appointment. Losing any one removes access on the next request; a concurrent
read and role/appointment loss commit in a defined order.

Step 15f ordinary retention and export routes require active Compliance plus
`aml.retention` or `aml.export`; protected database functions recheck the role.
The Compliance client picker is not a grant of general client access: it is a
bounded four-field protected function for these firm-wide workflows.

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
    administrator could grant themselves a sensitive role and read protected data.
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
  `compliance`, `accounts` or `hr` is granted, so a misused administrator account
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

Once an administrator records a nominated officer, the same lock also prevents
ending the last live appointment, disabling its holder or removing that
holder's Compliance role unless another active appointed Compliance holder
remains. The administrator can manage appointment metadata but receives no
firm-control content through that permission.

### First administrator

The command-line invitation gains `--role administrator`, so the first
account can be created with the role it needs. After that, staff are
invited through the API by an administrator.

## Layer 3: matters, clients, tasks, time, bills and portal links (built)

Decided by the project owner: **only people assigned to a matter can open it.**

- A matter has a team: fee earners and a supervising partner.
- Staff see a matter, its documents and its client only through a team they
  belong to. Holding the `partner` role alone does not open every matter.
- Tasks use that same filter for every list and detail query. Creation also
  requires an open matter and an active assignee on the team; PostgreSQL
  rechecks and locks those records during the insert.
- Task detail and assignment changes require active team membership. Status
  changes additionally require the current assignee or active supervising
  partner. PostgreSQL applies the same rules while holding the matter and task
  locks.
- Partners and fee earners see time only through current matter-team
  membership. They record and correct only their own time. Accounts and
  Compliance hold `finance.view_all` and may read time across matters; only
  Accounts creates rates. Live account, role and team checks are repeated by
  PostgreSQL when a time or correction row is inserted.
- Partners and fee earners read issued bill and credit-note records only for
  matters on whose current team they serve. Accounts and Compliance can read
  them firm-wide. Only an active Accounts holder can create or replace drafts,
  issue or credit a bill, and record delivery. PostgreSQL rechecks that live
  role and freezes a draft when it is issued.
- Staff notification routes need a signed-in staff account rather than a role
  permission. Each row is restricted to its named recipient and joined through
  the task's current active matter team; losing membership hides it at once.
  Marking it read repeats those checks in PostgreSQL and records the first read
  only.
- Compliance can open a matter they are not on only by recording a reason,
  which is audited and visible to the matter's supervising partner.
- Clients see only their own matters, and only what is marked as shared with
  them. Internal notes, internal documents and AML records are never shared.
- Every portal query checks the client account's live link. Organisation links
  also require the named contact to remain active. Matter lists exclude work
  awaiting conflict clearance; document lists and downloads require the
  document to remain shared and not withdrawn, and expose only its latest
  version.
- Every query for records filters by these rules in the database query
  itself, so a forgotten check cannot return another matter's data.
