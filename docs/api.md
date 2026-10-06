# API

**Current state (2026-10-06):** Health, authentication, staff management, clients (create, open, list, search, edit, take over, contacts), and matters (conflict checks, opening, viewing, editing, team, closing, compliance access), with the colleagues list for choosing a team, documents (upload, list, download, versions, withdrawal and client sharing), and portal access for clients' people.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | Public | Liveness check for load balancers and monitoring |
| POST | `/auth/sign-in` | Public | Email and password. 200 `{"next":"two_factor"}` with a session cookie waiting for 2FA, 401 `Email or password is incorrect` for every kind of failure, or 429 after too many failures from the caller's network address |
| POST | `/auth/two-factor` | Public, but needs a session waiting for 2FA | `{"code"}`: a 6-digit authenticator code or a backup code. 200 `{"account"}` with a new session cookie. 401 `The code is incorrect` (try again) or `Please sign in again` (no waiting sign-in, 5 wrong codes, or account blocked) |
| POST | `/auth/invitations/inspect` | Public, needs invitation token | `{"token"}` → `{email, displayName, kind}` or 404 |
| POST | `/auth/invitations/password` | Public, needs invitation token | `{"token","password"}` → `{"twoFactor": {secret, uri}}`, or 400 with the reasons the password was refused |
| POST | `/auth/invitations/complete` | Public, needs invitation token | `{"token","code"}` → `{"backupCodes": [10 codes]}`, shown once. Activates the account |
| POST | `/auth/password-reset/request` | Public | `{"email"}` → always 204 |
| POST | `/auth/password-reset/complete` | Public, needs reset token | `{"token","password"}` → 204, 404 (invalid or expired link), or 400 with the reasons the password was refused |
| GET | `/auth/session` | Any signed-in account | The signed-in account: id, kind, display name |
| POST | `/auth/sign-out` | Public | Ends the current session if there is one, clears the cookie. Always 204 |
| GET | `/staff` | `staff.view` | `{"staff": [{id, email, displayName, status, roles}]}`: every staff account, including invited and disabled |
| POST | `/staff/invitations` | `staff.invite` | `{"email","displayName"}` → 201 `{accountId, expiresAt}`. Inviting someone already invited sends a fresh link. 409 if the address already has an active, disabled or client account |
| PUT | `/staff/:accountId/roles/:role` | `staff.roles.manage` | Grants a role. 204, also when already held. 403 on your own account, 404 not a staff account, 409 account disabled |
| DELETE | `/staff/:accountId/roles/:role` | `staff.roles.manage` | Revokes a role. 204, also when not held. 403 on your own account, 404 not a staff account, 409 last active administrator or compliance holder |
| POST | `/staff/:accountId/disable` | `staff.disable` | Disables the account and ends its sessions. 204, also when already disabled. 403 on your own account, 404 not a staff account, 409 last active administrator or compliance holder |
| POST | `/staff/:accountId/enable` | `staff.disable` | Re-enables a disabled account: it becomes invited, its password is removed and a new invitation is emailed. 200 `{expiresAt}`. 403 on your own account, 404 not a staff account, 409 not disabled |
| POST | `/clients` | `clients.create` | Creates an individual or organisation client ([clients.md](clients.md#api)). 201 `{id, reference}`. 400 for any unknown field |
| GET | `/clients` | `clients.view` | `{"clients": [{id, reference, kind, name}], "next"}`: the clients you can see, 50 at a time, newest first. `?before=<next>` for the following page |
| GET | `/clients/search?q=` | `clients.search` | `{"clients": [{id, reference, kind, name}]}`: up to 20 clients of the whole firm by reference or part of the name. `q` 2 to 100 characters. 60 searches per person per hour, then 429 with `Retry-After` |
| GET | `/clients/:clientId` | `clients.view` + visibility | The client's details. 404 if it does not exist or the caller may not see it |
| PATCH | `/clients/:clientId` | `clients.edit` + visibility | `{"kind", ...fields to change}` → 200 with the client. 400 for unknown fields, nothing to change, or the wrong `kind`; 404 as for GET |
| POST | `/clients/:clientId/contacts` | `clients.edit` + visibility | `{givenNames, familyName, jobTitle?, email?, phone?}` → 201 `{id}`. 404 as for GET, 409 for an individual client |
| PATCH | `/clients/:clientId/contacts/:contactId` | `clients.edit` + visibility | Fields to change, or `active` → 200 with the contact. 404 unless the contact belongs to this client and the caller may see it |
| POST | `/matters` | `matters.open` | `{clientId, title, matterType, supervisingPartnerId, feeEarnerIds?, conflictCheckId, parties?}` → 201 `{id, reference, status}`; status is `awaiting_clearance` if the check found any possible match. The opener joins the team. 404 client not visible; 400 supervising partner or team member not allowed, check not usable (not yours, other client, over 24 hours old, already used), or a party not in the check |
| POST | `/conflict-checks` | `matters.open` | `{clientId, names[1..20]}` → 201 `{id, names, matches, matchCount, createdAt}`. The client's own name is added; up to 50 strongest matches, each with name, relation and references only. 404 client not visible, 429 over the hourly allowance shared with client search (one unit per name) |
| GET | `/matters/:matterId/conflict-check` | `matters.view` + team | The check the matter was opened on, and its clearance if any |
| POST | `/matters/:matterId/conflict-clearance` | `matters.supervise` + supervising partner | `{"reason"}` (10 to 500 characters) → 204: the matter opens. 403 not the supervising partner, 404 not on the team, 409 not awaiting clearance |
| GET | `/matters` | `matters.view` | `{"matters": [...], "next"}`: matters you are on the team of, 50 at a time, newest first. `?before=<next>` |
| GET | `/matters/:matterId` | `matters.view` + team | Details, client summary and team. 404 if not on the team |
| PATCH | `/matters/:matterId` | `matters.edit` + team | `{title?, matterType?}` → 200 with the matter. 409 closed |
| POST | `/matters/:matterId/close` | `matters.supervise` + supervising partner | `{"reason"}` → 204. Final. 403 not the supervising partner, 409 already closed |
| PUT | `/matters/:matterId/team/:accountId` | `matters.supervise` + supervising partner | Adds a fee earner. 204, also when already on the team. 400 not active staff who can work on matters |
| DELETE | `/matters/:matterId/team/:accountId` | `matters.supervise` + supervising partner | Removes a fee earner, who loses access at once. 204, also when not on the team. 409 for the supervising partner |
| POST | `/matters/:matterId/supervisor` | `matters.supervise` + supervising partner | `{accountId}` → 204: hands supervision to that partner; the previous one stays as a fee earner. 400 not an active partner |
| POST | `/matter-supervision-takeovers` | `matters.supervise` | `{matterReference, reason}` → 204: the caller becomes supervising partner. Works for matters the caller cannot see yet. 404 no such reference, 409 the supervising partner can still act |
| POST | `/matter-compliance-accesses` | `matters.access_with_reason` | `{matterReference, reason}` → 200 with the matter, read-only, for this request only; recorded, and the supervising partner is emailed. 404 no such reference, 429 after 30 in an hour |
| GET | `/matters/:matterId/compliance-accesses` | `matters.supervise` + supervising partner | `{"accesses": [{id, accessedBy, reason, accessedAt}]}`. 403 not the supervising partner |
| GET | `/clients/:clientId/matters` | `matters.view` + client visibility | The client's matters you are on the team of |
| GET | `/matters/:matterId/documents` | `documents.view` + team | `{documents, next}`: 100 at a time, newest first, with each one's latest version. `?before=<next>` |
| GET | `/documents/:documentId` | `documents.view` + team | The document, its client-sharing setting and every version |
| GET | `/documents/:documentId/versions/:number/content` | `documents.view` + team | The file, as a download; recorded. See [documents.md](documents.md#api) |
| POST | `/documents/:documentId/versions` | `documents.add` + team, open matter | Multipart `file` → 201 with the new version, checked as a first upload |
| POST | `/documents/:documentId/withdrawal` | `documents.withdraw` + uploader or supervising partner | `{reason}` → 204. Final; the document is no longer listed or downloaded |
| PUT | `/documents/:documentId/client-sharing` | `documents.share` + team | Shares the document with the client → 204 |
| DELETE | `/documents/:documentId/client-sharing` | `documents.share` + team | Stops sharing the document → 204 |
| POST | `/matters/:matterId/documents` | `documents.add` + team, open matter | Multipart `title`, `category`, then `file` (PDF, Word, Excel, PowerPoint, text, email, JPEG, PNG; up to 50 MB) → 201. Scanned for malware and stored encrypted; see [documents.md](documents.md#api) for every refusal |
| POST | `/clients/:clientId/portal-access` | `portal.invite` + client visible | `{contactId?}` → 201: invites the client's person to the portal at the address on record. See [portal.md](portal.md#api) |
| GET | `/clients/:clientId/portal-access` | `portal.invite` + client visible | Who can see the client in the portal now |
| DELETE | `/clients/:clientId/portal-access/:linkId` | `portal.invite` + client visible | Ends that person's access → 204 |
| GET | `/colleagues` | `matters.open` | `{"colleagues": [{id, displayName, isPartner}]}`: active staff who can be put on a matter's team (partner or fee earner), by name. No email addresses or other roles |
| POST | `/clients/:clientId/take-over` | `clients.take_over` | `{"reason"}` (10 to 500 characters) → 204: the caller becomes responsible for the client. Works for clients the caller cannot see yet. 404 no such client, 409 the responsible person can still see the client (active and holding `clients.view`) |

`/health` returns exactly `{"status":"ok"}`. It must never return version
numbers, environment names, dependency status or anything else an attacker
could use to fingerprint the system.

## Cross-cutting behaviour

See [security.md](security.md#request-pipeline) for the full request pipeline.

## Writing a route

Every route declares who may call it, its input and its output. Without all three, it returns 500 and the handler never runs.

| Decorator | Who may call |
|---|---|
| `@Public()` | Anyone. Only for sign-in, sign-out and health |
| `@StaffOnly()` | Signed-in staff |
| `@ClientOnly()` | Signed-in clients |
| `@AnyAccount()` | Any signed-in account |
| `@RequirePermission('staff.invite')` | Signed-in staff holding a role with that permission (see [authorization.md](authorization.md)) |

A session waiting for its 2FA code counts as not signed in.

```ts
const createClientSchema = z.strictObject({ name: z.string().min(1).max(200) });
const clientSchema = z.object({ id: z.uuid(), name: z.string() });

@Post()
@StaffOnly()
@ResponseSchema(clientSchema)
create(@Body({ schema: createClientSchema }) body: z.infer<typeof createClientSchema>) {
  return this.clients.create(body);
}
```

- Request schemas: `z.strictObject` (unknown fields rejected).
- Response schemas: `z.object` (undeclared fields removed).
- Route IDs: `@Param('id', { schema: z.uuid() })`.

## Error format

```json
{ "statusCode": 403, "message": "You do not have access to this matter" }
{ "statusCode": 500, "message": "Internal Server Error", "reference": "<uuid>" }
```

## Running locally

```sh
cp apps/api/.env.example apps/api/.env
npm run build -w @practice/api
npm run start:local -w @practice/api
```
