# Testing

**Current state (2026-10-03):** Unit, HTTP and database integration tests for the API.

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
database, so tests identify their own rows by a random actor ID. To start from
an empty test database: `docker compose down -v && docker compose up -d`.

## Email tests

Tests that send email deliver to Mailpit and read it back through its API
(`test/mailpit.ts`). Each test uses its own random address.

## Offline by default

`createTestApp` replaces the breached-password service with one that answers
"not listed", so no test reaches the internet. A test can pass its own `fetch`
to simulate a breached password.

## Running

```sh
docker compose up -d
npm test -w @practice/api
npm run typecheck -w @practice/api
```

## Conventions

- Test files sit next to the code they test: `health.controller.ts` →
  `health.controller.spec.ts`.
- Every endpoint is tested over HTTP, not only by calling the method, so
  routing, guards and serialization are exercised.
- Every security rule gets a test that proves it holds and a test that proves
  the attack fails.
