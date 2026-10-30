# Security operations and release boundaries

## Current release scope

Deploy one isolated stack per firm: separate database, storage, keys, credentials,
hostname, mail configuration and audit deployment identifier. The current schema
is not shared multi-tenant SaaS. Do not mix firms in one database or advertise RLS.
Staff/client permissions apply within one firm. Shared SaaS needs a separate design
and cross-tenant testing before accepting multiple firms in one deployment.

The calendar supports personal events, listing and cancellation. It does not reserve
exclusive rooms/practitioners or support recurring bookings. Telehealth is outside
this legal-practice release; camera/microphone permissions remain disabled.

## Versioned keys

Existing data remains version 1. Keys are not changed automatically. Keep backups
of every required key version separately from application credentials.

On managed hosting retain CLOUD_ROOT_KEY permanently: changing it also changes
database passwords and loses the original derived keys. Increase
ENCRYPTION_KEY_VERSION only after testing old-data reads and recovery on an isolated
copy. Versions 1 through the previous version remain available. Set the same version
on the API and cleanup worker. Older application code may not read newer versions.

For manual hosting set ENCRYPTION_KEY_VERSION=N, supply independent 32-byte base64
current keys for TOTP, MAIL, FINANCE, AML, SUSPICION, HR and DOCUMENT, and set
PREVIOUS_ENCRYPTION_KEYS to JSON shaped like
`{"DOCUMENT":{"1":"<old key>"},"TOTP":{"1":"<old key>"},...}` for every purpose.
Supply secrets through a secret manager, never source control or shell arguments.
Retain all required versions; original finance keys also preserve account fingerprints.
New writes use the current version. This does not bulk re-encrypt existing data.
Retirement requires a reviewed migration, complete ciphertext inventory and backup
retention review. Never delete old keys merely because rotation succeeded.

## Independent audit checkpoints

The runtime cannot alter existing audit rows, but a database administrator can.
Run the checkpoint job from an independent environment with a separate signing key
and AWS/IAM boundary. Never give checkpoint credentials to the API.

Create a reader using infra/hosting/audit-reader.sql with a securely supplied psql
audit_reader_password variable. Generate an Ed25519 key in the operator secret
manager; retain its public verification key offline. Create a private S3 bucket with
Object Lock, versioning and KMS. Review the configured 365-day COMPLIANCE retention
with the records owner before initialization. Grant List/Get/Put, lock inspection,
retention write and KMS permissions; deny deletion and retention bypass.

Supply AUDIT_DEPLOYMENT_ID, AUDIT_DATABASE_URL (verify-full), AUDIT_SIGNING_KEY_PEM,
AUDIT_S3_BUCKET, AUDIT_S3_REGION, AUDIT_S3_ACCESS_KEY, AUDIT_S3_SECRET_KEY and
AUDIT_S3_KMS_KEY_ID securely. Run `node infra/hosting/audit-checkpoint.mjs`.
Only the first approved run uses AUDIT_INITIALIZE=1; remove it afterwards. Schedule
non-overlapping runs every 15 minutes and alert on failures or missed runs.
Each signed manifest compares all previously observed audit hashes and disposal IDs.
Manifests contain identifiers/hashes rather than event content and need private access.
The initial trusted snapshot and time between checkpoints remain limitations.

## Availability and abuse

API instances share database-backed IP/account limits. Keep the API private behind
the supplied proxy; restrict trusted proxies. Configure provider WAF/CDN and DDoS
defense. Liveness is /health; /ready checks database, bucket and scanner. Scanner
definitions older than 48 hours reject uploads. Update continuously and alert before
expiry; scanner freshness is cached briefly.

Server-rendered API requests preserve the validated forwarding chain from the edge.
The Compose API trusts only the fixed edge and web addresses; the web server must
not be exposed directly. The edge replaces client-supplied forwarding headers.
Do not remove that boundary or broadly trust internet sources. Rate-limited or
failed server reads show a safe retry page instead of empty record lists/sign-out.

## Production handoff

For multiple app replicas, use the [AWS scaling runbook](../infra/aws/README.md).
All replicas must share the database, bucket and encryption key versions. Use
direct/session-persistent PostgreSQL connections for scheduled-job advisory locks.
Set DATABASE_POOL_MAX, DATABASE_REPLICA_LIMIT (including deployment surge),
DATABASE_CONNECTION_BUDGET and DATABASE_RESERVED_CONNECTIONS together. The API
rejects insufficient configured/server/role capacity at startup.

Authenticated staff share a bounded network budget of 12,000 requests/minute/IP
and retain 300/minute/account limits. Anonymous requests retain 600/minute/IP,
authentication POSTs 600/minute/IP and recovery 20/ten minutes/IP. Failed-login
controls remain separate. Keep edge protection; these are application quotas,
not a promise that every allowed request can be served at production latency.

Apply migrations once before enabling a service release. Sanctions refresh and
rescreen scheduling use durable due times and exclusive database session locks;
worker death releases ownership when PostgreSQL detects disconnection. Monitor
freshness, retries and database connectivity. Readiness becomes unavailable during
shutdown, allowing a load balancer to drain the instance.

- [ ] Run GitHub security checks successfully and require them in branch protection.
  Committed CodeQL, Trivy, dependency/secret scans, SBOM and provenance jobs are not
  evidence that CI has passed.
- [ ] Run the Linux passive DAST wrapper on synthetic browser journeys and review
  every medium alert. It uses pinned ZAP, observes authenticated browser traffic and
  does not launch active attacks. It does not cover every endpoint or replace an
  independent penetration test. See [ZAP documentation](https://www.zaproxy.org/docs/docker/baseline-scan/).
- [ ] Configure real SMTP/sender DNS, TLS, private storage/KMS, scanner updates,
  backup/PITR, independent checkpoints, alerts and emergency contacts.
- [ ] Complete provider contracts, data-location/privacy/retention decisions and
  legal review. Code cannot certify GDPR/HIPAA/SRA compliance or vendor contracts.
- [ ] Commission an independent staging permission/IDOR/upload/API security test;
  resolve high risks and record named release-owner approval.

Current password policy is 12-128 characters plus mandatory MFA and breached-password
checks. A 15-character baseline is a policy decision, not automatic compliance.
Administrators do not need to know user passwords; use invitation/reset and defined
MFA recovery procedures.
