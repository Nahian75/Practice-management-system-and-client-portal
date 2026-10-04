# Security review: users and roles module

**Date:** 2026-10-04
**Scope:** `apps/api/src/auth/permissions/`, `apps/api/src/staff/`, migration
`0009_account_roles`, the `--role` option of `apps/api/src/cli/invite.ts`, and
the guard order in `apps/api/src/app.setup.ts`.
**Method:** code read against the review checklist in the engineering rules;
each safeguard confirmed by breaking it on purpose and checking a test fails
(26 deliberate breaks, all caught); end-to-end run against the real server,
PostgreSQL and Mailpit with synthetic accounts.

## Checked and sound

| Area | Result |
|---|---|
| Every route declares its permission | All five staff routes use `@RequirePermission`. Replacing any with a weaker permission fails a test |
| Guard order | Session guard before permission guard; swapping them fails 12 tests |
| Revocation takes effect | Permissions are read from the database on every request; tested over HTTP and live |
| Changing your own account | Refused in the service and, for roles, by database checks (`account_roles_not_self_granted`, `account_roles_not_self_revoked`) |
| Last administrator | Advisory lock plus count inside one transaction; the race is reproduced on every test run |
| Mass assignment | Invitation bodies are strict: `roles` or any other extra field gives 400 |
| Client accounts | Not found by staff endpoints (404); the database refuses roles for them |
| Input | Ids must be UUIDs, roles must be in the fixed list (400 otherwise); queries are parameterised by Kysely |
| Output | Response schemas allow only id, email, name, status and roles; no hashes or secrets |
| Audit | Every change and every refusal recorded, in the same transaction as the change |
| Role history | Revoked roles cannot be reopened, deleted or moved to another account, even by the table owner |

## Found and fixed while building

- Role and account changes first wrote their audit record after the change had
  committed, so a failure in between could leave a change with no record. Now
  inside the same transaction; tests check both the transaction and the rollback.
- Refusals (trying to change your own roles) were not recorded. Now `staff.change_refused`.

## Findings

### U1 — Staff changes recorded without the caller's address

| | |
|---|---|
| Severity | **Low** |
| Location | `RolesService`, `StaffService`, `InvitationsService.invite` |
| Problem | Audit records of invitations, role changes and disabling had no IP address or user agent, unlike sign-in records. |
| Impact | After a misuse of an administrator account, the record could not show where the changes came from. |
| Fix | **Fixed in this review.** The controller passes the request's address and user agent; every staff audit record carries them. |
| Test | `staff.controller.spec.ts`: "records the network address and browser of every change". |

### U2 — One administrator can grant any role, unnoticed

| | |
|---|---|
| Severity | **Medium** |
| Location | `PUT /staff/:accountId/roles/:role` |
| Problem | By decision of the project owner there is no second approval for role grants. An administrator can give anyone `accounts` (client money) or `compliance` (the audit log), and two people acting together can get around the separation between administrators and the audit log. |
| Impact | A compromised or dishonest administrator account can hand out access quietly. The change is in the audit log, but nobody is told. |
| Fix | **Recommended before production:** email the person whose roles changed, and email every compliance holder when `administrator`, `compliance` or `accounts` is granted. The existing security-notice emails can carry it. Needs the project owner's approval. |
| Test | When built: notice sent to the right people; no notice for other roles. |

### U3 — No safeguard for the last compliance holder

| | |
|---|---|
| Severity | **Low** |
| Location | `RolesService.revoke`, `StaffService.disable` |
| Problem | Only administrators are protected from removal of the last one. Revoking or disabling the last person with `compliance` leaves nobody able to read the audit log in the app. |
| Impact | Oversight stops until an administrator grants the role again, and that grant is the only thing the audit log would then show. |
| Fix | **Fixed after the review**, by decision of the project owner: `compliance` joins `administrator` in `PROTECTED_ROLES`, under the same lock and count. |
| Test | `last-holder.exclusive.spec.ts`: "with one compliance holder left". Removing `compliance` from the list fails four tests. |

### U4 — A disabled account cannot be restored

| | |
|---|---|
| Severity | **Low** (operational) |
| Location | `StaffService.disable`; `InvitationsService.invite` refuses disabled accounts |
| Problem | There is no re-enable action, and a disabled address cannot be invited again. |
| Impact | Disabling someone by mistake can only be undone directly in the database, which is the kind of manual change the rules discourage. |
| Fix | **Fixed after the review:** `POST /staff/:accountId/enable` (`staff.disable`). The account returns to `invited` with its password removed, and a new invitation is emailed, so the old password never works again. Any invitation left open from before the account was disabled is closed in the same transaction. |
| Test | `staff.controller.spec.ts`: "POST /staff/:accountId/enable" (only staff, not your own account, audited, old sessions stay ended, old invitation closed even when the new email fails). |

### U5 — A request already authorised can finish after its sender loses the role

| | |
|---|---|
| Severity | **Informational** |
| Location | `PermissionGuard` (checks before the handler runs) |
| Problem | If an administrator's role is revoked while one of their requests is between the permission check and its change, that change still completes. |
| Impact | One request, milliseconds wide. It cannot remove the last administrator: that check runs inside the lock. |
| Fix | None now. Re-checking permissions inside each transaction would close it, at the cost of every change carrying its own check. |
| Test | Last-administrator race test covers the case that matters. |

### U6 — Invitations reveal whether an address already has an account

| | |
|---|---|
| Severity | **Informational** |
| Location | `POST /staff/invitations` (409) |
| Problem | An administrator can learn that a client account exists for an address. |
| Impact | Administrators are trusted and every invitation is audited. |
| Fix | Accepted. |
| Test | `staff.controller.spec.ts` pins the 409. |

## Not in scope

Rate limiting of staff endpoints (behind sign-in and administrator-only; see
F2 for the load balancer), pagination of `GET /staff` (staff numbers are small).
