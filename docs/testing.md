# Testing

**Current state (2026-10-07):** Unit, HTTP and database integration tests for
the API, including the security-reviewed Tasks module and Notifications step
13a, and Playwright end-to-end tests for the staff app, Tasks step 12c and the
client portal.

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
for unit tests.

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
