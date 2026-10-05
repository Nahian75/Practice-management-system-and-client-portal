# Testing

**Current state (2026-10-04):** Unit, HTTP and database integration tests for the API.

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

## Offline by default

`createTestApp` replaces the breached-password service with one that answers
"not listed", so no test reaches the internet. A test can pass its own `fetch`
to simulate a breached password.

## Waiting for email

Tests never wait a fixed time for email. `MailOutbox.drain()` resolves once every
queued email has reached Mailpit, so "no email was sent" is a real result, not a
timeout that happened to be too short. Integration tests have a 20-second limit
(`vitest.config.ts`); Vitest's 5-second default is meant for unit tests.

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
built API, on their own ports (3100 and 3101) and the test database, so they
never meet the development servers. Settings come from `apps/api/.env`.

```sh
npx playwright install chromium     # once
npm run build -w @practice/api      # the tests start the built API
npm run test:e2e -w @practice/web   # builds the web app, then runs the tests
```

- Test staff are set up the real way: invited with the command-line tool, the
  invitation read from Mailpit, password and authenticator set through the API.
  Codes are computed as an authenticator app does (`e2e/support/staff.ts`).
- Each authenticator code works once, so a sign-in right after accepting an
  invitation waits for the next 30-second code, or uses a backup code.
- Screens that need a signed-in person use `signedInStaff` (signs in through
  the sign-in page) and `apiSessionFor` (a second person, signed in through
  the API, to set up data such as someone else's client) from
  `e2e/support/session.ts`. Every test gets new people, so tests never share data.
- Every screen is checked with axe against WCAG 2.2 AA.
- Traces and screenshots of failures stay in the git-ignored `test-results/`.

## Conventions

- Test files sit next to the code they test: `health.controller.ts` →
  `health.controller.spec.ts`.
- Every endpoint is tested over HTTP, not only by calling the method, so
  routing, guards and serialization are exercised.
- Every security rule gets a test that proves it holds and a test that proves
  the attack fails.
