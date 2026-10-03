# Deployment

**Current state (2026-10-03):** Local development only. No hosted environments.

## Local development

Requirements: Node.js 24 LTS, Docker Desktop, gitleaks.

```sh
cp .env.example .env              # then fill every value with a random password
docker compose up -d              # PostgreSQL 18 on 127.0.0.1:5432
cp apps/api/.env.example apps/api/.env    # then fill the database URLs and TOTP_ENCRYPTION_KEY
npm ci
npm run build -w @practice/api
npm run migrate:local -w @practice/api
npm run start:local -w @practice/api
```

`compose.yaml`:
- Image pinned by digest, so the exact same image is pulled every time.
- Port bound to `127.0.0.1` only: not reachable from other machines.
- Passwords come from the git-ignored `.env`. Compose refuses to start if any is missing.
- `no-new-privileges` stops processes in the container gaining extra privileges.
- `infra/postgres/init/01-roles.sh` creates the roles once, when the data
  volume is first created. To rebuild from scratch: `docker compose down -v`
  (deletes all local data).

Local data is synthetic only. Never load production data into a local database.

## Hosted environments

Not yet decided. See the open questions in [disaster-recovery.md](disaster-recovery.md).
