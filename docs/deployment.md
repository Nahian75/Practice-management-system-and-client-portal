# Deployment

**Current state (2026-10-12):** Local development only: the API, the web app,
and the document storage and scanner containers. No hosted environments.

## Local development

Requirements: Node.js 24 LTS, Docker Desktop, gitleaks.

```sh
cp .env.example .env              # then fill every value with a random password
docker compose up -d              # PostgreSQL 18 on 127.0.0.1:5432, Mailpit on 127.0.0.1:1025 / :8025,
                                  # SeaweedFS (documents) on :8333, ClamAV on :3310 (first start: a few minutes)
cp apps/api/.env.example apps/api/.env    # then fill the database URLs and the distinct TOTP, MAIL, FINANCE, AML, SUSPICION, HR and DOCUMENT encryption keys
                                          # and the storage key pair from .env; mail and scanner settings work as given
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

### The way in: a reverse proxy on the same machine (reviews W1, W3, D2)

The web app and the API both listen on `127.0.0.1` only (`npm run start`
binds the web app there; a test fails if it does not). Browsers reach them only
through a TLS reverse proxy on the same machine, such as Caddy or nginx, on one
address, so the session cookie and the API's cross-site check work as they do
locally. The reverse proxy must:

- **Send `/api/…` straight to the API, without the `/api` prefix, and
  everything else to the web app.** In production the web app's own `/api`
  pass-through is not used: Next.js reads and keeps in memory the whole body
  of every request it passes on, before it can refuse it (review D2). The
  pass-through remains for development and the end-to-end tests.
- **Limit request bodies before reading them:** 52 MB on document, CDD-evidence
  restricted-report and HR-file multipart upload routes
  (`POST /api/matters/{id}/documents`, `POST /api/documents/{id}/versions`,
  `POST /api/clients/{id}/cdd/{id}/evidence`, `POST /api/compliance/restricted-reports`,
  `POST /api/hr/people/{id}/files`),
  1 MB on every other address; and limit connections per client.
- **Pass the browser's address last in `X-Forwarded-For`.** The API
  (`TRUSTED_PROXIES=loopback`) takes the last address that is not loopback;
  whatever the browser wrote itself comes earlier and is ignored. Caddy does
  this by default; nginx as below.
- **Pass the `Host` header unchanged**, so the API's cross-site check can
  compare it with `Origin`.

An example for nginx, to be checked when hosting is chosen (TLS settings left out):

```nginx
limit_conn_zone $binary_remote_addr zone=per_client:10m;

server {
  # TLS on 443, certificates: per the hosting chosen.
  limit_conn per_client 20;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto https;

  # Document uploads: up to 52 MB, streamed on as they arrive.
  location ~ ^/api/(matters/[^/]+/documents|documents/[^/]+/versions|clients/[^/]+/cdd/[^/]+/evidence|compliance/restricted-reports|hr/people/[^/]+/files)$ {
    client_max_body_size 52m;
    proxy_request_buffering off;
    rewrite ^/api/(.*)$ /$1 break;
    proxy_pass http://127.0.0.1:3001;
  }

  # Every other API request: up to 1 MB.
  location /api/ {
    client_max_body_size 1m;
    proxy_pass http://127.0.0.1:3001/;
  }

  # The web app's pages.
  location / {
    client_max_body_size 1m;
    proxy_pass http://127.0.0.1:3000;
  }
}
```

Never expose the web app's or the API's port directly: anyone reaching them
could choose the address the API records for them, and get round the
per-address sign-in limit. Because the web app no longer passes API requests
in production, the `x-middleware-rewrite` header that named the API's
internal address (review W3) does not appear there either.

`compose.yaml`:
- Image pinned by digest, so the exact same image is pulled every time.
- Port bound to `127.0.0.1` only: not reachable from other machines.
- Passwords come from the git-ignored `.env`. Compose refuses to start if any is missing.
- `no-new-privileges` stops processes in the container gaining extra privileges.
- `infra/postgres/init/01-roles.sh` creates the roles once, when the data
  volume is first created. To rebuild from scratch: `docker compose down -v`
  (deletes all local data).

Local data is synthetic only. Never load production data into a local database.

### Compliance disposal and backups

Retention disposal removes live AML database content and the exact ordinary
and restricted object keys in one locked operation, leaving content-free
tombstones. Before production, the hosting decision must also set finite backup
expiry and a restoration procedure that reapplies completed disposals after a
backup restore. A backup is not a route to resume ordinary use of disposed
personal data. Test the procedure and record the result before enabling a live
disposal job; the current first version runs disposal only from an explicit
Compliance screen after typed confirmation.

## Hosted environments

Not yet decided. See the open questions in [disaster-recovery.md](disaster-recovery.md).
