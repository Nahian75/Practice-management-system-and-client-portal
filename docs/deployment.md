# Deployment

**Current state (2026-10-05):** Local development only: the API and the web app. No hosted environments.

## Local development

Requirements: Node.js 24 LTS, Docker Desktop, gitleaks.

```sh
cp .env.example .env              # then fill every value with a random password
docker compose up -d              # PostgreSQL 18 on 127.0.0.1:5432, Mailpit on 127.0.0.1:1025 / :8025
cp apps/api/.env.example apps/api/.env    # then fill the database URLs and TOTP_ENCRYPTION_KEY; mail settings work as given
npm ci
npm run build -w @practice/api
npm run migrate:local -w @practice/api
npm run build -w @practice/api && npm run invite:local -w @practice/api -- --kind staff --email you@practice.test --name "Your Name" --role administrator
# then open the invitation email in Mailpit: http://127.0.0.1:8025
npm run start:local -w @practice/api      # the API, on the private port 3001

cp apps/web/.env.example apps/web/.env.local
npm run dev -w @practice/web              # the web app: open http://localhost:3000
```

Browsers only ever talk to the web app on port 3000; it passes `/api/...` to
the API on 3001 ([web.md](web.md)). Open the invitation email in Mailpit and
follow its link to choose a password and set up the authenticator app, then
sign in at http://localhost:3000.

**Extensions, once per database.** `pg_trgm` and `unaccent` need the
superuser, which the migration role deliberately is not. New data volumes get
them from `infra/postgres/init/02-extensions.sh`. For a database created
before that file existed, run it once:

```sh
docker compose exec -T postgres sh /docker-entrypoint-initdb.d/02-extensions.sh
# In Git Bash on Windows, prefix with MSYS_NO_PATHCONV=1 so the path is not rewritten.
```

Migration `0017` stops with a clear message if they are missing.

Behind a load balancer, set `TRUSTED_PROXIES` to its address range. Leave it
empty when the app is reached directly.

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
