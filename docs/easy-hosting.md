# Host Stass on one Linux server

This release runs the Next.js app, NestJS API, PostgreSQL, private file storage, antivirus scanner and HTTPS proxy together with Docker Compose. The hosted database and keys are separate from the local demo. No demo account or local email inbox is included in the production images.

## What you need

- A Linux server with Docker Engine, Docker Compose v2 and Git installed. Start with at least 4 CPU cores, 8 GB RAM and enough persistent disk for documents and database growth; measure capacity against your actual workload.
- A domain or subdomain whose DNS points to the server. Open inbound TCP ports 80 and 443. Keep administration/SSH access limited to the people who manage the server.
- An SMTP service with a verified sender address. Obtain its SMTP URL and credentials. `smtps://` uses implicit TLS; `smtp://` requires the provider to support STARTTLS. Percent-encode special characters in the username/password when constructing the URL.
- A backup destination and an operator responsible for testing recovery.

The Docker socket must be available to the server user running these commands. A desktop-only Node installation is not needed on the server: the setup wizard itself runs inside a Node container.

## First installation

Upload the prepared `stass-hosting-release.tar.gz` archive to your server, then:

```sh
mkdir -p ~/stass
tar -xzf stass-hosting-release.tar.gz -C ~/stass
cd ~/stass
sh host.sh
```

Alternatively, use a Git checkout that already contains these release changes. The archive includes the current source and hosting files, so it does not depend on unpublished local changes being present on GitHub. Create a fresh archive with `node scripts/package-hosting.mjs` after a reviewed source change.

The wizard asks for the public domain, administrator email/name, SMTP URL and verified sender email. It creates the ignored `.env.hosting` file with independent random passwords and encryption keys. SMTP input is hidden while typing. The startup command then builds the release images, prepares private-service certificates, starts PostgreSQL, applies all migrations and sends the first staff invitation.

The first scanner startup can take several minutes. On completion, open `https://your-domain` and accept the administrator invitation from your real email inbox. Set a password, enrol an authenticator and save your backup codes.

The initial account has Administrator, Partner and Compliance roles so that account administration and initial practice configuration can begin. Create separate appropriate staff accounts for routine work and independent approvals. Configure firm policies, compliance controls and bank/HR records through the application before ordinary work begins.

## Everyday commands

```sh
sh host.sh status     # Service state
sh host.sh verify     # Verify database, storage, scanner and SMTP connections
sh host.sh logs       # Recent application/service logs
sh host.sh stop       # Stop services and retain their data
sh host.sh up         # Start or rebuild the current checkout
sh host.sh restart    # Restart existing containers
```

To invite another staff member from the server:

```sh
sh host.sh invite --kind staff --email colleague@yourfirm.com --name "Colleague Name" --role fee_earner
```

An existing invited account can receive a replacement invitation using that command without changing its roles. Active and disabled accounts are not overwritten. The bootstrap invitation is only created when no staff account exists; restarting the server does not recreate users or reset passwords.

## Update an installation

1. Take a verified backup/snapshot as described below and review the release/migration notes.
2. Fetch the reviewed release with Git, or extract its source archive into the existing installation directory while preserving `.env.hosting` and the named data volumes.
3. Run `sh host.sh update`.
4. Check `sh host.sh status`, sign in and verify an invitation, document upload and the workflows you use.

Updates use the existing `.env.hosting` and Docker volumes. Preserve them. Migrations run before the new API starts and are forward only. A database backup from before an update is not automatically compatible with a later application or privacy-disposal state; follow the restoration runbook.

## What is automated

| Part | Behaviour |
| --- | --- |
| Public HTTPS | Caddy obtains and renews certificates for the configured public domain when DNS and ports 80/443 are correct |
| API routing | `/api/*` goes directly to the API; large uploads avoid Next.js request buffering |
| Upload limits | 52 MB on supported multipart upload routes; 1 MB on other public requests |
| Private services | Database, storage and scanner have no published host ports |
| Internal database/storage TLS | A private CA and service certificates are generated once; clients verify certificates and PostgreSQL uses `sslmode=verify-full` |
| Migrations | All pending migrations must succeed before the API starts |
| Startup | Health and completion checks order the application, database and scanner |
| Credentials | Independent random database, storage and encryption secrets are generated locally |
| Persistence | Named volumes retain database, files, scan definitions and certificates |
| Security-data cleanup | The existing retention CLI runs daily for expired sessions, old failures, closed reset/invitation records and cleared email queue entries; AML/HR disposal remains explicit |

Automatic public certificates require a domain and reachable server. They are not a substitute for configuring DNS, SMTP or backups. Internal service certificates are checked during the TLS preparation step; when renewing them, restart the private services so they load the new certificate files. Keep the private CA volume and all encryption keys with the recovery material.

## Backups and recovery

Before using real records, configure encrypted off-server backups of:

- The PostgreSQL database, using a consistent logical backup or a properly managed physical backup.
- The private document-storage volume, coordinated with the database snapshot.
- `.env.hosting`, which contains the encryption keys and service passwords.
- The private CA/certificate volumes and the public proxy's certificate state.

The standard Compose project uses named volumes beginning with `stass-hosting_`. `docker volume ls` shows their exact names. Do not use `docker compose down -v` on a live installation: it deletes the volumes. A server snapshot alone is not an off-server backup.

Use the detailed [disaster recovery procedure](disaster-recovery.md), including its disposal-tombstone replay requirements. Restore into a separate environment and test the whole workflow before relying on the backups. This release packages hosting; backup storage and scheduled backups still need to be configured by the host operator.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Website cannot obtain HTTPS | Domain DNS, inbound 80/443, another service already using those ports |
| Administrator email missing | SMTP credentials, verified sender, provider delivery restrictions, spam folder and API logs |
| Scanner still starting | First-time definition downloads and available RAM; check `clamav` logs |
| Migration failed | Read the `migrate` service logs; preserve the database and settings while diagnosing |
| Database or storage TLS error | Preserve the matching CA/certificate volumes, check file ownership and certificate expiry |
| Docker network collision | This stack reserves `172.29.43.0/24`; select another private subnet and update the proxy address and `TRUSTED_PROXIES` together if that range is already in use |

This configuration assumes Caddy is the public entry point. If another load balancer or CDN is added, review proxy trust and client-address forwarding before putting it in front of the application.

## Local release verification

The development-only `compose.hosting.smoke.yaml` adds an SMTP catcher with STARTTLS and private CA verification. It is not part of the production startup command. A test installation must use separate `.env.hosting.smoke` settings, project name `stass-hosting-smoke` and loopback ports 18080, 18443 and 18025. It must not reuse the production data volumes or credentials.

References: [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/) and [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
