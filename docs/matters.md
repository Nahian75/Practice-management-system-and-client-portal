# Matters

**Current state (2026-10-04):** Step 8a built: matters and teams, opening a
matter (without a conflict check yet), seeing your matters, and client
visibility through matter teams. The rest is designed below and not built yet.

A matter is one piece of work the firm does for a client: a house purchase, a
divorce, a claim. Almost everything later hangs off a matter: documents, tasks,
time, bills, and what a client sees in the portal.

## Decisions

| Topic | Decision | Decided by |
|---|---|---|
| Numbering | Client reference plus a counter per client: `C-000123/001` | Project owner |
| Who opens matters | Partners and fee earners; every matter names a supervising partner from the start | Project owner |
| Possible conflict found | The matter cannot be worked on until its supervising partner records why it is not a conflict. Audited, and compliance holders are emailed | Project owner |
| Who sees a client once it has matters | The client's responsible person, plus every member of any of its matter teams | Project owner |
| Who sees a matter | Its team only; holding the partner role alone opens nothing | Project owner (authorization.md, layer 3) |
| Compliance access to other matters | Only by recording a reason, audited and visible to the supervising partner | Project owner (authorization.md, layer 3) |
| Deleting matters | Never. Matters are closed | Rule: records are kept |

## What a matter holds

- **Reference** `C-000123/001`, set by the database and never reused. Past 999
  matters for one client the counter simply grows (`/1000`).
- **Client**, fixed once opened.
- **Title**, a short description ("Purchase of 12 High Street").
- **Type** from a fixed list: `residential_property`, `commercial_property`,
  `family`, `litigation`, `employment`, `wills_probate`, `corporate`,
  `immigration`, `crime`, `other`. Changing the list is a migration, reviewed
  like a permission change.
- **Status:** `awaiting_clearance` → `open` → `closed`. A matter with no
  possible conflict starts as `open`.
- **Team:** one supervising partner (must hold the partner role when added) and
  any number of fee earners. Membership history is kept: removing someone
  closes their row, it is never deleted.
- **Other parties:** people and organisations involved who are not the client:
  `opponent`, `opponent_solicitor`, `other`. Name, and organisation or
  individual. Used by conflict checks.
- Opened by and when; closed by, when and why.

## Tables

| Table | Holds | `pms_app` may update |
|---|---|---|
| `matters` | id, client, number, reference, title, type, status, opened by/at, closed by/at, close reason | `title`, `matter_type`; status only through the rules below |
| `matter_team` | matter, account, role (`supervising_partner` / `fee_earner`), added by/at, removed by/at | `removed_at`, `removed_by` only |
| `matter_parties` | matter, role, kind, name | the name and role |
| `conflict_checks` | who ran it, for which client, the names checked, how many possible matches, when | nothing |
| `conflict_clearances` | matter, check, partner, reason, when | nothing |

As for clients, no deleting anywhere, and the rules that matter most are
enforced by the database as well as the API:

- The number and reference are set by a trigger under a per-client lock, so two
  matters opened at once for one client get different numbers.
- At most one active supervising partner per matter (partial unique index), and
  every open matter has one.
- A matter moves from `awaiting_clearance` to `open` only by recording a row in
  `conflict_clearances`, by the matter's supervising partner (same pattern as
  client takeover: the app cannot set the status directly).
- Closed matters cannot be changed.

## Built in 8a

- `matters` and `matter_team` (migration `0016`). The number and reference
  are set by a trigger under a per-client advisory lock; a test opens ten
  matters for one client at once and gets numbers 1 to 10.
- The database refuses: a matter opened by a non-staff account; a matter with
  no supervising partner when its transaction commits; a supervising partner
  without the partner role; a team member who is not active staff holding
  `partner` or `fee_earner`; two supervising partners or the same person twice.
  The trigger keeps its own role list, and a test runs every role through it
  and the permission table.
- The app may insert only the client, title, type and opener, and the team
  rows; it cannot update or delete anything yet.
- `visibleTo` in `matters.repository.ts` is the matter rule; the client rule in
  `clients.repository.ts` now also admits active members of the client's matter teams.
- `matter.opened` (client id, type, status) and one `matter.team_member_added`
  per member (account and role), in the same transaction. The title stays out.

## Opening a matter

1. **Run a conflict check:** `POST /conflict-checks` with the client and the
   names of the other parties. It returns possible matches and a check id.
2. **Open the matter:** `POST /matters` with the client, title, type,
   supervising partner, fee earners, other parties, and the check id.
   - The check must be for the same client, by the same person, less than
     24 hours old, and not used before.
   - The person opening it is put on the team: as supervising partner if they
     are a partner and chose themselves, otherwise as a fee earner.
   - No possible matches: status `open`. Possible matches: status
     `awaiting_clearance`.
3. **Clear a possible conflict:** `POST /matters/:id/conflict-clearance` with a
   reason (10 to 500 characters), by the supervising partner only. Status
   becomes `open`, and every compliance holder is emailed (matter reference
   only, as for takeovers).

While `awaiting_clearance`, the matter is visible to its team, but nothing can
be added to it.

## Conflict checks

A check compares each name given against:

- every client's name (individuals' full names, organisations' legal names),
- every contact of an organisation client,
- every other party on every matter.

Matching ignores case, accents and punctuation, and uses trigram similarity
(`pg_trgm`, review item C5 of Clients), so "Jon Smyth" finds "John Smith".
The threshold is set by test against realistic spellings.

`pg_trgm` is a PostgreSQL extension. The migration role `pms_owner` may not
install extensions (it has no `CREATE` right on the database, by design), so
the superuser installs it once: a line in `infra/postgres/init/` for new
databases, and a documented one-off command for existing ones. Migrations then
only check that it is there.

A possible match shows the name, the reference of the client or matter, and
how it relates (client, contact, opponent, ...). Nothing else: no addresses,
no matter details. That is what a conflict check needs, and the same principle
as client search. Checks count towards the same hourly search limit as client
search (review C2), and each is stored with its names and match count; the
names stay out of the audit log.

## Who can do what

| Permission | Administrator | Partner | Fee earner | Accounts | Compliance |
|---|---|---|---|---|---|
| `matters.open` — run conflict checks and open matters | | ✓ | ✓ | | |
| `matters.view` — open matters you are on the team of | | ✓ | ✓ | | |
| `matters.edit` — change title, type and other parties of your matters | | ✓ | ✓ | | |
| `matters.supervise` — clear conflicts, manage the team, close; on matters you supervise | | ✓ | | | |
| `matters.access_with_reason` — open any matter, recording why | | | | | ✓ |

As for clients, a permission is never enough on its own: every query for a
matter filters by its team in the database query itself (`visibleTo`), and a
matter you may not see answers 404.

**Client visibility** widens: a client is visible to its responsible person
and to every active member of any of its matter teams. Takeover rules are
unchanged.

## API

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/conflict-checks` | `matters.open` | `{clientId, names[]}` → check id and possible matches |
| POST | `/matters` | `matters.open` | Opens a matter, see above. 201 `{id, reference, status}` |
| GET | `/matters` | `matters.view` | Your matters, newest first, paged |
| GET | `/matters/:id` | `matters.view` + team | Details, team, other parties |
| PATCH | `/matters/:id` | `matters.edit` + team | Title, type |
| POST/PATCH | `/matters/:id/parties` | `matters.edit` + team | Add or change other parties |
| POST | `/matters/:id/conflict-clearance` | `matters.supervise` + supervising partner | `{reason}` |
| PUT/DELETE | `/matters/:id/team/:accountId` | `matters.supervise` + supervising partner | Add or remove a fee earner; hand supervision to another partner |
| POST | `/matters/:id/close` | `matters.supervise` + supervising partner | `{reason}` |
| POST | `/matters/:id/access` | `matters.access_with_reason` | `{reason}`; opens the matter read-only for that request |
| GET | `/clients/:id/matters` | `clients.view` + client visibility | The client's matters you can see |

## Audit

`matter.conflict_check_run` (match count), `matter.opened` (type, status),
`matter.conflict_cleared` (clearance id), `matter.updated` (field names),
`matter.party_added`, `matter.party_updated`, `matter.team_member_added`,
`matter.team_member_removed`, `matter.supervisor_changed`, `matter.closed`,
`matter.accessed_with_reason` (access id). Names, titles and reasons stay out
of the audit log, as for clients.

## Not in this module

- **AML:** opening a matter will require the client's identity checks to be
  complete once the Compliance module exists.
- **Documents, tasks, time, bills:** their own modules, attached to matters.
- **Reopening a closed matter:** not planned; a new matter is opened instead.

## Build order

Each step ships with positive and negative tests and is reviewed before the next.

- **8a.** Tables for matters and teams, permissions, opening a matter,
  `GET /matters`, `GET /matters/:id`, `GET /clients/:id/matters`, team-based
  visibility, and client visibility widened. Matters open without a conflict
  check in this step; nothing reaches production before 8b. Done.
- **8b.** Other parties and conflict checks, now required for opening:
  `pg_trgm`, matching, possible matches, `awaiting_clearance`, clearance by the
  supervising partner, email to compliance.
- **8c.** Team changes and handing over supervision.
- **8d.** Editing, closing.
- **8e.** Compliance access with a reason.
- Security review of the module.
