# Clients

**Current state (2026-10-04):** Steps 7a and 7b built: creating a client,
opening and listing the clients you can see, searching every client by name or
reference, and editing details. Takeover and contacts are designed below and
not built yet.

## Decisions

| Topic | Decision | Decided by |
|---|---|---|
| Client types | Individuals and organisations from the start | Project owner |
| Who creates clients | Partners and fee earners | Project owner |
| Who sees a client's details | The person who created it, until a matter exists; then that matter's team | Project owner |
| Finding existing clients | Anyone who can create clients can search every client by name, seeing only reference, type and name | Project owner |
| Portal logins | Per person: each contact, or an individual client themself, may get their own login | Project owner |
| Client whose responsible person is disabled | A partner can take it over, giving a reason ([below](#taking-over-a-client)) | Project owner |
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
| `clients` | id, reference, kind (`individual` / `organisation`), status (`active` / `archived`), created by, created at | `status` only |
| `client_individuals` | One row per individual client: name, date of birth, email, phone, address | Every detail column; not `client_id` (`0011_client_editing.sql`) |
| `client_organisations` | One row per organisation client: legal name, type, registration number, email, phone, address | Every detail column; not `client_id` (`0011_client_editing.sql`) |
| `client_contacts` | Contacts of organisation clients | Every detail column and `active`; not `client_id` |

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
| `clients.take_over` — become responsible for a client whose responsible person is disabled | | ✓ | | | |

A permission is not enough to see a client's details: layer 3 also applies.
The reverse holds too: someone whose fee earner role is revoked loses access
to the clients they created, because `clients.view` is checked first.

- **Visibility rule:** a client's details are visible to the person who
  created it. When Matters is built, this becomes "the creator until a matter
  exists, then the matter's team".
- The rule is applied inside every database query through one function, so a
  forgotten check cannot return another person's client.
- A client you cannot see answers **404**, not 403, so its existence is not
  confirmed.
- Search returns at most 20 results, needs at least 2 characters, and never
  returns contact details, addresses or dates of birth. It matches an exact
  reference (listed first) or any part of the name, ignoring case; `%` and `_`
  are matched literally. It reads every row for now; an index comes with
  conflict checks.
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
| POST | `/clients/:id/contacts` | `clients.edit` + layer 3 | Organisations only |
| PATCH | `/clients/:id/contacts/:contactId` | `clients.edit` + layer 3 | Change details, or mark inactive |

Request bodies are strict: an unknown field is a 400, so `reference`,
`created_by` or `status` cannot be slipped in.

## Audit

| Event | Metadata |
|---|---|
| `client.created` | kind |
| `client.updated` | names of the fields that changed, never their values |
| `client.contact_added`, `client.contact_updated` | contact id, names of changed fields |

Values are left out on purpose: the audit log is kept longer and read more
widely than client records, so copying names and addresses into it would
spread personal data. Each event is written in the same transaction as the
change, with the caller's address and browser.

Searches and views are not audited yet. Views by people outside the matter
team (compliance, with a reason) are audited when Matters is built.

## Not in this module

- **AML and identity checks:** Compliance module. Opening a matter will later
  require the client's checks to be complete.
- **Conflict checks:** built with Matters, which searches clients and other
  parties together. Name search may then move to trigram matching (`pg_trgm`)
  to catch spelling variations.
- **Archiving:** needs to know whether a client has open matters, so it is
  built with Matters.

## Taking over a client

Decided by the project owner: if the person responsible for a client is
disabled before a matter is opened, **a partner can take the client over**,
giving a reason.

- `clients` gains `responsible_id`, which starts as the creator. Visibility
  follows the responsible person; `created_by` stays as the historical record.
- `POST /clients/:id/take-over` with `{"reason"}` (10 to 500 characters),
  permission `clients.take_over` (partners only).
- Allowed **only while the responsible person's account is disabled**: 409
  otherwise. Without that limit any partner could take any client, which would
  undo the visibility rule. The partner finds the client through search, which
  is why this endpoint answers for clients the caller cannot see.
- Each takeover is kept in `client_responsibility_changes` (client, from, to,
  reason, when). The reason lives there, not in the audit log, because free
  text can hold personal data; the `client.taken_over` audit event points to
  the row.

## Build order

Each step ships with positive and negative tests and is reviewed before the next.

- **7a.** Migration, permissions, `POST /clients`, `GET /clients/:id` with the visibility rule, audit. Done.
- **7b.** `GET /clients`, search, `PATCH /clients/:id`. Done.
- **7c.** Taking over a client.
- **7d.** Contacts.
- Security review of the module.
