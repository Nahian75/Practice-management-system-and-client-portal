# Authentication

**Current state (2026-10-07):** All five authentication steps are built.
Invitations, password resets and security notices now use the persistent
encrypted email outbox from Notifications step 13a.

## Decisions

| Topic | Decision | Decided by |
|---|---|---|
| Two-factor authentication | Required for every account, staff and client | Project owner |
| Client accounts | Invitation only. No public sign-up | Project owner |
| Leaked-password check | Yes, Have I Been Pwned range API | Project owner |
| Session length | Staff 30 min idle / 10 h max. Clients 15 min idle / 2 h max | Project owner |
| Session mechanism | Server-side sessions, opaque token in a cookie. No JWT | ADR-007 |
| Password hashing | Argon2id, built into Node.js 24. No dependency | ADR-007 |
| 2FA method | TOTP authenticator app + single-use backup codes. Passkeys later | ADR-007 |

## Accounts

- One `accounts` table. `kind` is `staff` or `client`, set at creation and never changed.
- Staff accounts are created by an administrator. Client accounts are created
  by staff and activated through an emailed invitation.
- Status: `invited` → `active` → `disabled`. Only `active` accounts can sign in.
- Email is unique, compared case-insensitively.

## Passwords

Follows NCSC and NIST SP 800-63B guidance.

- Minimum 12 characters, maximum 128 (stops very long inputs being used to
  slow the server). No forced mix of symbols or digits, no forced expiry.
- Rejected if it appears in Have I Been Pwned. Only the first 5 characters of
  the password's SHA-1 hash leave the server (k-anonymity), never the password.
  If the service is unreachable, the password is accepted and the check is
  logged as skipped, so an outage cannot block sign-up.
- Normalised (Unicode NFKC) before hashing, so the same password typed on
  different devices matches.
- Hashed with Argon2id: 19 MiB memory, 2 passes, 1 lane, 16-byte random salt
  (OWASP minimum). Parameters are stored with each hash, so they can be raised
  later and old hashes upgraded on next sign-in.

## Sign-in

```
1. email + password  ──►  checked  ──►  2FA challenge (valid 5 min, nothing else allowed)
2. 6-digit code      ──►  checked  ──►  session created, cookie set
```

- **Same answer for every failure** in step 1 ("Email or password is
  incorrect"), and the same work is done when the email does not exist, so
  the response cannot be used to discover which emails have accounts.
- A 2FA challenge allows 5 code attempts, then it is cancelled.
- When the code is accepted, the waiting session is ended and a new session
  with a new token is issued. A token seen during sign-in never becomes usable.
- Wrong codes count towards the same account block as wrong passwords, so
  starting new sign-ins does not give unlimited code guesses.
- An active account without confirmed 2FA cannot sign in.
- A TOTP code can be used only once, even within its 30-second window. Enforced
  twice: the code check refuses steps at or before the last used one, and the
  database update only succeeds if the step is newer (atomic, so two
  simultaneous requests with the same code cannot both succeed). A trigger also
  stops the stored step moving backwards, for every role.
- Codes from one step either side of the current one are accepted, for phone
  clocks that are slightly off.

### Enrolment

- 2FA is set up only while accepting an invitation (step 4) or from a fully
  signed-in session. Never straight after the password step: otherwise anyone
  holding a stolen password could attach their own authenticator app.
- A new secret is unconfirmed until the account enters a code from the app. An
  unconfirmed secret can be replaced; a confirmed one cannot be replaced by enrolment.
- An active account without confirmed 2FA cannot sign in.

### Secret storage

- 20 random bytes per account, sealed with AES-256-GCM under
  `TOTP_ENCRYPTION_KEY`. The account ID is bound into the authentication tag,
  so a secret copied onto another account fails to open.
- Each row records the key version, so the key can be rotated later.
- TOTP itself is implemented with `node:crypto` and tested against the
  RFC 4226, RFC 6238 and RFC 4648 test vectors.
- A backup code can replace the TOTP code. Each works once.
  - 10 per account, 16 base32 characters (80 random bits), shown as
    `XXXX-XXXX-XXXX-XXXX`; any case, dashes and spaces accepted.
  - Stored as SHA-256 hashes only. 80 bits is too much to brute-force from a
    leaked hash, so a slow hash is not needed.
  - Issuing a new set retires every unused code. A spent code can never be
    made usable again: a trigger enforces this for every role.

## Lockout and rate limits

| Limit | Rule |
|---|---|
| Per account | After 10 wrong passwords or 2FA codes (combined) in 15 minutes, sign-in is blocked for 15 minutes. The account holder is emailed (step 4) |
| Per network address | 30 **failed** sign-in attempts (wrong password, unknown email, wrong 2FA code) per 15 minutes, across all accounts. Then 429 with `Retry-After: 900`, at both sign-in steps |
| Per 2FA challenge | 5 codes, then the challenge is cancelled |

The per-address limit counts failures only. A firm's staff usually share one
office internet address; counting successful sign-ins would block the office
at 9 am. Failures from one address across many accounts are what password
spraying looks like, which the per-account limit cannot see.

An IPv6 address counts as its whole /64, since one connection is normally given
a /64 and could otherwise use a new address for every guess. IPv4 addresses that
arrive in IPv6 form (`::ffff:1.2.3.4`) are recorded as plain IPv4.

The address is the TCP connection's, unless `TRUSTED_PROXIES` lists the proxy
it came through: then the proxy's `X-Forwarded-For` is believed. Empty by
default, so a client cannot pick the address it is limited and audited under.
In production, set it to the load balancer's address range only.

Flooding with large volumes of requests is stopped in front of the app (load
balancer or web application firewall), not by these limits.

Temporary blocks, not permanent lockout: a permanent lock would let anyone
lock a partner out by typing their email ten times.

Counters are kept in PostgreSQL (`sign_in_failures`). No extra service (such
as Redis) is needed at this scale.

- Only wrong passwords count towards the account block. Attempts made while
  blocked are not recorded, so an attacker cannot keep extending the block.
- A completed sign-in (password and 2FA) clears the count.
- Failure times come from the same app clock that checks the limit. Mixing the
  database clock and the app clock would make the 15-minute boundary unreliable.
- Two requests arriving at the same moment can both be checked before either
  is recorded, so the limit can be exceeded by one or two attempts. Acceptable:
  the limit slows guessing, it is not the only defence.

## Sessions

- The session token is 32 random bytes. The cookie holds the token; the
  database holds only its SHA-256 hash, so a database leak does not give
  anyone a working session.
- Cookie: `__Host-session`, `HttpOnly` (JavaScript cannot read it), `Secure`
  (HTTPS only), `SameSite=Lax`, `Path=/`. The `__Host-` prefix stops
  subdomains from setting or overwriting it.
- A new token is issued at every sign-in (prevents session fixation).
- Idle and absolute limits are enforced by the server on every request, not
  by the cookie's own expiry.
- Sign-out deletes the session server-side. Changing a password or resetting
  2FA ends every session for that account.
- A staff session cannot call client-portal routes and a client session cannot
  call staff routes. Checked by the server on every request.

## Invitations and password reset

- Links carry a 32-byte random token. The database stores only its hash.
- Invitation: valid 7 days. Accepting it sets a password and enrols 2FA in one flow.
  - Sent with `npm run invite -- --kind staff|client --email … --name "…"`.
    Until staff roles exist this is the only way to create an account, so only
    someone with server access can do it. It also creates the first administrator.
  - The link is `APP_BASE_URL/accept-invitation#token=…`. The token is in the
    fragment, which browsers never send to a server, so it cannot appear in
    server or proxy logs or a Referer header.
  - Acceptance: `inspect` (who it is for) → `password` (rules and breach
    check, returns the 2FA secret) → `complete` (2FA code; returns 10 backup
    codes once; activates the account). Until `complete` succeeds the account
    stays `invited` and cannot sign in.
  - Sending a new invitation closes the old one. Inviting an account that is
    already active, or as a different kind, is refused.
  - Each acceptance call carries the 256-bit token, so guessing is not
    feasible and no rate limit is needed.
- Password reset: valid 30 minutes, single use. Requesting one gives the same
  answer whether or not the email exists. Reset does **not** remove 2FA: the
  user still needs their code to sign in afterwards.
  - `POST /auth/password-reset/request` always answers 204. Only active
    accounts get an email, at most 3 an hour, so it cannot flood an inbox.
  - The email is sent in the background, so response time does not reveal
    whether the address has an account. Measured locally: 0.265 s for a real
    account, 0.243 s for an unknown one; the remaining difference is a database
    insert, not the email.
  - `POST /auth/password-reset/complete` checks the new password against the
    same rules, closes the link before changing anything (so two simultaneous
    uses cannot both succeed), ends every session for the account and emails a
    "your password was changed" notice.
  - Requesting a new link closes the previous one.
- Lost 2FA device and no backup codes: staff-assisted reset only, after
  identity checks, recorded in the audit log. Never self-service.

## Security notice emails

Sent in the background, never slowing or failing the action that caused them:

| Email | When |
|---|---|
| Sign-in blocked | The wrong guess that starts a 15-minute block (sent once per block) |
| Password changed | A password reset completes |
| Role granted / role removed | A role is granted to, or revoked from, the account |
| Sensitive role granted | `administrator`, `compliance`, `accounts` or `hr` is granted to someone else: sent to every active compliance holder |
| Possible conflict cleared | A supervising partner clears a possible conflict: sent to every active compliance holder except that partner. Names the matter by reference only; the reason stays out |
| Supervision taken over | A partner takes over supervision of a matter: sent to every active compliance holder except that partner. Names the matter by reference only; the reason stays out |
| Compliance opened a matter | Compliance records an access with a reason: sent to the matter's supervising partner, by matter reference only |
| Compliance access limit reached | Someone reaches 30 compliance accesses in an hour: sent to every other compliance holder and every administrator, naming the person only |
| Client taken over | A partner takes over a client: sent to every active compliance holder except that partner. Names the client by reference only; the reason stays out |

Background email is written to PostgreSQL before the caller returns. Its
address, subject and body are encrypted under `MAIL_ENCRYPTION_KEY`; a worker
with a short lease sends it, and another API instance resumes it after a crash.
Temporary faults retry for at most 24 hours. One-time reset mail is discarded
after its 30-minute link expires. Audit and logs contain ids and outcomes,
never message content. See [notifications.md](notifications.md).

## Secrets this module needs

| Secret | Use |
|---|---|
| `TOTP_ENCRYPTION_KEY` | 32-byte key. 2FA secrets are stored encrypted (AES-256-GCM), so a database leak alone cannot generate codes |
| `MAIL_ENCRYPTION_KEY` | 32-byte key. Pending email addresses, subjects and bodies are stored as AES-256-GCM ciphertext |

From the environment locally, from the secret manager in production.

## Audit events

`auth.sign_in_succeeded`, `auth.sign_in_failed`, `auth.sign_in_blocked`,
`auth.two_factor_failed`, `auth.backup_code_used`, `auth.signed_out`,
`auth.session_expired`, `auth.password_changed`, `auth.password_reset_requested`,
`auth.password_reset_completed`, `auth.two_factor_enrolled`,
`auth.two_factor_reset`, `auth.invitation_accepted`, `account.created`,
`account.disabled`.

A failed sign-in for an email with no account is recorded as an anonymous
event with the reason only. The email is not stored.

## Build order

Each step ships with positive and negative tests and is reviewed before the next.

1. **Accounts and passwords:** `accounts` table, Argon2id hashing, password rules, leaked-password check.
2. **Sessions and sign-in (password step):** sessions table, cookie, guards, sign-out, lockout, staff/client separation.
3. **Two-factor:** TOTP enrolment and verification, encrypted secrets, backup codes.
4. **Invitations and password reset:** needs email sending; locally Mailpit, a mail catcher in Docker, so no real email leaves the machine.
5. **Per-address rate limiting.** Done.

## Not in scope yet

- Passkeys (WebAuthn): stronger than TOTP and phishing-resistant. Planned as an option after launch.
- Single sign-on for staff (Microsoft 365): depends on the firm's setup.
