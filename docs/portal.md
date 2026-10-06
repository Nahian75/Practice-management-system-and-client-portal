# Client portal

**Current state (2026-10-06):** Step 11a-1 built: portal links in the API
(`apps/api/src/portal/`, migration `0026`). The staff screens for it (11a-2) next.

Where the firm's clients sign in to follow their matters and receive the
documents the firm shares with them.

## Already decided

| Topic | Decision | Decided by |
|---|---|---|
| Client accounts | Invitation only, no public sign-up | Project owner (authentication.md) |
| Two-factor | Required for clients as for staff | Project owner (authentication.md) |
| Sessions | 15 minutes idle, 2 hours at most | Project owner (authentication.md) |
| Who gets a login | Per person: an individual client themself, or a contact of an organisation client | Project owner (clients.md) |
| Separation | A client session cannot call staff routes, nor a staff session client routes (`@ClientOnly()`) | Project owner (authorization.md) |

## Decisions

| Topic | Decision | Decided by |
|---|---|---|
| Who invites | Anyone on the team of one of the client's matters, or the client's responsible person: those who can already see the client | Project owner |
| Where the invitation goes | Only to the email address already on the record, of the individual client or of the contact: never one typed at the time of inviting. A wrong address is corrected on the record first, which is audited | Project owner |
| One person, several clients | One login per person (per email address), which can be linked to several clients, such as a director who is the contact for two companies | Project owner |
| What a client sees of a matter | Its reference, title, type of work, status, the date it opened, and the names of its supervising partner and fee earners. Not the conflict check, not the other parties, not anything internal | Project owner |
| Which matters | Every matter of the clients the login is linked to, open or closed; not those awaiting conflict clearance (no work has started) | Project owner |
| Which documents | Only those a team member has marked "shared with the client", latest version only; never withdrawn ones. Sharing and unsharing are audited | Project owner |
| Clients sending documents | Not in the first version: the portal is read-only for clients. Uploads by clients come later, with the same checks as staff uploads, into a "from the client" area the team reviews | Project owner |
| When access ends | At once, without anyone having to remember: when the contact is marked as no longer a contact, when the link is removed by staff, or when the account is disabled. Checked on every request, not only at sign-in | Project owner |
| What is recorded | Invitations, links and their removal, sign-ins, every document a client downloads (actor: the client), every share and unshare | Project owner |
| Where it lives | The same web app, under `/portal`, with its own layout; the sign-in page sends each person to their side by the kind of account. Staff pages refuse client sessions, and portal pages staff sessions | Project owner |

## What it holds

- `portal_links`: a client account, the client it may see, and for an
  organisation the contact it is for; who linked it, when; when it ended, by
  whom. Insert, and end once; never deleted.
- `documents.shared_with_client`, set and cleared by the matter's team, with
  each change kept in an insert-only `document_sharing_changes` table.

## The database's own checks (migration 0026)

- A link joins a **client** account that is not disabled to the individual
  client themself, or to one **active** contact of an organisation client.
- **The account's email address must be the one on that record**, so access
  can only go to the address the firm holds, whatever the app sends.
- Links are made and ended by staff; one active link per person and client;
  ended once, never changed back or deleted.

## Who can do what

| Permission | Administrator | Partner | Fee earner | Accounts | Compliance |
|---|---|---|---|---|---|
| `portal.invite` — invite a client's person to the portal, and end their access | | ✓ | ✓ | | |
| `documents.share` — share a document with the client, or stop sharing it | | ✓ | ✓ | | |

Both still need the client, or the matter, to be visible to the person, as
everywhere else. Client accounts have no roles: what a client sees follows
from their links alone, in every query.

## API

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/clients/:id/portal-access` | `portal.invite` + client visible | `{contactId?}` (an organisation's contact; none for an individual) → 201 `{id, accountId, invited}`. A new login is invited at the address on record; someone already using the portal is linked and emailed, without naming the client. 400 not a current contact of this client; 404 client not visible; 409 no email on record, already has access, address used by a staff account, or portal account disabled |
| GET | `/clients/:id/portal-access` | `portal.invite` + client visible | `{"people": [{id, accountId, contactId, name, email, accountStatus, linkedAt}]}`: who can see the client in the portal now |
| DELETE | `/clients/:id/portal-access/:linkId` | `portal.invite` + client visible | Ends that person's access at once → 204. 404 not a current link of this client |

Recorded as `portal.access_granted` and `portal.access_ended`, by ids only.

## Build order

Each step ships with positive and negative tests and is reviewed before the next.

- **11a-1.** Portal links in the API: inviting an individual client or a
  contact (to the address on record), listing and ending access. Done.
- **11a-2.** The staff screens for it, on the client page.
- **11b.** Sharing documents with the client, in the API and on the document
  page.
- **11c.** The portal API for clients: their matters, the documents shared on
  each, downloads; access re-checked on every request.
- **11d.** The portal screens; the sign-in page sends clients to them.
- Security review of the portal.
