# Stass Practice Management System

Stass is a security-focused practice management system and client portal for legal work in England and Wales. It brings client and matter management, documents, tasks, finance, compliance, HR, and controlled AI-assisted drafting into one role-aware workspace.

> **Project status:** local development and evaluation. The repository includes production architecture and deployment guidance, but no hosted production environment is provided.

Current verification: [security fixes and remaining production requirements](docs/reviews/2026-10-30-security-remediation.md).

Latest cleanup verification (31 October 2026): both builds and type checks passed, along with 101 browser tests, 47 focused AI tests and 10 script tests. The full API run had 2,094 passing and 44 failing tests; the hidden-character check also reports an existing documentation BOM. See the [cleanup review](docs/reviews/2026-10-31-code-cleanup.md) for changes, failures and verification limits.

The supplied Clio, LEAP and Reglify scope is tracked in the [192-item integration checklist](docs/requirements/combined-feature-checklist.md), with an [implementation learning guide](docs/requirements/implementation-learning-guide.md). This deployment is for one client law firm; external provider choices remain open. The checklist records incomplete work explicitly and is not a claim of complete feature parity.

## What it includes

- Client onboarding, contacts, conflict checks, engagement documents, and matter activation gates
- Matter teams, tasks, notifications, documents, versioning, and client sharing
- Separate client portal with evidence requests, engagement signing, payment requests, and shared matter records
- Time recording, matter expenses and disbursements, billing, client-money controls, payment approvals, statement imports, and reconciliation
- AML, sanctions screening, compliance holds, restricted reports, retention, and audited exports
- Personnel records, leave, lifecycle checks, competence records, confidential cases, and HR retention
- Provider-neutral AI drafting tools with redaction, matter isolation, citation checks, budgets, audit, and human approval
- Password and two-factor authentication, granular permissions, encrypted sensitive fields, immutable history, and audit trails

## Architecture

```text
Staff browser  ─┐
                ├──> Next.js web app ──> NestJS API ──> PostgreSQL
Client browser ─┘                             │
                                              ├──> S3-compatible document storage
                                              ├──> ClamAV
                                              └──> SMTP
```

The browser only talks to the Next.js application. The NestJS API owns business rules, authorization, and persistence. PostgreSQL and supporting services remain private.

| Area | Technology |
|---|---|
| Web application | Next.js 16, React 19, TypeScript |
| API | NestJS 12, TypeScript, Zod |
| Data access | PostgreSQL 18, Kysely |
| Documents | S3-compatible SeaweedFS, envelope encryption, ClamAV |
| Email development | Mailpit |
| Tests | Vitest, Playwright, axe-core |

See [Architecture](docs/architecture.md), [Security](docs/security.md), and [Data model](docs/data-model.md) for the detailed design.

The staff prototype now follows a Clio Manage-inspired workspace structure. See the [design and feature comparison](docs/clio-manage-design-and-features.md) for implemented workflows, current limits and remaining gaps.

## Requirements

- Node.js 24
- npm
- Docker Desktop with Docker Compose
- Chromium for browser tests (`npx playwright install chromium`)
- Windows for the included `start.bat` and `stop.bat` convenience scripts

## Local setup

For managed hosting, use the [Render deployment guide](docs/render-hosting.md) and root `render.yaml`. For a Linux server, use the [single-server hosting guide](docs/easy-hosting.md) and `sh host.sh`. The Windows scripts below are for local development.

1. Clone and install dependencies.

   ```powershell
   git clone https://github.com/Nahian75/Practice-management-system-and-client-portal.git
   cd Practice-management-system-and-client-portal
   npm ci
   ```

2. Generate the three local environment files with separate random passwords and encryption keys.

   ```powershell
   npm.cmd run setup:local
   ```

   This leaves existing configuration unchanged and refuses to replace keys in a partially configured installation. The generated files are ignored by Git. Keep them for future starts: the database and encrypted records depend on the same passwords and keys.

   For manual configuration instead, copy the templates:

   ```powershell
   Copy-Item .env.example .env
   Copy-Item apps/api/.env.example apps/api/.env
   Copy-Item apps/web/.env.example apps/web/.env.local
   ```

3. If you copied the templates manually, fill every required value. Use different random values for every password and encryption key. The comments in each example file include generation commands and explain which values must match. The setup command above fills these values automatically for local use.

4. Start the application.

   ```powershell
   .\start.bat
   ```

   The first ClamAV start can take several minutes while virus definitions are downloaded.

5. Create the first administrator if the database is new.

   ```powershell
   npm run invite:local -w @practice/api -- --kind staff --email you@example.com --name "Your Name" --role administrator --role partner
   ```

   Open Mailpit, follow the invitation link, choose a password, and enroll an authenticator.

| Local service | Address |
|---|---|
| Application | http://localhost:3000 |
| Mailpit | http://127.0.0.1:8025 |
| API health | http://127.0.0.1:3001/health |

Stop the local application without deleting its data:

```powershell
.\stop.bat
```

For manual or non-Windows startup, follow [Deployment: Local development](docs/deployment.md#local-development).

## Demo credentials

Credentials are never stored in Git. A locally prepared demo may create an ignored `DEMO-LOGIN.txt` file containing test-only access details. Do not commit that file or use real client information in a demo environment.

## Development commands

```powershell
# API
npm run typecheck -w @practice/api
npm run build -w @practice/api
npm test -w @practice/api

# Web
npm run typecheck -w @practice/web
npm run build -w @practice/web
npm run test:e2e -w @practice/web

# Repository safeguards
npm run check:hidden-characters
npm run check:dependency-age
npm run check:production-hygiene
```

The end-to-end suite builds both applications, recreates an isolated `pms_e2e` database, and runs Chromium against dedicated test ports. More details are in [Testing](docs/testing.md).

## Documentation

- [System manual (PDF)](docs/Stass_Practice_Management_System_Manual.pdf)
- [API](docs/api.md)
- [Database design](docs/database-design.md) and [interactive schema explorer](docs/database-design.html)
- [Authentication](docs/authentication.md) and [authorization](docs/authorization.md)
- [Client portal](docs/portal.md)
- [Documents and document security](docs/documents.md)
- [Finance](docs/finance.md)
- [Compliance and AML](docs/compliance.md)
- [HR](docs/hr.md)
- [AI module](docs/ai.md) and [AI security](docs/ai-security.md)
- [Deployment](docs/deployment.md) and [disaster recovery](docs/disaster-recovery.md)
- [AWS horizontal and vertical scaling setup](infra/aws/README.md) and [local scaling validation](docs/reviews/2026-10-31-scalability-remediation.md)

## Security

This project treats authorization as an API responsibility and uses separate encryption domains for authentication, mail, finance, AML, restricted reports, HR, and documents. Local services bind to loopback, uploaded files are scanned before storage, and sensitive browser responses are not cached.

Before any real deployment, complete the hosting-specific controls in [Deployment](docs/deployment.md), run the production hygiene checks, validate backup restoration and disposal replay, configure TLS and a hardened reverse proxy, and obtain an independent security review.

## Data and privacy

Use synthetic data only in local development. Environment files, private keys, uploads, database dumps, browser traces, test screenshots, and `DEMO-LOGIN.txt` are excluded from version control.
