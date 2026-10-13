# Security

**Current state (2026-10-13):** Core API, staff-web, client-portal, task and
notification controls are built and reviewed. Notifications steps 13a to 13d add the
persistent encrypted email outbox, insert-only staff task notifications,
database-controlled one-way reads, live matter-access checks, staff-only
list/read routes, generic task email and database-deduplicated reminders.
The worker rechecks the recipient address, current assignee, task state, due
date, team membership and account before delivery. The database refuses a
future London reminder window. Staff screens use only the filtered API answer;
client accounts are sent back to the separate portal. The Notifications module
review fixed N1 and N2. Finance steps 14a to 14e add database-enforced
immutable rates, time, billing and posting records, exact integer-pence limits,
live role/team checks, encrypted bank details, balanced postings, nonnegative
client ledgers, fixed downloads, encrypted payment recipients, live four-eyes
approval, reserved-balance locking, immutable bank outcomes, inert CSV
statement parsing, duplicate detection, locked exact matching, permanent
match reversals, server-calculated reconciliation snapshots, separate
Compliance sign-off, signed-only deadlines, transactional audit, and audited
CSV exports that quote every field and make spreadsheet formula prefixes
literal. The Finance security review is complete. Compliance step 15a adds
separate administrator, Compliance and Partner permissions, live-role checks,
protected nominated-officer continuity, fixed firm-control digests and
owner-immutable approval, training and independent-review evidence. Step 15b
adds record-rule CDD access, protected-only database writes, immutable
submission snapshots, AML-specific metadata/file encryption, a separate
compliance object namespace and fail-closed evidence inspection. Step 15c-1
adds database-forced high ratings for mandatory enhanced-due-diligence factors,
encrypted risk reasoning, matter-team rechecks and protected write flags that
are cleared before each function returns. Step 15c-4 enforces the compliance gate
in PostgreSQL triggers on every time, billing, document and money table, with
one generic refusal and shared/exclusive advisory locks against races with holds. Step 15d-2 screens clients
and CDD subjects against the official list, holds any unresolved or confirmed
match, and keeps names and match status out of audit metadata. Step 15d-3 freezes
balances and receipts for confirmed designations, permits only licensed actions
within a money limit, and shows Accounts the operational outcome without the reason.
Step 15e puts internal suspicion reports, attachments, decisions and external
SAR/DAML event records behind a separate key, object namespace, access log and
live nominated-officer check. Step 15f adds exact five-year relationship-end
retention, encrypted legal-hold evidence, transaction-locked object/database
disposal, content-free tombstones, segregated regulatory exports and a
restricted-content-free attention count. The Compliance security review is in
[`reviews/2026-10-11-compliance.md`](reviews/2026-10-11-compliance.md).
People / HR steps 16a to 16f add an independent HR role and encryption key, protected
append-only employment history, live self/HR/current-manager database checks,
bounded manager response schemas and a private `hr/` file namespace. Direct
application-table reads/writes and owner mutation/truncation are refused. The
leave boundary adds serialized person/year approval, exact immutable daily
minutes and signed ledger entries. Manager projections exclude pay, ledger
notes, health facts and private adjustment grounds; sickness accepts no medical
free text. Health and each private/operational adjustment purpose have distinct
authenticated encryption contexts. Lifecycle and vetting tables add no direct
application access; protected functions serialize current-check versions,
bind evidence to the same person's encrypted identity file and keep checklist,
right-to-work and professional history owner-immutable. Manager vetting output
is limited to expiry/action and public status. Leaver checks expose safe blocker
ids/statuses but give HR no account, role, client, matter, task or AML mutation
path. Competence/review tables are likewise protected and immutable; distinct
encryption contexts cover every narrative and evidence event, and PostgreSQL
separates worker authorship from manager/HR authorship. HR receives AML training
only through a Compliance-owned status projection that omits provider, evidence,
control content and every restricted record. Step 16e keeps confidential cases
behind current explicit membership, enforces investigator/decision/appeal role
separation, rechecks live HR status for HR members and records each sensitive
view separately. Category retention uses database-derived source dates,
serialized holds and disposal with content-free tombstones. Fixed encrypted
exports require a different live HR reviewer, recheck included-case membership,
are integrity-checked on download and are removed when they could preserve
disposed content. Direct application table access and owner history changes are
refused outside the narrow protected disposal path. Step 16f keeps screens on
filtered server-rendered responses, treats capability flags as presentation
only, derives the manager list in PostgreSQL, requires typed disposal
confirmation and prevents automatic prefetch of protected downloads. The HR
module security review is in [`reviews/2026-10-14-hr.md`](reviews/2026-10-14-hr.md).

This file lists only the controls that are actually in place.

## Secret scanning

**Tool:** gitleaks 8.30.1 (MIT licence, runs locally, sends nothing over the network).

**Where:** `.githooks/pre-commit` runs before every commit and scans only the
staged changes.

**Behaviour:**
- A detected secret blocks the commit.
- If gitleaks is not installed, the commit is blocked. The hook never skips the scan.
- Inline `gitleaks:allow` comments are ignored, so a secret cannot be waved
  through from inside the file that contains it.
- Findings are redacted in the output, so the secret is not echoed to the terminal.

**Setup (once per clone):**

```sh
winget install Gitleaks.Gitleaks
git config core.hooksPath .githooks
```

**Limits:**
- A local hook can be skipped with `git commit --no-verify`. The same scan
  will run in CI so a skipped hook cannot let a secret reach the main branch.
  Not yet in place: CI does not exist yet.
- A false positive is handled by adding its fingerprint to `.gitleaksignore`,
  which is reviewed like any other change.

## Hidden characters in source

**Tool:** `scripts/check-hidden-characters.mjs`, run by the same pre-commit
hook after gitleaks ([review C10](reviews/2026-10-04-clients.md)).

**Why:** control characters, zero-width characters, line separators and
text-direction controls cannot be seen in an editor or a diff, but the
compiler reads them. Direction controls can make code display differently
from what runs ("Trojan Source"). One reached a commit once, because an
editing tool turned an escape sequence into the real character.

**Behaviour:**
- Checks the staged version of every staged text file; binary files are skipped.
- Any such character blocks the commit, with file, line, column and code point.
  Write it as an escape sequence instead (for example `\u202E` in code).
- `npm run check:hidden-characters` checks every committed file.

**Limits:** skipped by `git commit --no-verify`, like the secret scan; CI will
run it too once CI exists.

## Dependencies

Settings in `.npmrc`:

| Setting | Effect |
|---|---|
| `ignore-scripts=true` | Packages cannot run code during `npm install`. Blocks the most common npm supply-chain attack. |
| `save-exact=true` | Versions are pinned exactly. An upgrade is always a deliberate, reviewed change. |
| `engine-strict=true` | Install fails on an unsupported Node.js version. |
| `min-release-age=7` | npm refuses any package version, direct or indirect, published less than 7 days ago. Malicious releases are usually caught and pulled within that window. |

`package-lock.json` is committed, so every install resolves the same versions.

Every new dependency is justified in the change that adds it. Template
extras that send data to external services (`@nestjs/observe`) or exist to
sell a hosting product (`@nestjs/mau`) are not installed.

Exceptions to the 7-day rule need the project owner's approval and are listed in
`dependency-age-exceptions.json` with a reason and an expiry date. Current: nodemailer
10.0.13 until 2026-10-07 (see ADR-008).

`npm run check:dependency-age` re-checks every package in the lockfile against
the registry, because `npm ci` installs locked versions without re-checking ages.

Before stepping a package back to satisfy the 7-day rule, check its security
advisories: holding back a release that fixes a vulnerability would be worse.

## Request pipeline

Every control below is applied in `configureApp` (`apps/api/src/app.setup.ts`).
The server and every HTTP test use the same function, so tests exercise the
real configuration. Each control has a test that fails if it is removed.

### Security headers

`app.useSecurityHeaders()`, built into NestJS 12 (same headers as helmet 8,
so helmet is not a dependency).

- `X-Powered-By` is removed, so responses do not reveal Express.
- `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options`, `Referrer-Policy: no-referrer` and a restrictive
  `Content-Security-Policy` are set on every response, including errors.
- `Cache-Control: no-store` on every response, including errors, so the
  browser never keeps client or staff details (review W2). Signing out also
  sends `Clear-Site-Data: "cache"`.
- CORS is off. Browsers on other origins cannot call the API.

### CSRF protection

`app.enableCsrfProtection()`, built into NestJS 12. Uses the browser's
`Sec-Fetch-Site` header, falling back to comparing `Origin` with `Host`.

- `POST`, `PUT`, `PATCH`, `DELETE` from another site are rejected with 403.
- `GET`, `HEAD`, `OPTIONS` are always allowed, so they must never change data.
- Requests without either header (non-browser clients) are allowed. This
  protects browser sessions, not the API from scripts. Authentication does that.
- Behind a load balancer, `Host` must be preserved or the public origin listed
  in `trustedOrigins`.

### Input validation — fail closed

`StrictSchemaValidationPipe` (`apps/api/src/common/validation/`).

- Every `@Body()`, `@Query()` and `@Param()` must declare a Zod schema. A
  route that forgets one returns 500 and its handler never runs. NestJS's own
  pipe would pass the value through unchecked.
- Request schemas use `z.strictObject`, so unknown fields are rejected rather
  than silently dropped. Example: `{"name":"x","role":"admin"}` → 400.
- `__proto__` keys are stripped before validation (prototype pollution).
- Never use `z.coerce.boolean()`: it turns the string `"false"` into `true`.
- Request bodies over 100 KB are rejected with 413 (NestJS default).

### Response filtering — fail closed

`StrictSchemaSerializerInterceptor` (`apps/api/src/common/serialization/`).

- Every route must declare `@ResponseSchema(schema)`. A route without one
  returns 500 and its handler never runs.
- Response schemas use `z.object`, which drops undeclared fields. A route
  that returns a full database row sends only the fields its schema lists.
- A response that does not match its schema returns 500 rather than partial data.

### Error handling

`AllExceptionsFilter` (`apps/api/src/common/errors/`).

- 5xx: the client gets `{statusCode, message: "Internal Server Error", reference}`.
  The error and stack are logged under the same `reference` (a random UUID),
  so support can find the log entry without the client seeing internals.
- 4xx: the message of a deliberate `HttpException` is returned as written.
  These messages are written for clients and must not contain internal data.
- The log line records method and path. Never the query string, which can
  carry tokens.
- Known gap: an error message itself may contain personal data (for example
  a database constraint error quoting a value). Database errors must be
  translated before they reach this filter. Addressed with the database layer.

## Configuration

Settings come from environment variables and are validated at startup
(`apps/api/src/config/env.ts`). An invalid or missing setting stops the
process before it accepts any request.

- Error messages name the variable and the rule it broke, never its value,
  because a value may be a secret.
- `HOST` defaults to `127.0.0.1`, so a local server is not reachable from
  the network unless deliberately configured.
- Locally, values come from `apps/api/.env` (git-ignored), copied from
  `.env.example`. In production they come from the secret manager.

## Logging

- Production logs are JSON, one object per line, for the log platform.
- Rule: never log passwords, tokens, session IDs, request bodies or client
  personal data. Log IDs and outcomes instead.

## Security reviews

| Date | Scope | Report |
|---|---|---|
| 2026-10-04 | Authentication module | [reviews/2026-10-04-authentication.md](reviews/2026-10-04-authentication.md) |
| 2026-10-04 | Users and roles module | [reviews/2026-10-04-users-roles.md](reviews/2026-10-04-users-roles.md) |
| 2026-10-04 | Clients module | [reviews/2026-10-04-clients.md](reviews/2026-10-04-clients.md) |
| 2026-10-05 | Matters module | [reviews/2026-10-05-matters.md](reviews/2026-10-05-matters.md) |
| 2026-10-05 | Staff web app | [reviews/2026-10-05-web.md](reviews/2026-10-05-web.md) |
| 2026-10-06 | Documents module | [reviews/2026-10-06-documents.md](reviews/2026-10-06-documents.md) |
| 2026-10-07 | Client portal | [reviews/2026-10-07-portal.md](reviews/2026-10-07-portal.md) |
| 2026-10-07 | Tasks module | [reviews/2026-10-07-tasks.md](reviews/2026-10-07-tasks.md) |
| 2026-10-08 | Notifications module | [reviews/2026-10-08-notifications.md](reviews/2026-10-08-notifications.md) |
| 2026-10-10 | Finance module | [reviews/2026-10-10-finance.md](reviews/2026-10-10-finance.md) |
| 2026-10-11 | Compliance / AML module | [reviews/2026-10-11-compliance.md](reviews/2026-10-11-compliance.md) |
| 2026-10-13 | Client onboarding module | [reviews/2026-10-13-onboarding.md](reviews/2026-10-13-onboarding.md) |
| 2026-10-14 | People / HR module | [reviews/2026-10-14-hr.md](reviews/2026-10-14-hr.md) |
| 2026-10-14 | AI & Legal Drafting Assistant | [reviews/2026-10-14-ai.md](reviews/2026-10-14-ai.md) |

Pre-production security items closed (Step 19):
- **F2 (Edge Reverse Proxy & Rate Limiting):** Closed. Production Nginx and Caddy reverse proxy configurations in `infra/proxy/` enforce 52 MB streaming upload limits on document/evidence routes, 1 MB default limits, connection limits, and sign-in brute-force rate limits.
- **F3 (Ephemeral Security Retention):** Closed. Migration `0075_security_ephemeral_retention.sql`, `SecurityRetentionService`, and CLI command `retention:sweep` purge expired sessions, sign-in failures, password resets, invitations, and completed email outbox rows.
- **C6 (Encrypted Storage & Backups):** Closed. [docs/disaster-recovery.md](disaster-recovery.md) specifies AES-256 block encryption, continuous WAL archiving, RPO ≤ 15 min, RTO ≤ 4 hr, dual-region UK residency, immutable WORM backups, and the post-restore disposal replay procedure.
- **Authentication F5:** Closed by the persistent email outbox in [Notifications step 13a](notifications.md).
- **Production Hygiene Gate:** Enforced via `npm run check:production-hygiene`.

Local demo conveniences that must not reach production (to fix before
deploying): `code.bat` and `scripts/demo-code.mjs`, which show the current
security code of the demo login from its setup key, so they would defeat
two-factor for any account whose key they could read; the git-ignored
`DEMO-LOGIN.txt`; and the demo account itself (`demo@practice.test`), which
exists only in the local database. A production build and deployment must
leave all of them out. **To fix later, by decision of the project owner:**
remove `code.bat` and its script, and go back to the default, codes from a
third-party authenticator app (Microsoft Authenticator, Google Authenticator
and the like), for the demo login too.

## Client addresses

`TRUSTED_PROXIES` (comma-separated IPs, CIDR ranges, or `loopback`,
`linklocal`, `uniquelocal`) lists the proxies allowed to report the client's
address in `X-Forwarded-For`. Empty by default: the address is always the TCP
peer. Rate limits and the audit log use this address, so trusting too much lets
an attacker choose it. Tested: with no trusted proxies, a forged header changes
neither the limit nor the recorded address.

## Database access

- The API connects as `pms_app` and is only given `DATABASE_URL`. It never
  holds the owner credentials.
- Migrations connect as `pms_owner` through a separate command
  (`npm run migrate`) with its own `MIGRATION_DATABASE_URL`. They refuse to run
  as a superuser, so every table is owned by `pms_owner` and the app role's
  default privileges apply.
- In production, both URLs must include `sslmode=verify-full`: encrypted, and
  the server certificate is checked. The API and the migration command refuse
  to start otherwise.
- The API checks the connection at startup and exits if the database is
  unreachable or the credentials are wrong.
- Migration history lives in schema `migrations`, which `pms_app` cannot read
  or write, so the app cannot fake an applied migration.
- Role privileges are covered by integration tests
  (`apps/api/src/database/database.module.spec.ts`).
- Finance tables grant the application only the operations and columns it
  needs. PostgreSQL supplies ids and times, chooses effective rate snapshots,
  checks active roles, accounts, matter state and team membership, and orders
  matter closure against time insertion with a row lock. Billing writes use
  narrow database functions: the application has no direct table writes,
  drafts require an active Accounts actor and an open matter, and issue takes
  fixed client, supplier, reference, time, VAT and total snapshots.
- Rates and posted time history cannot be updated, deleted or truncated even
  by their owner. Drafts are mutable only until issue; issued bill and
  credit-note headers and lines, delivery events and their source drafts are
  then owner-immutable. Advisory and row locks serialise invoice and credit
  numbering, one-time issue, linked-time use and concurrent credits.
- Finance API tests separately prove permission checks, record filters,
  strict request/response schemas, safe attachment headers, private audit
  metadata and transactional rollback.
- Bank details are AES-GCM encrypted before PostgreSQL under a separate key;
  the database stores only ciphertext, integrity material, a keyed duplicate
  fingerprint and the last four account-number digits. Narrow security-definer
  functions recheck the live Accounts role and create balanced postings. The
  application cannot write register or ledger tables directly, and owner-level
  triggers reject changes and truncation. Stable matter locks and a deferred
  balance check stop concurrent client allocations creating a debit balance.
- Statement uploads are buffered only to a 5 MB bound, decoded as strict
  UTF-8 and parsed as CSV data. The service never invokes spreadsheet code;
  exact headers, safe non-formula text, calendar dates, row count, signed
  amounts and opening/closing arithmetic are checked before and inside the
  database. Raw SHA-256 file hashes and normalized row fingerprints block
  duplicates without being returned by the API.
- The application cannot directly write statement, match or reconciliation
  tables. Narrow functions recheck live Accounts/Compliance roles, lock match
  participants, recompute all reconciliation totals and require complete
  client-bank coverage and explanations. Match reversals and sign-off are new
  immutable events; owner-level triggers reject every later change or removal.
  Deadline status counts only a signed snapshot.
- Compliance foundation writes use narrow security-definer functions that
  recheck the actor's live role. PostgreSQL serializes officer continuity and
  control version allocation, verifies each stored SHA-256 digest against the
  fixed text, requires a different active Partner for approval, and refuses
  direct application writes. Owner-level triggers keep controls, approvals,
  training completions and independent reviews fixed and keep appointment
  history append-only apart from its protected ending operation.
- Client CDD writes also use narrow security-definer functions. They recheck
  the active Partner/fee-earner client-visibility rule or active Compliance
  role, bind every subject/evidence/graph node to one draft and serialize the
  one-live-draft and final-submission transitions. Fail-closed insert guards
  deny application and owner writes outside those functions; final cases and
  facts reject update, deletion and truncation.
- AML identity facts and evidence metadata use authenticated AES-256-GCM under
  a distinct `AML_ENCRYPTION_KEY`, bound to record-and-purpose contexts. Each
  evidence file has its own key wrapped by that master key and is stored only
  under a random `compliance/<uuid>` object key. Uploads reuse strict type,
  active-content and malware inspection but never enter the ordinary document
  tables, sharing routes or client portal.
- Internal disclosures, SAR/DAML decisions, exact external references and
  restricted attachment metadata use a separate `SUSPICION_ENCRYPTION_KEY`.
  Restricted files use per-file keys wrapped by it and random
  `compliance/restricted/<uuid>` objects. Only protected database functions can
  read ciphertext, and those lock a live Compliance role and nominated-officer
  appointment; successful views/downloads enter a separate protected access log.
- Retention schedules and legal-hold reasons are ordinary AML ciphertext.
  Disposal is the sole mode that relaxes AML immutability: a protected prepare
  step fixes private object keys, the service deletes them, and a protected
  finalize step rechecks due date, closure, legal/operational holds and any
  nominated-officer requirement before erasing content. Only content-free
  tombstones remain.
- Ordinary and restricted regulatory exports are different encrypted tables,
  keys and read functions. Downloads recompute SHA-256 and set attachment,
  `private, no-store`, `nosniff` and sandbox CSP headers. The general Compliance
  attention badge is calculated in PostgreSQL and excludes restricted records
  and restricted-linked holds.

## Application secrets

| Secret | Purpose | If lost | If leaked |
|---|---|---|---|
| `TOTP_ENCRYPTION_KEY` | Encrypts 2FA secrets | Every account must re-enrol 2FA | With a copy of the database, an attacker could generate 2FA codes. Rotate the key and require re-enrolment |
| `MAIL_ENCRYPTION_KEY` | Encrypts queued email addresses, subjects and bodies | Pending mail cannot be delivered; people may need a new invitation or reset link | With a copy of the database, an attacker could read pending email, including one-time links. Rotate the key; old pending rows fail their integrity check and must be requested again |
| `FINANCE_ENCRYPTION_KEY` | Encrypts bank details and keys their duplicate fingerprint | Full bank details become unreadable; safe register and ledger history remain | With a copy of the database, an attacker could read bank details and test guessed details. Replace the key through a designed re-encryption migration; do not silently discard old key material |
| `AML_ENCRYPTION_KEY` | Encrypts AML identity/source metadata and wraps protected evidence file keys | Protected CDD identity details and evidence become unreadable; safe ids/status history remains | With database plus object storage, an attacker could read highly sensitive identity evidence. Isolate and rotate through a designed re-encryption process; never reuse another application key |
| `SUSPICION_ENCRYPTION_KEY` | Encrypts internal disclosures, decisions, external SAR/DAML facts and wraps restricted attachment keys | Restricted reports and attachments become unreadable; content-free ids and operational holds remain | With database plus object storage, an attacker could read exceptionally sensitive suspicion material. Keep it in a separate secret boundary, never reuse it, and rotate only through a designed re-encryption/rewrapping process |
| `DOCUMENT_ENCRYPTION_KEY` | Wraps ordinary matter-document file keys | Ordinary stored documents become unreadable | With database plus object storage, an attacker could read ordinary matter documents. Rotate through a designed rewrapping process |

Locally in `apps/api/.env` (git-ignored). In production from the secret manager,
never from a file in the image.

## Files Git never tracks

`.gitignore` excludes environment files (except `.env.example`), keys and
certificates, uploads, local storage, database dumps and logs.
See [.gitignore](../.gitignore).
