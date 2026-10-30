# Local load-test results

Date: 31 October 2026, Asia/Dhaka. Application base commit: aa053d154063b3f23dbe6a2d8949e841710b55cd. The new load-test harness is currently uncommitted.

**Result:** the selected mixed API workload passed with 100 synthetic active users at one request per user per second: **98.93 requests/second, p95 175.6 ms, zero unexpected responses**. This is a short local result, not an AWS capacity promise or a maximum-user limit. A separate office-NAT probe exposed LOAD-001 below.

## Tested scope

Production builds ran on separate loopback ports 3200/3201, using only the disposable local pms_e2e database, local test storage and local Mailpit. The development pms database and preview ports 3000/3001 were not load targets. Fixtures used the existing protected business-rule functions; no authorization checks, triggers, encryption, scanner checks or rate limits were disabled.

There were 100 measured fee-earner identities plus partner/compliance setup identities (303 accounts total), 2,100 synthetic clients, 100 cleared matters, 1,000 tasks and 1,000 initial calendar events. Measured writes added calendar events. Each measured user completed real Argon2id password verification and TOTP before the main traffic profiles.

## Completed measurements

Latency is in milliseconds. p95 means 95% of sampled operations completed within that time. The provisional engineering target was p95 below 2,000 ms with valid expected responses.

| Profile | Operations | Operations/sec | p50 ms | p95 ms | p99 ms | Unexpected responses |
|---|---:|---:|---:|---:|---:|---:|
| 100 real password + MFA logins (10 concurrent) | 100 | 70.92 | 121 | 280.2 | 326.5 | 0 |
| 10 active users, one request/user/second | 150 | 9.9 | 18.2 | 43.2 | 49.6 | 0 |
| 25 active users, one request/user/second | 750 | 24.76 | 29.6 | 44.7 | 51.2 | 0 |
| 50 active users, one request/user/second | 1,500 | 49.47 | 53.2 | 171.3 | 187.4 | 0 |
| 100 active users, one request/user/second | 6,000 | 98.93 | 55.9 | 175.6 | 284.5 | 0 |
| 100 concurrent API callers, bounded unpaced burst | 2,000 | 563.54 | 166.9 | 216.2 | 247.7 | 0 |
| 25 concurrent server-rendered dashboards | 150 | 4.98 | 675 | 1003.7 | 1006.2 | 0 |
| 20 x 1 MiB scanned/encrypted uploads, concurrency 10; downloads hash-verified | 20 | 14 | 297.9 | 880.9 | 882 | 0 |

The login row counts complete two-step journeys, not individual HTTP requests (200 HTTP POSTs for 100 journeys). The upload row measures upload latency; overall duration includes twenty downloads whose SHA-256 hashes matched the original 1 MiB synthetic text files. Dashboard measurements are server-rendered HTML responses, not browser interaction/render/asset timings. The unpaced burst was bounded to 2,000 requests, not sustained throughput.

## LOAD-001: shared-office rate limit needs capacity review

Follow-up: [scalability remediation](2026-10-31-scalability-remediation.md) fixes
the office quota and records the subsequent two-replica and shared-IP checks.
The results below are the original baseline before those fixes.

A separate probe sent seven task-list requests per user from 100 synthetic authenticated users sharing one IP. Of 700 requests, **600 returned valid task data and 100 returned HTTP 429** with Retry-After. There were **zero server errors/timeouts**. This matches the configured general quota of 600 requests/minute per IP. The NAT probe seeded test sessions for existing synthetic users; it did not repeat or measure MFA.

The quota can block legitimate office staff before CPU/database capacity is exhausted. Before an office rollout, design separate anonymous/authenticated budgets while retaining per-account controls and edge protection, then rerun shared-IP and abuse tests. Also review the per-IP authentication budget for office login bursts and page/session checks. No production rate-limit policy was weakened during this task.

## Security and availability checks

- The separate anonymous recovery probe accepted 20 requests and then returned 429 with Retry-After, as configured.
- A user attempting to open another user's matter received 404.
- All twenty scanned/encrypted uploads downloaded with matching hashes.
- Dependency readiness was healthy after the measured load.

## Environment and limits

Host: AMD Ryzen 5 5600, 12 logical CPUs, 31.9 GiB RAM, Node v24.16.0. Docker reported 12 CPUs and 15.6 GiB memory. Generator, application, database, storage and scanner shared this hardware; this does not represent a small AWS instance. API connection-pool maximum was ten. Per-phase resource telemetry is in the [sanitized evidence](2026-10-31-local-load-test-evidence.json). Whole-process peaks include startup.

This was a closed-loop exercise: slower responses reduce offered throughput. The 100-user stage lasted one minute; no long soak, failover, multi-instance job coordination, large financial ledgers, billing load, public TLS/WAF routing or WAN latency was tested. Main users had distinct synthetic addresses; the shared-office limitation was tested separately. AWS instance sizing and deployment capacity remain unverified.

## Reproduction

See [load-test instructions](../../scripts/load-tests/README.md). Run the main profile, then the shared-IP follow-up. Raw logs remain ignored and must not be published because diagnostics can contain synthetic credentials or tokens. Local test keys are not retained and these fixtures are not production backups.
