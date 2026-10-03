# Security review: authentication module

**Date:** 2026-10-04
**Scope:** `apps/api/src/auth/`, `apps/api/src/mail/`, the request pipeline in
`apps/api/src/app.setup.ts`, migrations `0002`–`0008`. Commits `a938137`…`3e9e8b1`.
**Method:** code read against the review checklist in the engineering rules;
uncertain points settled by running probes against the real app, PostgreSQL
and Mailpit rather than by reasoning.

## Findings

### F1 — IPv6 address rotation bypassed the per-address limit

| | |
|---|---|
| Severity | **Medium** |
| Location | `SignInFailuresRepository.countForAddressSince` |
| Problem | Failures were counted per exact address. An IPv6 client normally controls a whole /64 (2⁶⁴ addresses), so it could use a new address for every guess. |
| Impact | Password spraying from a single IPv6 connection was not limited at all. Confirmed by probe: 35 failures from one /64, then still `401`, not `429`. |
| Fix | **Fixed in this review.** IPv6 addresses are counted by their /64. IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is normalised to plain IPv4 so one client cannot fall into two buckets. |
| Test | `address-limit.spec.ts`: rotation within a /64 is limited; a neighbouring /64 is not; IPv4 and IPv4-mapped share a count. `request-context.spec.ts` for normalisation. Reverting either part of the fix fails a test. |

### F2 — Unauthenticated password hashing limits sign-in throughput

| | |
|---|---|
| Severity | **Medium** (availability) |
| Location | `SignInService.signIn` (unknown-email path hashes on purpose) |
| Problem | Every sign-in attempt costs one Argon2id hash so timing does not reveal which emails exist. Measured: 45 ms alone; 50 concurrent requests all complete within 716 ms using +12 MB, because Node runs at most 4 hashes at once. Roughly 70 attempts per second saturate one server. |
| Impact | An attacker spread across many addresses can make sign-in slow for everyone. Memory stays bounded, so the server does not crash. |
| Fix | **Before production:** request rate limiting at the load balancer or web application firewall, and an alert on sign-in latency. Not fixable inside the app without weakening the timing protection. |
| Test | Load probe recorded above; repeat against staging once the load balancer exists. |

### F3 — No retention for security tables

| | |
|---|---|
| Severity | **Low** (now), **Medium** before production |
| Location | `sessions`, `sign_in_failures`, `password_resets`, `invitations`, `audit_events` |
| Problem | Rows are never removed. Sessions waiting for 2FA can be created without limit by someone who knows a password. IP addresses and user agents are personal data under UK GDPR. |
| Impact | Unbounded table growth; personal data kept longer than needed. |
| Fix | **Before production:** a retention policy agreed with the firm (audit records have legal retention requirements; failures and ended sessions do not), and a scheduled job run by a role that may delete only expired rows. |
| Test | Retention job tests once built. |

### F4 — Database error messages can reach the logs

| | |
|---|---|
| Severity | **Low** |
| Location | `AllExceptionsFilter` logs the stack of unexpected errors |
| Problem | PostgreSQL constraint errors quote values, e.g. `Key (email)=(jane@…) already exists`. Two concurrent invitations to the same new email would log the address. |
| Impact | Personal data in application logs. Already listed as a known gap in `security.md`. |
| Fix | Translate database errors at the repository boundary into errors without values, as part of the next module's data layer. |
| Test | A test that forces a unique violation and asserts the log line contains no value. |

### F5 — Background email is in memory

| | |
|---|---|
| Severity | **Low** |
| Location | `MailOutbox` |
| Problem | A crash between queueing and sending loses the email (reset link, security notice). Shutdown waits for in-flight sends; a crash does not. |
| Impact | A user may need to request a reset again; a security notice may be missed. |
| Fix | **Before production:** persistent outbox table processed by a worker. Already documented. |
| Test | Outbox tests once built. |

### F6 — Missing self-service security functions

| | |
|---|---|
| Severity | **Low** (gap, not a flaw) |
| Location | Auth module |
| Problem | Not built yet: change password while signed in, regenerate backup codes, view and end other sessions, staff-assisted 2FA reset. |
| Impact | Users cannot react themselves to a suspected compromise except by password reset. |
| Fix | Build with the Users/Roles module, where staff permissions for the assisted reset exist. |
| Test | Positive and negative tests per function. |

### F7 — A password reset does not lift an active block

| | |
|---|---|
| Severity | **Informational** |
| Location | `PasswordResetService.complete` |
| Problem | Someone who triggers a block on a victim's account keeps the victim out for up to 15 minutes, even after the victim resets their password. |
| Impact | Short denial of service against one account. Lifting the block on reset would let a reset be used to reset the guess counter, so the current behaviour is kept deliberately. |
| Fix | None. Documented. |

### F8 — Dependency exception expires

| | |
|---|---|
| Severity | **Informational** |
| Location | `dependency-age-exceptions.json` |
| Problem | The nodemailer exception expires on 2026-10-07; `npm run check:dependency-age` will fail from then until it is removed. |
| Fix | On or after 2026-10-07, remove the exception and the `.npmrc` exclusion. |

## Checked and found sound

Each was checked by reading the code and, where noted, by a probe or an existing test.

| Area | Result |
|---|---|
| CSRF | `Sec-Fetch-Site: same-site` (another subdomain) and `cross-site` both rejected with 403. **Probe** |
| Session cookie | `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, no lifetime; duplicate or malformed cookies rejected |
| Session lifetime | Idle and absolute limits enforced server-side on every request; new token after 2FA; all sessions ended on reset; disabled accounts lose sessions |
| Account enumeration | Same answer and equivalent hashing work for unknown, invited, disabled, wrong-password and not-enrolled accounts at sign-in; reset request always 204 with background email. Measured timings in `authentication.md` |
| Brute force | 10 combined wrong passwords and codes per account; 5 codes per sign-in; 30 failures per address (now per /64 for IPv6) |
| Replay | TOTP steps and backup codes single-use with atomic updates and triggers; tokens for invitations and resets single-use and closed before use |
| Secrets at rest | Passwords Argon2id; tokens and backup codes SHA-256; TOTP secrets AES-256-GCM bound to the account |
| Input validation | Every route has request and response schemas; unknown fields rejected; sizes bounded |
| Authorization | Every route declares its audience; undeclared routes refuse to run; staff and client areas separated and denials audited |
| Database privileges | App role cannot delete accounts, sessions, failures, codes, invitations or resets, cannot change account kind or email, cannot backdate audit entries |
| Email | Recipient and subject validated (header injection shown to be real without it); plain text only; bodies never logged; TLS required in production |
| Client address | `X-Forwarded-For` ignored unless from a listed proxy |
| Dependencies | `npm audit` clean; signatures verified; 7-day rule with one approved, expiring exception |
| Secrets in the repository | gitleaks on every commit; one reviewed false positive |

## Summary

One medium-severity flaw found and fixed (F1). One medium availability limit
that needs infrastructure in front of the app (F2). The remaining items are
known gaps scheduled before production. No finding allows signing in without
both factors, reading another account's data, or bypassing the audit trail.
