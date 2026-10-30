# Recovery runbook

Status: local backup/restore tooling is implemented. Production backups, replication,
immutable storage, actual recovery times and officer sign-off need provider evidence.
Previous statements that these were already deployed were design intentions.

## Before live records

- [ ] Assign recovery owner/deputy; approve RPO/RTO targets. Suggested starting
  targets are 15 minutes and four hours, subject to a real provider drill.
- [ ] Enable encrypted backups and point-in-time recovery. Record retention,
  region, encryption-key recovery and independent access controls.
- [ ] Back up private objects and every required application key version.
  Database backups alone cannot recover documents or keys.
- [ ] Configure independent signed audit/disposal checkpoints following
  [security operations](security-operations.md); alert on failed/missed runs.
- [ ] Perform a provider restore drill and record actual recovery timestamp,
  elapsed time, object integrity, disposal review and named approval.

## Local regression drill

With local services running and API tests having populated pms_test, run
`node scripts/restore-drill.mjs`. It only accepts a loopback pms_test source,
exports a consistent snapshot, encrypts a logical dump with AES-256-GCM, restores
into a randomly named scratch database, compares every application table's count
and content hash, then removes that scratch database. Evidence is in
logs/restore-drill/evidence.json. Its temporary key is not retained: this is a
regression exercise, not a usable production backup or proof of production RPO.

## Production recovery

1. Declare an incident, preserve evidence and isolate the affected deployment.
   Prepare a quarantined restore target with traffic, mail, payments, workers and
   outbound integrations disabled. Preserve the last good copy.
2. Use the provider's supported PITR/restore procedure and recorded identifiers.
   For self-managed physical PostgreSQL recovery, restore_command and recovery
   targets belong in PostgreSQL configuration. recovery.signal is an EMPTY marker
   file. Logical pg_dump backups instead use pg_restore. Follow the installed
   [PostgreSQL documentation](https://www.postgresql.org/docs/current/continuous-archiving.html).
3. Restore matching code and all required key versions. Verify integrity and the
   recovery timestamp before applying reviewed migrations. Restore private objects
   and check decryption, object versions and access policies.
4. Obtain the latest independently signed disposal journal and offline public key.
   Run `node infra/hosting/verify-restored-disposals.mjs checkpoint.json` with
   RESTORE_DATABASE_URL, AUDIT_VERIFY_KEY_PEM and AUDIT_DEPLOYMENT_ID supplied
   securely. Failure, stale journals, unknown categories or resurrected identifiers
   require continued quarantine.
5. This verifier DETECTS known resurrected rows; it does not replay disposals.
   The compliance officer must establish journal completeness through the incident,
   review post-checkpoint disposals and approve category-specific row/object removal.
   retention:sweep checks current eligibility; it does NOT replay historical disposal.
   Where replay is needed, prepare a reviewed incident-specific transaction and
   object-removal plan, preserving only approved content-free tombstones. Do not
   enable traffic until completeness and removal are independently verified.
6. Verify accounts, revoked sessions, permissions, audit continuity, balances,
   document hashes and integrations using synthetic records. Private API liveness
   is /health; readiness is /ready. Public proxy paths are /api/health and /api/ready.
7. Recovery owner and compliance officer record evidence and approve release.
   Re-enable traffic/integrations gradually and monitor. Rotate compromised secrets
   without losing decryption keys needed for retained records and backups.

Repeat the provider drill at least every six months and after material changes.
A green local drill does not prove production RPO/RTO or disposal completeness.
