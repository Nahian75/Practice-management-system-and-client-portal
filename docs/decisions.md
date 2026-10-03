# Architecture Decision Records

Each decision records what was chosen, why, and what it costs us.
Decisions are never deleted. A reversed decision gets a new record that supersedes it.

---

## ADR-001: Modular monolith

**Date:** 2026-10-03
**Status:** Accepted

**Decision:** Build one backend application split into domain modules
(Auth, Users/Roles, Clients, Matters, Documents, Tasks, Finance, Compliance,
HR, Audit, Notifications, AI). No microservices at the start.

**Why:**
- Authorization, audit and finance span several domains. Keeping them in one
  process and one database lets us use database transactions instead of
  distributed consistency.
- One authentication and authorization implementation to secure and test.
- A small team can operate one deployable unit.

**Rules that keep the boundaries real:**
- A module owns its tables. Other modules do not query them directly.
- Modules talk only through each other's exported services.

**Cost:** Scaling is per application, not per domain. Acceptable at law-firm scale.

---

## ADR-002: Technology stack

**Date:** 2026-10-03
**Status:** Superseded by ADR-003

| Layer | Choice |
|---|---|
| Staff app and client portal | Next.js (TypeScript) |
| Core API | NestJS (TypeScript) |
| Database | PostgreSQL |
| AI / document processing | FastAPI (Python), deferred until the AI module |

**Why:**
- TypeScript end to end for the core system: one language, shared types,
  one toolchain to lint and scan.
- NestJS gives modules, dependency injection, guards and pipes, which map
  directly onto our controller → service → repository rule and our
  per-route authorization checks.

**FastAPI constraints:**
- Not exposed to the internet. Only the NestJS API may call it.
- Calls are authenticated service to service.
- No direct database access. It receives only the data a request needs and
  returns a result. NestJS stays the single owner of data and authorization.
- AI output is stored as a draft until an authorized human approves it.

**Next.js constraints:**
- Next.js renders UI only. All business logic, data access and
  authorization live in NestJS. Hiding something in the UI is never a
  security control.

**Cost:** Two backend languages once FastAPI arrives, which means two
dependency ecosystems to scan. This is why FastAPI is deferred until needed.

**Runtime:** Node.js must be an LTS line that is still supported.
Node 20 reached end of life in April 2026 and must not be used.

---

## ADR-003: Python backend with Django

**Date:** 2026-10-03
**Status:** Superseded by ADR-004

| Layer | Choice |
|---|---|
| Backend and API | Python 3.12, Django 5.2 LTS, Django REST Framework |
| Database | PostgreSQL |
| Staff app and client portal | Next.js (TypeScript), UI only |

**Why:**
- The developer reviewing every change reads Python. Code that cannot be
  reviewed cannot be trusted, which outweighs any framework advantage.
- Django ships the security controls this system needs instead of us
  assembling them: password hashing, sessions, CSRF protection, an ORM that
  parameterises queries, migrations, permissions, and deployment checks
  (`manage.py check --deploy`).
- Django 5.2 is a long-term support release with security fixes until
  April 2028.

**Rejected:**
- NestJS and Go: sound choices, but in a language the reviewer does not yet read.
- FastAPI: authentication, sessions, CSRF and permissions would be assembled
  by hand, giving a learning team more places to make security mistakes.

**Constraints:**
- Django is the only component that reads or writes data and the only place
  authorization is decided. Next.js renders UI and never holds business rules.
- Python 3.12 is in its security-fix-only phase, and python.org publishes no
  Windows installers for those releases. The backend therefore runs in the
  official `python:3.12` container image, which receives the security
  releases. A host Python install is not relied on for patches.
- Python 3.12 reaches end of life in October 2028. The upgrade is planned
  before then.

**Cost:** Two languages (Python and TypeScript). Kept small by keeping all
logic in Python.

---

## ADR-004: Return to TypeScript with Next.js and NestJS

**Date:** 2026-10-03
**Status:** Accepted. Supersedes ADR-003.

| Layer | Choice |
|---|---|
| Backend and API | NestJS (TypeScript), Node.js 24 LTS |
| Database | PostgreSQL |
| Staff app and client portal | Next.js (TypeScript), UI only |

**Why:** The project owner chose to learn TypeScript and keep one language
across frontend and backend. NestJS modules, guards and pipes map directly
onto our layering and per-route authorization rules.

**FastAPI:** Not planned. Added only if a Python-only need appears (for
example OCR or custom ML), under the constraints recorded in ADR-002.

**Risk:** The reviewer is learning TypeScript while reviewing it.
Mitigations:
- TypeScript in strict mode, so the compiler rejects loose or ambiguous code.
- Small changes, each explained before it is committed.
- Every security-sensitive change ships with tests that show the rule
  holding and the attack failing.

**Runtime:** Node.js 24 LTS. Node 20 reached end of life in April 2026.
Local PostgreSQL runs in Docker with synthetic data only.

---

## ADR-005: Kysely with plain SQL migrations

**Date:** 2026-10-03
**Status:** Accepted

**Decision:** The API talks to PostgreSQL through Kysely, a type-safe query
builder, using the `pg` driver. Schema changes are plain `.sql` migration files.

**Why:**
- Kysely queries read almost exactly like the SQL they produce, so a reviewer
  sees what will run. No hidden query generation.
- Zero dependencies.
- Database-level protections we rely on (privileges, row-level security,
  append-only audit tables, ledger constraints) are SQL features. Plain SQL
  migrations express them directly instead of through a generator.

**Rejected:**
- Prisma: largest dependency footprint, a separate schema language and a
  code-generation step; database security features end up as raw SQL anyway.
- Drizzle: good option, but generated migrations still need line-by-line
  review and the generator adds dependencies.

**Cost:** Table types are written by hand and must be kept in step with the
migrations. Tests against a real database catch drift.

---

## ADR-006: PostgreSQL 18 with separate owner and app roles

**Date:** 2026-10-03
**Status:** Accepted

**Decision:** PostgreSQL 18. Two login roles:

| Role | Used by | Can |
|---|---|---|
| `pms_owner` | Migrations only | Create and alter tables in schema `app` |
| `pms_app` | The running API | `SELECT` and `INSERT` by default. `UPDATE` and `DELETE` only where a migration grants them |

**Why:** If the API is compromised, the attacker holds `pms_app`, which cannot
drop tables, change the schema, create roles, read server files, or rewrite
history in tables that were never granted `UPDATE`/`DELETE` (audit log, posted
ledger entries).

**PostgreSQL 19** is in beta and not used.

---

## ADR-007: Server-side sessions, Argon2id, TOTP

**Date:** 2026-10-03
**Status:** Accepted

**Sessions, not JWT.** A session row in PostgreSQL can be ended instantly
(sign-out, password change, a suspected compromise). A signed JWT stays valid
until it expires, and revoking it needs a deny-list, which is a session table
by another name. Sessions also mean there is no signing key to leak.

**Argon2id from `node:crypto`.** Node.js 24 ships Argon2id, the algorithm
OWASP recommends. No third-party native module, so nothing to compile and no
supply-chain risk for the most sensitive code path.

**TOTP and backup codes for 2FA.** Works with any authenticator app, needs no
SMS provider (SMS codes can be stolen by SIM-swap). TOTP is implemented with
`node:crypto` HMAC, about 30 lines, tested against the RFC 6238 test vectors.
Passkeys are stronger and are planned as an addition, not a replacement.

**Cost:** Session lookups hit the database on every request. Fine at
law-firm scale; an index on the token hash keeps it fast.

---

## ADR-008: Email over SMTP with nodemailer; Mailpit locally

**Date:** 2026-10-04
**Status:** Accepted

**Decision:** The API sends plain-text email over SMTP using nodemailer.
Locally all mail goes to Mailpit, a mail catcher in Docker. The production
provider is not chosen yet; any provider that offers SMTP works.

**Why SMTP:** every candidate provider (Microsoft 365, Amazon SES, SendGrid,
Postmark) supports it, so the provider can be chosen later without code changes.

**Why nodemailer:** SMTP with TLS, authentication and correct encoding is easy
to get subtly wrong. nodemailer is the standard Node.js library: zero
dependencies, signed build provenance.

**7-day rule exception:** every nodemailer version old enough for the rule
(≤ 10.0.12) has 5 published advisories, including two pre-authentication
denial-of-service flaws. 10.0.13 fixes all of them but was 4 days old. The
project owner approved an exception for nodemailer 10.0.13 only, recorded in
`dependency-age-exceptions.json` with an expiry of 2026-10-07. The age check
fails once an exception expires, so it cannot quietly become permanent.

**Plain text only:** no HTML email, so nothing in a message can be rendered as
markup or carry tracking pixels.
