# Isolated local load exercise

This measures the compiled application on your own machine. It does not certify
AWS capacity, high availability, every business operation or a maximum user count.

Prerequisites: Node 24, installed dependencies, built API and web apps, local `.env`
settings and healthy Docker PostgreSQL, Mailpit, SeaweedFS and ClamAV services.
Use `npm run build -w @practice/api` and `npm run build -w @practice/web` before
starting; do not rebuild while a load test or browser suite is running.

Run from the repository root:

```sh
node scripts/load-tests/run-local.mjs
node scripts/load-tests/run-local.mjs --replicas=2
node scripts/load-tests/probe-nat.mjs
```

The runner **recreates only the disposable local `pms_e2e` database**. Do not run
it alongside browser tests. It rejects non-loopback database, SMTP and storage
targets, uses fixed loopback test ports 3200/3201 and refuses occupied ports.
Development database `pms` and preview ports 3000/3001 are not targets. The test
still shares your CPU, Docker services and disk, so the preview may be slower.

The second command is an optional seven-second shared-office-IP probe. Run it only
after the selected main command has finished. Each main command recreates fixtures;
choose one mode per run. The probe reuses the synthetic database, seeds test sessions
and leaves production limits enabled. After migration 0079 all 700 verified requests
should succeed. Anonymous and recovery quotas remain independently enforced.

The two-replica mode also uses ports 3203/3205 and a LOOPBACK-ONLY fixture balancer.
It alternates requests between APIs, drains/replaces one during mixed traffic and
then kills one abruptly during read-only traffic. Fixture GET/HEAD requests can
retry once before response headers; writes are never retried automatically. This
fixture's 250 ms probes and retry behavior are not AWS ALB timing guarantees.

It prepares 100 synthetic fee earners and the separate partner/compliance fixture
accounts needed for protected business rules, 2,100 clients, 100 cleared matters,
1,000 tasks and 1,000 calendar events. Fixture helpers are transpiled locally using
the existing TypeScript dependency. No authorization, database trigger, rate limit
or malware check is disabled. A tiny synthetic sanctions list is test data only.

Profiles exercise real password + TOTP authentication, mixed authorized API reads
and calendar writes at 10/25/50/100 active users, a bounded 100-caller API burst,
25 concurrent server-rendered dashboard callers and twenty 1 MiB text uploads at
concurrency ten. Downloads are hash-checked. Separate checks expect abuse throttling
and denial of another user's matter. Distinct synthetic addresses represent users
behind the test-only trusted loopback proxy. The follow-up NAT probe checks 700
requests from 100 authenticated staff sharing an IP, and uploads through one API
then downloads through another with a matching SHA-256 hash.

The provisional response target is p95 below two seconds with all expected responses
valid. This is an engineering target for this exercise, not an agreed production SLO.
Requests have 15-second timeouts. Closed-loop traffic can reduce its offered load
when the application slows, so compare achieved throughput as well as latency.
Do not confuse successful throttling with useful application throughput.

Reports and resource telemetry go to ignored `logs/load-tests/`. These include
synthetic fixture content and private diagnostics: publish only a reviewed summary.
API/web child processes stop on normal completion, errors or handled cancellation.
Synthetic records remain in the test database. Random encryption keys/passwords
are not retained; recreate fixtures for the next run. Uploaded test objects remain
in the dedicated test bucket and are not usable production backup copies.

Not covered: long-duration soak, real browser JavaScript/render timing, large
financial ledgers, high-volume billing, cloud autoscaling or database failover,
WAN latency, provider quotas, public TLS/WAF routing or production deployment size.
Use a separately authorized staging load test for those checks before promising
production capacity.
