# Authorization

**Current state (2026-10-03):** Route-level access only. Record-level rules
(which client or matter an account may see) are not built yet.

## Layer 1: who may call a route (built)

`SessionGuard` (`apps/api/src/auth/sessions/session.guard.ts`) runs before
every route and is registered in `configureApp`, so the app cannot start
without it.

- Every route must carry `@Public()`, `@StaffOnly()`, `@ClientOnly()` or
  `@AnyAccount()`. A route with none returns 500 and never runs.
- A staff session on a client route, or a client session on a staff route,
  gets 403 and is recorded as `auth.access_denied`.
- A session still waiting for its 2FA code is treated as signed out.

## Layer 2: which records (not built)

Being signed in as staff will not be enough to read a matter. Each service
will check the account's relationship to the specific client or matter.
Designed with the Clients and Matters modules.
