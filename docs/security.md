# Security

**Current state (2026-10-03):** API skeleton only (`apps/api`, one `/health` endpoint).
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

Open items from reviews that must be closed before production: F2 (load
balancer rate limiting), F3 (retention), F5 (persistent email outbox).

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

## Application secrets

| Secret | Purpose | If lost | If leaked |
|---|---|---|---|
| `TOTP_ENCRYPTION_KEY` | Encrypts 2FA secrets | Every account must re-enrol 2FA | With a copy of the database, an attacker could generate 2FA codes. Rotate the key and require re-enrolment |

Locally in `apps/api/.env` (git-ignored). In production from the secret manager,
never from a file in the image.

## Files Git never tracks

`.gitignore` excludes environment files (except `.env.example`), keys and
certificates, uploads, local storage, database dumps and logs.
See [.gitignore](../.gitignore).
