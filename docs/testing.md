# Testing

**Current state (2026-10-12):** Unit, HTTP and database integration tests for
the API, including the security-reviewed Tasks and Notifications modules and
the security-reviewed Finance steps 14a to 14f and Compliance steps 15a to 15f,
plus People / HR steps 16a to 16c. Playwright end-to-end tests cover the staff app,
Tasks, Notifications,
Compliance and the client portal.

## Tools

| Tool | Purpose |
|---|---|
| Vitest | Test runner |
| @nestjs/testing | Builds a real Nest module in memory for each test |
| supertest | Sends real HTTP requests to that in-memory app |

## Database integration tests

Tests under `apps/api/src/database/` run against the real PostgreSQL in
Docker, using the `pms_test` database (`TEST_DATABASE_URL`,
`TEST_MIGRATION_DATABASE_URL` in `apps/api/.env`). They never touch `pms`.
Each migration test works in its own randomly named schema and drops it afterwards.

Document tests also need the SeaweedFS and ClamAV containers (`docker compose
up -d`). They use the `pms-documents-test` bucket and a new random master key
each run. Scanning is tested with the EICAR test file, which every scanner
reports but which is harmless; `test/eicar.ts` builds it at run time, so the
antivirus on a developer's machine does not quarantine the source.

Before any test runs, `test/global-setup.ts` applies the real migrations to
`pms_test` as `pms_owner`. Audit rows cannot be deleted, even in the test
database, so tests identify their own rows by a random actor ID, and the test
database grows with every run. To start from an empty test database, without
touching the development database:

```sh
npm run db:reset-test
```

It recreates `pms_test` with the same setup as the init scripts
(`infra/postgres/reset-test-database.sql`); the next test run applies every
migration again. Tests must not rely on rows left by earlier runs or other
files: a test that needs data creates it.

## Compliance fixtures

`test/aml.ts` builds AML records through the real protected database
functions. Parallel test files call `ensureAmlFramework`, which publishes firm
controls and a country list only when none are current: approving a newer
version makes every cleared matter due for review, so parallel files must not
supersede each other's framework. Tests that deliberately supersede one run as
`*.exclusive.spec.ts`. Tests of other modules call `clearMatterForTests` so
gated work can proceed; it clears through the same functions a firm would use.
The AML and separate suspicion-report test keys are fixed, like the mail key, because firm-wide Compliance
lists decrypt rows that other workers and earlier runs created.

## People / HR fixtures

Step 16a integration tests create personnel records only through the protected
API/functions and use a dedicated deterministic test `HR_ENCRYPTION_KEY`.
Coverage proves role separation and safe directory output, self-service,
current-manager-only projections and immediate former-manager denial,
effective-date/overlap/cycle constraints, encrypted append-only corrections,
private-file authorization and storage namespace, direct `pms_app` denial,
owner immutability, person/path binding, concurrent role loss and strict unsafe
input rejection. Cipher unit tests prove purpose/person binding and separation
from the AML key.

Step 16b integration tests exercise HR-only policy/entitlement authority,
encrypted self-service requests and the pending queue, exact work-pattern
expansion, self-approval/category restrictions, overlap and insufficient-balance
conflicts, cancellation returns, reason-free sickness, health separation,
manager-safe adjustment projection/progress, six-year holiday-pay evidence,
direct-table denial and owner immutability. Migration reset, API type-check/build,
focused/full API suites and hidden-character checks are run before handoff.

Step 16c integration tests exercise HR-only lifecycle administration, safe
self/current-manager projections, mandatory-item and latest-right-to-work
completion gates, read-only leaver blockers, evidence-person binding, encrypted
right-to-work and professional detail, version/follow-up/backdate handling, the
due queue, strict request shapes, content-free audit metadata, direct-table
denial and owner immutability. The final clean run passed 105 API files/1,942
tests; the focused 16c file passed 10/10. API type-check and production build,
the all-files hidden-character scan and `git diff --check` also passed.

In the browser tests, the `aml-setup` Playwright project publishes and approves
the framework through the API once, before any test, and `openMatter` clears
each matter it opens unless told not to.

Step 15f adds focused migration and HTTP tests for retention eligibility,
chronological legal-hold release, direct-access denial, object-key preparation,
content-free tombstones, nominated-officer disposal, encrypted ordinary and
restricted exports, integrity/no-store downloads and exclusion of restricted
facts from both ordinary exports and the general attention count. Browser tests
cover the neutral staff report, ordinary Compliance dashboard/retention flow,
a complete protected CDD subject/evidence/verification/submission workflow,
the separately revealed officer queue, 390-pixel layout and axe checks.
Five deliberate 15f mutations were caught and restored: UUID-only legal-hold
ordering, a 6-10-year request window, a cacheable regulatory download, a
general attention count that leaked restricted-report existence and disposal
without the live nominated-officer check.
The step 15f clean run passed 101 API files/1,821 tests and 83/83 Playwright tests,
including the web production build. API production build, both strict type-
checks, the all-files hidden-character scan and `git diff --check` also passed.

Sanctions tests never use the network. `test/sanctions.ts` builds CSVs in the
official layout with the real header row, and refresh tests pass a fake `fetch`. `screenTestClient` records a clear screening
through the real database function, and `decideTestClearance` calls it first,
because clearance needs clear screening. `ensureSanctionsList` keeps the active
list fresh by replaying its own hash rather than activating a new version, which
would leave every earlier screening out of date. Screening tests use names no
other test uses, so only their own clients can match.

## Email tests

Tests that send email deliver to Mailpit and read it back through its API
(`test/mailpit.ts`). Each test uses its own random address.

The outbox tests also inspect PostgreSQL directly: no address, subject, body
or one-time token is readable there; a new worker delivers a row left by an
earlier instance; terminal outcomes clear ciphertext; duplicate keys produce
one row; and audit metadata stays free of message content. The database-wide
lease, state-machine and owner-immutability tests run as
`mail-outbox.migration.exclusive.spec.ts`, after ordinary tests, so their
deliberately held leases cannot delay another test's worker.

The reminder migration test runs as
`task-reminders.migration.exclusive.spec.ts`. Its database function scans all
eligible tasks, so running it after ordinary files prevents it from consuming
a reminder created by a service transaction test.

The Playwright API server and invitation command run in separate processes
but share the `pms_e2e` outbox. They use the same deterministic test-only mail
key; `pms_e2e` is recreated before every browser run, so no older payload is
kept under that key.

## Offline by default

`createTestApp` replaces the breached-password service with one that answers
"not listed", so no test reaches the internet. A test can pass its own `fetch`
to simulate a breached password.

## Waiting for email

Tests never wait a fixed time for email. `MailOutbox.drain()` resolves once
every email due now has reached a terminal outcome or a future retry time,
including rows leased by another test worker. Thus "no email was sent" is a
real result, not a timeout that happened to be too short. Integration tests
have a 20-second limit (`vitest.config.ts`); Vitest's 5-second default is meant
for unit tests. Overlapping calls on one app share one worker loop. App
shutdown stops that loop after any already-claimed message, so closing one
test app cannot be held up by a lease belonging to another app.

## Network addresses in tests

Test apps believe `X-Forwarded-For` from loopback, and give every request a
random address from 198.18.0.0/15 (reserved for testing) unless the test sets
one. Many tests fail sign-ins on purpose; without this they would all share
127.0.0.1 and trip the per-address limit for each other.

## Tests that need the whole database

Most test files run in parallel against the same test database, so each test
only looks at rows it created. A few rules are about the whole database, such
as "at least one active administrator", and a test of them must change rows
other tests rely on. Those files are named `*.exclusive.spec.ts`. Vitest runs
them as a separate project after every other test file has finished, one file
at a time (`vitest.config.ts`).

## Running

```sh
docker compose up -d
npm test -w @practice/api
npm run typecheck -w @practice/api
```

## Web app, end to end

Playwright drives a real browser (Chromium) against the built web app and the
built API, on their own ports (3100 and 3101) and their own database, `pms_e2e`,
so they never meet the development servers or the API's tests. Settings come
from `apps/api/.env`; the database address is the test one with the name changed.

```sh
npx playwright install chromium     # once
npm run build -w @practice/api      # the tests start the built API
npm run test:e2e -w @practice/web   # builds the web app, recreates and migrates pms_e2e, runs the tests
```

- `pms_e2e` is recreated empty before every `test:e2e` (`e2e/prepare-database.mjs`,
  with `infra/postgres/reset-test-database.sql`). It is separate from `pms_test`
  because both suites sign in from `127.0.0.1`: sharing a database let the API
  tests' deliberate failures use up the browser tests' per-address sign-in
  allowance. Running `npx playwright test` directly reuses the database as it is.
- A second copy of the web app runs on 3102 with no API behind it, so
  `e2e/error-pages.spec.ts` sees what people see when the API is down. Its
  failed calls show in the test output as `[WebServer] fetch failed`; that is
  expected.
- After clicking a link, tests use `follow(page, link)` (`e2e/support/checks.ts`),
  which waits for the new page's address, before checking it with axe.
- Test staff are set up the real way: invited with the command-line tool, the
  invitation read from Mailpit, password and authenticator set through the API.
  Codes are computed as an authenticator app does (`e2e/support/staff.ts`).
- Each authenticator code works once, so a sign-in right after accepting an
  invitation waits for the next 30-second code, or uses a backup code.
- Screens that need a signed-in person use `signedInStaff` (signs in through
  the sign-in page) and `apiSessionFor` (a second person, signed in through
  the API, to set up data such as someone else's client) from
  `e2e/support/session.ts`. Every test gets new people, so tests never share data.
- Portal tests create a client account through the real staff invitation,
  emailed link, password and two-factor flow. They check the staff/client
  boundary, client-safe fields, exact latest-version downloads and access
  ending on the next page request.
- Portal review tests also change the address on the client record, write link
  attacks directly as both database roles, and force a share and withdrawal
  to race by holding their PostgreSQL advisory lock. That makes the narrow
  audit race repeat every time instead of hoping timing exposes it.
- Task database tests bypass the API to check the open-matter, active creator
  and active assignee rules, protected columns, constraints and owner-level
  immutability. They also cover insert-only before-and-after history, actor
  and transition rules, invalid mixed change shapes and no-op removal.
  Controlled races prove the row locks order closure against creation,
  completion and reopening. HTTP tests cover permissions, hidden records,
  strict input, history responses, audit privacy and rollback, no-op audit
  suppression, status actors, closure refusal and 100-row pagination.
- Task browser tests cover creating and listing, invalid input, details and
  before-and-after history, editing, reassignment, every status action,
  non-assignee controls, indistinguishable outsider access, open-task closure
  refusal, closed-matter read-only behaviour, and the immediate loss of
  supervisor status controls after the partner role ends. Database and HTTP
  regressions cover the same role loss; a controlled race proves role removal
  is ordered before or after the status change. They run axe on the matter and
  task screens.
- Notification database tests cover trusted ids and times, allowed kinds and
  recipients, database-created assignment and status events, deduplication,
  application-role privileges, insert-only rows, truncation guards, live
  access at first read and repeat-safe one-way read state. HTTP tests cover
  current task text, recipient and matter visibility, staff/client boundaries,
  paging, unread counts, strict input, private audit metadata and rollback.
- Reminder tests cover all four calendar points, missed-day catch-up, repeat
  de-duplication, the single-batch advisory lock, immutable feature start date,
  and ineligible tasks and recipients. Unit tests cover GMT/BST scheduling and
  production startup catch-up. Service and worker tests cover encrypted generic
  task email, private-content exclusion, transactional audit rollback, and
  last-moment rejection after a due date, assignee, status, membership or
  account change. Automatic scheduler startup stays off in test applications
  so parallel files cannot process each other's rows.
- Notification browser tests cover the header unread count, safe current task
  facts, one-way read action, task navigation, 50-row paging, empty state and
  axe accessibility. Negative cases cover private text, immediate loss of
  matter access and the client/staff layout boundary.
- Finance tests cover exact decimal-string conversion, permissions, effective
  rates, rate snapshots, own-time recording, corrections and voids, safe
  list/detail responses, live record visibility, audit privacy and rollback,
  and 100-row keyset paging. Database tests use both application and owner
  roles for column grants, constraints and permanent history. A controlled
  race orders matter closure against time insertion. Deliberate breaks of the
  application and migration safeguards are recorded in the
  [step 14a](finance.md#step-14a-verification) and
  [step 14b](finance.md#step-14b-verification) and
  [step 14c](finance.md#step-14c-verification) and
  [step 14d](finance.md#step-14d-verification) and
  [step 14e](finance.md#step-14e-verification) and
  [step 14f](finance.md#step-14f-verification) verification notes.
- Billing tests cover exact positive amounts, VAT rounding, draft replacement,
  issue snapshots and numbering, linked-time use, credit-note remaining
  balances, delivery records, fixed downloads, permissions, record visibility,
  strict inputs, safe summary and attachment responses, audit privacy and
  rollback. Database tests exercise narrow functions and owner-level
  immutability; controlled races cover issue, numbering and over-crediting.
- Finance-ledger tests cover authenticated encryption and context binding,
  safe bank-register responses, live Accounts permission checks, permanent
  closures, exact receipts, same-client allocation corrections, signed
  balances, per-entry running balances and stable 100-row paging. Database tests prove balanced
  double-entry shapes, automatic bill/credit postings, client nonnegative
  balances, direct-write denial and owner immutability; a controlled race
  proves concurrent allocations cannot overspend one client balance.
- Client-payment tests cover encrypted payees, strict safe responses, live
  Accounts permissions, four-eyes approval, requester cancellation, terminal
  bank outcomes and transactional success/denial audit. Database tests cover
  current evidence, reservations, balanced withdrawals and billed-cost
  transfers, bank closure, later credits and paid dates not preceding approval;
  controlled races prove concurrent approvals cannot reserve the same client
  balance and role revocation cannot pass an in-progress approval.
- Reconciliation tests parse CSV as inert UTF-8 data and cover exact headers,
  quotes, formula/control rejection, impossible dates, size/row/money bounds,
  hashes, duplicate files/rows and opening-to-closing arithmetic. HTTP and
  database tests cover Accounts/Compliance separation, exact match facts,
  reversal/rematch history, complete client-bank coverage, server-calculated
  totals, required explanations, fixed snapshots with per-matter client
  liabilities, self-sign-off refusal,
  signed-only 35-day status, safe responses, private audit and rollback.
  Twenty-two deliberate application and migration breaks were caught and
  restored before the full suite.
- The whole-ledger reconciliation migration spec is in the serial exclusive
  project, after the parallel API files, because its snapshot rules
  intentionally observe every client-money posting in the test database.
- Finance browser tests cover matter time entry, role-sensitive navigation,
  Accounts queues and forms, cash-book CSV download, billing, four-eyes
  payments, statement reconciliation, narrow mobile layout, Compliance
  read-only/sign-off presentation, denied fee-earner access and axe WCAG 2.2
  AA checks. The serial Finance journeys use a 60-second per-test budget for
  multi-account setup, downloads and accessibility scans. API tests cover live
  action capabilities, the draft queue, audited export headers/content, and
  formula-safe CSV encoding.
- Compliance-foundation HTTP tests cover the administrator, Compliance,
  Partner and ordinary-staff boundaries; appointment eligibility and
  continuity; fixed numbered controls and digest responses; separate approval;
  approved in-period training and self-attestation; independent reviews;
  strict inputs, pagination, safe responses and transactional audit. Database
  tests use the application and owner roles for direct-write denial, live-role
  rechecks and immutable history. Controlled concurrency proves version
  allocation and last-nominated-officer protection serialize correctly.
- CDD HTTP tests cover visible-client and firm-wide Compliance access, safe
  keyset summaries, strict individual/entity facts, ownership and authority
  graphs, manual/electronic verification, protected uploads/downloads,
  cross-case rejection, snapshots and submission. Database tests probe direct
  application and owner writes, live-role loss, context binding, future dates,
  immutable final history and competing drafts. Dedicated cipher/vault tests
  prove distinct-key failure, purpose-bound integrity, non-plaintext metadata,
  compliance object names and encrypted streaming round trips.
- Conflict checks match names loosely, so tests that expect no match use
  `randomName()` from `e2e/support/checks.ts`: names made of random letters,
  sharing no word with any other test's names.
- Every screen is checked with axe against WCAG 2.2 AA.
- Traces and screenshots of failures stay in the git-ignored `test-results/`.

## Conventions

- Test files sit next to the code they test: `health.controller.ts` →
  `health.controller.spec.ts`.
- Every endpoint is tested over HTTP, not only by calling the method, so
  routing, guards and serialization are exercised.
- Every security rule gets a test that proves it holds and a test that proves
  the attack fails.
