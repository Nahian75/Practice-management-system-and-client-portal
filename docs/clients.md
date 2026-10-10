# Clients

**Current state (2026-10-04):** Built: creating a client, opening and listing
the clients you can see, searching every client by name or reference, editing
details, a partner taking over a client whose responsible person can no longer see it,
and contacts of organisation clients. Security review done: C1–C4, C8 and
C10 fixed; C5 comes with Matters, C6 before production.

## Decisions

| Topic | Decision | Decided by |
|---|---|---|
| Client types | Individuals and organisations from the start | Project owner |
| Who creates clients | Partners and fee earners | Project owner |
| Who sees a client's details | The person who created it, until a matter exists; then that matter's team | Project owner |
| Finding existing clients | Anyone who can create clients can search every client by name, seeing only reference, type and name | Project owner |
| Portal logins | Per person: each contact, or an individual client themself, may get their own login | Project owner |
| Client whose responsible person is disabled or has lost `clients.view` | A partner can take it over, giving a reason ([below](#taking-over-a-client)) | Project owner |
| Deleting clients | Never. Clients are archived; retention is handled with Compliance | Rule: records are kept |

## What a client is

The person or organisation the firm acts for. Other people in a matter (the
other side, witnesses) are not clients; they are recorded with Matters.

- **Individual:** title, given names, family name, date of birth (optional),
  email, phone, correspondence address.
- **Organisation:** legal name, organisation type (`company`, `llp`,
  `partnership`, `charity`, `trust`, `other`), registration number (optional,
  e.g. Companies House), email, phone, registered address.
- **Contacts** (organisations only): the people the firm deals with, such as a
  director or in-house lawyer. Name, job title, email, phone. A contact who
  leaves is marked inactive, not deleted.

Every client gets a firm reference, `C-000001` upwards, which never changes
and is never reused.

## Tables

| Table | Holds | `pms_app` may update |
|---|---|---|
| `clients` | id, reference, kind (`individual` / `organisation`), status (`active` / `archived`), created by, created at, responsible person | Nothing. The responsible person changes only through `client_responsibility_changes` |
| `client_responsibility_changes` | Every takeover: client, from, to, reason, when (`0012_client_takeover.sql`) | Nothing; inserts only, and no role can change or delete a row |
| `client_individuals` | One row per individual client: name, date of birth, email, phone, address | Every detail column; not `client_id` (`0011_client_editing.sql`) |
| `client_organisations` | One row per organisation client: legal name, type, registration number, email, phone, address | Every detail column; not `client_id` (`0011_client_editing.sql`) |
| `client_contacts` | Contacts of organisation clients: names, job title, email, phone, active (`0013_client_contacts.sql`) | Every detail column and `active`; not `client_id`. New contacts are always active. A trigger refuses contacts for individual clients |

None of them can be deleted by the app. `kind` cannot change: an individual
never becomes an organisation. Database checks make sure an individual client
has exactly one `client_individuals` row and no organisation row, and the
other way round.

Addresses are stored as lines, town, postcode and country (ISO 3166 two-letter
code, checked against the list in `country-codes.ts`; `Intl` also accepts
non-country codes such as `UK` and `EU`). Dates of birth are read from the
database as `YYYY-MM-DD` strings, never as JavaScript dates, so a time zone
cannot move them by a day. One address per client for now; more types (billing, previous
addresses for AML) can be added later.

Portal logins are not part of this module. The Client portal module adds an
optional link from a contact, or an individual client, to a `client` account.

## Who can do what

New permissions, added to the table in [authorization.md](authorization.md):

| Permission | Administrator | Partner | Fee earner | Accounts | Compliance |
|---|---|---|---|---|---|
| `clients.create` — create a client | | ✓ | ✓ | | |
| `clients.view` — open a client you can see | | ✓ | ✓ | | |
| `clients.search` — find any client by name (reference, type, name only) | | ✓ | ✓ | | |
| `clients.edit` — change details and contacts of a client you can see | | ✓ | ✓ | | |
| `clients.take_over` — become responsible for a client whose responsible person can no longer see it | | ✓ | | | |

A permission is not enough to see a client's details: layer 3 also applies.
The reverse holds too: someone whose fee earner role is revoked loses access
to the clients they created, because `clients.view` is checked first.

- **Visibility rule:** a client's details are visible to the person
  responsible for it (the creator, unless a partner has [taken it
  over](#taking-over-a-client)), and to every active member of a team on one
  of the client's matters ([matters.md](matters.md)).
- The rule is applied inside every database query through one function, so a
  forgotten check cannot return another person's client.
- A client you cannot see answers **404**, not 403, so its existence is not
  confirmed.
- Search returns at most 20 results, needs at least 2 characters, and never
  returns contact details, addresses or dates of birth. It matches an exact
  reference (listed first) or any part of the name, ignoring case; `%` and `_`
  are matched literally. It reads every row for now; an index comes with
  conflict checks.
- Each person may search 60 times an hour; the 61st search gets 429 with
  `Retry-After`. Every search is recorded as `client.searched` with its number
  of results, never the text, and that record is what the limit counts. A
  per-person lock makes searches sent together queue, so a burst cannot pass
  the count before any is recorded ([review C2](reviews/2026-10-04-clients.md)).
- The list shows 50 clients at a time, newest first. `next` in the answer is
  passed back as `?before=` for the following page.

### Editing

`PATCH /clients/:id` changes only the fields it is given; `null` clears an
optional field, and `address` is replaced as a whole. The body repeats the
client's `kind`, so organisation fields can never be sent for an individual.
`kind`, `reference`, creator and status cannot be changed.

The client's details row is locked for the length of the change. Two edits
arriving together therefore run one after the other, and the second sees the
first's result: the audit log never records a change twice, or a change that
did not happen. A test holds the row from another connection to make that
race happen on every run. Sending the same values again records nothing.

## API

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/clients` | `clients.create` | Body says `kind` and its details. 201 `{id, reference}` |
| GET | `/clients` | `clients.view` | Clients you can see in full |
| GET | `/clients/search?q=` | `clients.search` | Reference, kind and name only |
| GET | `/clients/:id` | `clients.view` + layer 3 | Full details and contacts. 404 if not visible |
| PATCH | `/clients/:id` | `clients.edit` + layer 3 | Change details. `kind` and `reference` cannot be changed |
| POST | `/clients/:id/take-over` | `clients.take_over` | `{"reason"}` → 204. 404 no such client, 409 the responsible person can still see the client |
| POST | `/clients/:id/contacts` | `clients.edit` + layer 3 | `{givenNames, familyName, jobTitle?, email?, phone?}` → 201 `{id}`. 409 for an individual client |
| PATCH | `/clients/:id/contacts/:contactId` | `clients.edit` + layer 3 | Change details, or `{"active": false}` to mark inactive (and `true` to undo). 404 unless the contact belongs to this client |

Contacts appear in `GET /clients/:id` for organisations, active ones first.
A contact is always looked up together with its client, so a contact id from
one client cannot be used through another client's address; a test tries it.

Request bodies are strict: an unknown field is a 400, so `reference`,
`created_by` or `status` cannot be slipped in. Free-text fields refuse control
characters (null bytes, line breaks, tabs) and text-direction overrides, and
must contain a letter or a digit ([review C1](reviews/2026-10-04-clients.md)).

## Audit

| Event | Metadata |
|---|---|
| `client.created` | kind |
| `client.updated` | names of the fields that changed, never their values |
| `client.taken_over` | id of the `client_responsibility_changes` row, previous responsible person. The reason stays in that row |
| `client.take_over_refused` | `responsible_has_access`: a takeover tried while the responsible person could still see the client |
| `client.searched` | number of results; never the text searched for |
| `client.search_limited` | the hourly limit, recorded once an hour while someone is over it |
| `client.contact_added` | contact id |
| `client.contact_updated` | contact id, names of the fields that changed |

Values are left out on purpose: the audit log is kept longer and read more
widely than client records, so copying names and addresses into it would
spread personal data. Each event is written in the same transaction as the
change, with the caller's address and browser.

Views are not audited yet. Views by people outside the matter
team (compliance, with a reason) are audited when Matters is built.

## Not in this module

- **AML and identity checks:** versioned client CDD and protected evidence are
  built in Compliance step 15b. Step 15c made current clearance a work
  gate for matters.
- **Conflict checks:** built with Matters, which searches clients and other
  parties together. Name search may then move to trigram matching (`pg_trgm`)
  to catch spelling variations.
- **Archiving:** needs to know whether a client has open matters, so it is
  built with Matters.

## Taking over a client

Decided by the project owner: if the person responsible for a client can no
longer see it, **a partner can take the client over**, giving a reason. That
is the case when their account is disabled, or when it is still active but no
longer holds a role granting `clients.view`, for example after moving to the
accounts team ([review C3](reviews/2026-10-04-clients.md)).

- `clients` gains `responsible_id`, which starts as the creator. Visibility
  follows the responsible person; `created_by` stays as the historical record.
- `POST /clients/:id/take-over` with `{"reason"}` (10 to 500 characters),
  permission `clients.take_over` (partners only).
- Allowed **only while the responsible person cannot see the client**: 409
  while they can. Without that limit any partner could take any client, which
  would undo the visibility rule. The partner finds the client through search, which
  is why this endpoint answers for clients the caller cannot see.
- Each takeover is kept in `client_responsibility_changes` (client, from, to,
  reason, when). The reason lives there, not in the audit log, because free
  text can hold personal data; the `client.taken_over` audit event points to
  the row.
- Every active compliance holder, except the partner who did it, is emailed
  who took over which client from whom, once the change has committed. The
  client is named by reference only and the reason stays out ([review
  C8](reviews/2026-10-04-clients.md)).

### How the database enforces it

The app has no right to change `responsible_id`. Recording a row in
`client_responsibility_changes` is what changes it: a trigger checks that the
handover comes from the current responsible person, that they can no longer
see the client (disabled, or holding no role that grants `clients.view`), and
that the new person is active staff, then applies it. The trigger runs as the
table owner (`SECURITY DEFINER`, with a fixed `search_path`). So no bug in the
app can move a client without a history row and a reason, or take one from
someone who still has it; a test removes the service's own check and the
database still refuses.

The trigger keeps its own list of roles that see clients (`partner`,
`fee_earner`), because it cannot read `permissions.ts`. A test runs every role
through both and fails if they disagree, so giving another role `clients.view`
without updating the trigger cannot go unnoticed.

Takeovers of one client queue on an advisory lock, so two partners trying at
once get 204 and 409. A test holds the lock from another connection to make
that happen on every run.

## Build order

Each step ships with positive and negative tests and is reviewed before the next.

- **7a.** Migration, permissions, `POST /clients`, `GET /clients/:id` with the visibility rule, audit. Done.
- **7b.** `GET /clients`, search, `PATCH /clients/:id`. Done.
- **7c.** Taking over a client. Done.
- **7d.** Contacts. Done.
- Security review of the module. Done: [reviews/2026-10-04-clients.md](reviews/2026-10-04-clients.md). C1–C4, C8 and C10 fixed; C5 comes with Matters and C6 before production.
