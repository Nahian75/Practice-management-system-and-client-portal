# Disaster Recovery

**Current state (2026-10-03):** Not designed. No hosted environment exists.

## Agreed direction

- Managed PostgreSQL with a standby replica in a second availability zone and
  automatic failover.
- Point-in-time recovery, daily snapshots, and immutable backups in a second
  location.
- Scheduled test restores into an isolated environment.

## Open questions for the firm

- RPO: the maximum acceptable data loss.
- RTO: the maximum acceptable downtime.
- Cloud provider (Azure has two UK regions; AWS has one, so a second copy
  would sit in Ireland).
