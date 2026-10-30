# Scalability remediation — 31 October 2026

The shared-office quota defect (LOAD-001) is fixed and verified locally. The
application can run multiple API processes against shared services, and an AWS
application scaling template is prepared. No AWS resources were provisioned.

## Changes

- Separate authenticated network, anonymous, authentication, recovery and account
  quotas in migration 0079. A valid, fully authenticated session is required for
  the office allowance; forged, pending and revoked cookies retain anonymous
  limits. The database enforces budgets across replicas atomically.
- Configurable connection pools and a startup capacity check include deployment
  surge, reserved connections, PostgreSQL capacity and the runtime role limit.
- Shutdown marks readiness unavailable. Platform draining and stop timeouts are
  configured separately in the AWS template.
- Migration 0080 records job due times and pending sanctions screenings durably.
  Reserved-session advisory locks coordinate refresh/rescreen workers. Another
  process can acquire ownership after a worker dies; unfinished subject screenings
  remain discoverable. Mail/reminder coordination retains existing database claims
  and deduplication. SMTP remains at least once.
- AWS ECS/Fargate template provides two warm tasks, bounded CPU/memory autoscaling,
  private networking, HTTPS ALB/WAF, separate runtime/migration credentials,
  readiness health checks, deployment rollback and alarms. CPU/memory can also be
  increased through validated task sizes. Private RDS/S3 and their recovery controls
  are prerequisites, not resources created by this template.

## Verification

- Full API regression: **2,116 passed, zero failed**. A subsequently added reminder
  concurrency test passed in its focused five-test suite; API typecheck passed.
- Quota/configuration/readiness checks: 83 passed. Distributed worker checks:
  29 passed, including an actual worker-process death and subsequent lock takeover.
- AWS contract tests: two passed. CloudFormation lint, source security guard and
  production hygiene checks passed.
- Browser regression: **99 passed, zero failed/skipped/flaky**. Production API
  container built successfully; an isolated no-network container check verified
  the compiled scheduler and all 114 certificates in the public RDS CA bundle.
- Local preview migrations 0079/0080 are applied; the restarted API readiness and
  web sign-in endpoints both returned 200. Existing development data was retained.
- 100 real password + TOTP login journeys passed through two API instances.
- At 100 active users: 6,000 mixed requests over 60.74 seconds, **98.79 requests/sec,
  p95 70.8 ms**, with every expected response valid. A bounded 2,000-request burst
  reached 664.89 requests/sec, p95 194.2 ms; this is not sustained capacity.
- Draining/replacing one API during mixed traffic: 2,000 requests, no failed
  responses. Abrupt loss during read-only traffic: 1,200 requests, no failed
  responses with the local fixture's read retry behavior.
- 25 concurrent server-rendered dashboard callers: 150 responses, p95 1,081.8 ms.
  Twenty 1 MiB uploads passed malware scanning and encrypted storage; downloaded
  bytes matched SHA-256 hashes. Those profiles ran after one API was lost.
- Separate office probe: **700/700 valid responses, zero 429 or server errors**
  from 100 authenticated staff sharing one IP. Sessions were seeded for this probe;
  real password/MFA was measured separately. Another file was uploaded through
  API A and downloaded through API B with matching hash, verifying shared keys,
  sessions and object storage. Recovery abuse still returned 429 after 20 requests;
  another user's matter still returned 404.

Reviewed machine-readable evidence is in
[scaling evidence](2026-10-31-scalability-evidence.json). Raw diagnostics stay in
ignored logs. The [original load report](2026-10-31-local-load-test.md) preserves
the before-fix office quota failure.

## Deployment and remaining production gates

Use the [AWS runbook](../../infra/aws/README.md) for prerequisites, reviewed
parameters, capacity preflight and the migrate-then-enable procedure. The template
starts with service creation disabled. Run migrations once, never independently
on every replica. Apply expand/contract schema changes for mixed-version rollouts.

These short, closed-loop tests ran on one Ryzen 5 5600 / 31.9 GiB host with local
PostgreSQL/storage/scanner and synthetic data. They do not certify an AWS instance
size or indefinite capacity. The loopback fixture probes every 250 ms and retries
GET/HEAD once before headers; it never retries writes. AWS ALB health timing and
retry semantics differ and must be tested in staging.

- [ ] Provision and verify private RDS, PITR/restore, S3 permissions, shared keys,
  SMTP, scanner update access and operational alerts.
- [ ] Exercise real AWS scale-out, cold scanner startup, scale-in, instance/network
  failure and RDS Multi-AZ failover. Keep warm capacity for slow antivirus startup.
- [ ] Run a longer staging soak and representative billing/ledger/document/browser
  workloads over a real network; set measured service objectives and capacity.
- [ ] Verify mixed-version Next.js rollouts retain immutable old static assets, or
  use a tested version-routing/blue-green release procedure. Health checks alone
  do not prove open browsers survive a release.
- [ ] Complete independent security review and the existing production handoff.

Use direct/session-persistent PostgreSQL connections. Transaction-mode poolers are
unsupported for scheduler advisory locks. This remains one isolated firm per
stack/database/bucket/key set; shared-database SaaS tenancy is not implemented.
