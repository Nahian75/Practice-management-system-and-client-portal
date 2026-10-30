# Production readiness audit — first local verification pass

This is the baseline audit. Current repairs and remaining release gates are tracked
in the [remediation follow-up](2026-10-30-security-remediation.md).

Audit date: 30 October 2026 (Asia/Dhaka). Scope: the current local working tree, including uncommitted workspace/hosting changes. Git base: `864feb0806e9ac32a4caf5d3c51e729851c684b7`; that commit alone does not describe the audited files.

**Release assessment: production sign-off is not supported yet.** Security mechanisms are present and several checks pass, but the findings and operational evidence gaps below remain open. This is an engineering review with local testing, not an independent penetration-test attestation or legal compliance assessment.

The [293-control master checklist](../pms-production-master-checklist.md) remains the governing backlog. A separate [control-status register](2026-10-30-production-readiness-controls.csv) records this pass without falsely checking off tasks that still need full evidence and independent review.

## Execution and evidence

The first API-suite attempt was interrupted when local services stopped; it produced no completed report and is not counted as a passing run. Existing containers were restarted without deleting development data. Test connections were checked to target only loopback `pms_test`; browser tests use separately recreated `pms_e2e` and dedicated test ports.

| Check | Result in this pass | Evidence / qualification |
|---|---|---|
| API TypeScript | Passed | `logs/audit-api-typecheck.log` |
| Web TypeScript | Passed | `logs/audit-web-typecheck.log` |
| API production build | Passed | `logs/audit-api-build.log` |
| Web production build | Passed | `logs/audit-web-build.log` |
| npm advisory scan | Passed: zero reported vulnerabilities | `logs/audit-dependencies.json`; an advisory scan does not find every vulnerability |
| Dependency-age policy | Passed | 346 packages checked; 37 recorded exceptions apply |
| Hosting configuration unit tests | Passed: 4 tests | `logs/audit-hosting-tests.log`; not a live cloud deployment test |
| Existing production-hygiene checker | Passed | `logs/audit-production-hygiene.log`; checks file content/existence, not whether cloud safeguards are deployed |
| Existing hidden-character checker | Passed | This script reads committed HEAD; it does not establish current-working-tree coverage |
| Additional working-tree character scan | Passed | 775 Git-visible text source files, zero hidden-character findings |
| API endpoint policy inventory | Reviewed | 356 source-declared routes: all have an access policy and response schema; this is not proof of every business permission |
| Git-history secret scan | Passed | Gitleaks 8.30.1, 137 reachable commits, no findings after the repository's reviewed ignore rules |
| Current-source secret scan | Triaged | 775 Git-visible text files; two findings were verified as non-secret test/migration identifiers |
| Live database role inspection | Reviewed | `pms_app` and `pms_owner` are not superusers, role creators, database creators or BYPASSRLS roles |
| Live table-isolation inspection | Gap for shared tenancy | All 181 application tables inspected in `pms_test` have row-level security disabled |
| Password-reset fault injection | Confirmed failure mode | Synthetic service dependencies reproduce consumed reset links and incomplete session revocation; details below |
| Full API suite on existing test data | 2,082 passed / 10 failed / 2,092 total; no skipped tests | `logs/audit-api-tests.json`; this run is not green |
| All four failing API files, after recreating only `pms_test` | Passed: 142 / 142 | `logs/audit-api-failure-retest.json`; no API implementation or assertion changes were needed |
| Full browser suite, before audit repairs | 77 passed / 15 failed / 5 skipped, 97 total | `logs/audit-browser-tests.json`; production web build; this run is not green |
| Rebuilt affected browser files | 42 passed / 4 failed / 0 skipped, 46 total | Two search-selector failures and two retained CSP failures; seven affected files plus setup, fresh `pms_e2e` |
| Final scoped client-search retest | Passed: 3 / 3 | Required setup plus both search tests; access-denial and takeover assertions retained |
| Local preview restored | API healthy; web HTTP 200 with CSP | `http://localhost:3000`; development database preserved |

Raw logs remain under ignored `logs/` because test outputs may contain synthetic tokens or other sensitive diagnostics. The [sanitized evidence summary](2026-10-30-production-readiness-evidence.json) contains only counts, scope and redacted finding metadata. Binary/export artifacts and ignored local secrets were outside the current-source text scan. No real-client extraction or public-production attack was performed.

The ten initial API failures were five invitation-email assertions, one matter-supervision notification assertion and four finance/reconciliation assertions. All four affected files passed on a freshly recreated test database (142 tests). Persisted fixtures and/or shared-service timing are implicated; this does not prove a single root cause for every failure. The full 2,092-test suite was not rerun clean after that focused result, so the combined results are not presented as a clean full-suite pass. Test-server EventEmitter-listener warnings also remain to be investigated separately; they are not evidence by themselves of a production memory leak.

The rebuilt 46-case browser retest verified the contrast repairs and the invitation, MFA, session, finance, HR and portal selector repairs. It initially retained two further client-search selector collisions and two genuine CSP failures. The two search cases were then corrected to use the client-search region and passed with their setup (3/3). The two remaining reproduced workflow failures are the document/matter CSP compatibility issue in AUD-014. Neither the full 97-case browser suite nor the 46-case subset is represented as a single clean run after all repairs.

The current-source secret findings were:

1. `apps/api/src/auth/passwords/breached-password-checker.spec.ts:72`: a deliberately invented password used to verify log redaction. The history ignore already documents this specific false positive; scanning a copied snapshot changes its fingerprint path.
2. `docs/database-design.html:3`: adjacent migration names `0005_totp_credentials` / `0006_two_factor_sign_in`, rather than an API credential. No real secret was exposed by this finding.

## Confirmed findings and release work

### AUD-001 — Password reset can partially commit when a later step fails

**Priority:** P0. **Technical severity:** medium; a recovery/integrity failure under injected dependency failure, not a demonstrated remote account-takeover exploit. **Controls:** AUTH-009, AUTH-010, AUTH-032, API-010, ARCH-022, QA-007.

**Observed:** `PasswordResetService.complete` closes the reset token, hashes/stores the password, revokes sessions and writes audit in separate operations. `apps/api/src/auth/password-reset/password-reset.service.ts:119–132` shows the ordering. `AccountsRepository.setPassword` does not accept the caller's transaction. Session lookup checks account status and expiry but not `password_changed_at` as an independent revocation condition.

**Reproduction:** service-level fault injection with synthetic in-memory dependencies used the compiled application service, with no changes to client accounts:

| Failure injected | Reset token consumed | Password changed | Existing session remains active | Completion audit written |
|---|---:|---:|---:|---:|
| Password hashing | Yes | No | Yes | No |
| Session revocation after password write | Yes | Yes | Yes | No |

The normal successful-reset test can pass while this fault path remains unsafe. Evidence: `logs/audit-reset-failure-evidence.json`.

**Required closure:** compute the password hash before consuming the reset, then atomically recheck/consume the reset, update the account, revoke affected sessions and record required audit. Coordinate post-commit notices with durable delivery. Add failure/concurrency integration tests proving rollback and session invalidation; rerun recovery and authentication regressions.

### AUD-002 — Managed hosting lacks a verified general API abuse boundary

**Priority:** P0. **Technical severity:** medium availability/abuse risk based on configuration review; no destructive load test was performed. **Controls:** THR-020, THR-021, THR-024, THR-026, THR-027.

**Observed:** the active Render path uses `infra/hosting/render.Caddyfile`, which enforces body-size boundaries but declares no general request-rate limiter. `apps/api/src/app.setup.ts` does not install a general limiter. Login has persistent per-account/per-address failure limits, and uploads have per-user quotas. Password-reset requests limit only known-account requests to three per hour; arbitrary/unknown addresses still cause database/audit work without a matching per-origin endpoint limit in this reviewed path. `infra/proxy/nginx.conf` has rate-limit examples, but Render does not route through that Nginx configuration.

**Required closure:** establish and test the actual edge/application limits for anonymous recovery/invitation endpoints and expensive authenticated actions, including trusted-IP handling and multiple instances. Verify the chosen provider's DDoS/origin controls separately; absence of a repository rule does not prove the provider has no infrastructure protections.

### AUD-003 — Scanner availability is checked; signature freshness is not enforced

**Priority:** P0. **Technical severity:** medium. **Controls:** THR-031, OPS-026, REL-006.

**Observed:** uploads fail closed when ClamAV cannot answer and reject limit-exceeded results. However, `apps/api/src/documents/virus-scanner.ts` accepts an `OK` scan without checking the definitions' age. `infra/hosting/check-services.mjs:20–24` checks PING/PONG only. The container runs definition updates, but no reviewed application/monitoring policy verifies that successful scans use definitions within an approved freshness window.

**Required closure:** define a numeric freshness policy; monitor engine/definition status and updater failures, and fail closed or hold uploads when that policy is exceeded. Test stale definitions, updater failure and recovery. A reachable daemon alone is insufficient. Reference: [ClamAV configuration and FreshClam](https://docs.clamav.net/manual/Usage/Configuration.html).

### AUD-004 — Audit records lack independently verifiable tamper evidence

**Priority:** P0 under the master checklist. **Technical severity:** medium against a privileged database compromise. **Controls:** ARCH-023, ARCH-024, OPS-025.

**Observed:** audit tables have append-only triggers, database-generated IDs/times and restricted insertion. These protect normal application writes. `docs/audit.md:53–54` explicitly describes externally anchored hashing/write-once shipping as planned. This pass found no implemented external checkpoint, independently protected audit replica or write-once export pipeline.

**Required closure:** choose an independently protected audit-integrity design, configure retention/access/alerts, and demonstrate detection of deleted or modified history. Do not describe database triggers alone as protection against an administrator who can disable them.

### AUD-005 — Automated security release gates are not configured in the repository

**Priority:** P0 release-process gap; not assigned a runtime CVSS severity. **Controls:** SEC-001–SEC-008, OPS-013, OPS-017, REL-004.

**Observed:** no GitHub/GitLab/other reviewed pipeline configuration, automated SAST/DAST, dependency analysis, credential-exposure checks, SBOM and provenance release job or automated deployment gate was found. Local scanners and tests can be run manually and some are present, but a green manual run does not establish ongoing enforcement. External account-level branch protection and scanners remain unverified.

**Required closure:** implement reviewed CI gates for type/build/tests, dependency and secret scanning, SAST and relevant IaC/container checks; add authenticated staging DAST and artifact provenance. Verify branch protection, untrusted-pull-request isolation and scoped deployment credentials in the actual repository account.

### AUD-006 — Backup recovery instructions contain an incorrect PostgreSQL configuration step

**Priority:** P0. **Operational severity:** high risk of failed or incorrect recovery if the instructions are used unchanged. **Controls:** OPS-029–OPS-034, OPS-042, REL-004.

**Observed:** `docs/disaster-recovery.md:81–85` writes `restore_command` and recovery-target settings into `recovery.signal`. PostgreSQL expects these settings in configuration and uses `recovery.signal` as the recovery-mode marker. The guide also presents the security `retention:sweep` as post-backup disposal replay, but that CLI sweeps ephemeral authentication/security records; it does not itself reconstruct all AML/HR deletions after a backup. Its direct-API health example uses `/api/health` on port 3001, while the API controller declares `/health`.

Separately, the guide describes immutable backups, replication, restoration objectives and periodic drills as if established, but this pass has no deployed-provider evidence or measured restore result. A documentation-content checker passing does not prove those controls exist.

**Required closure:** correct and clearly label the provider-specific recovery procedure, establish a durable independent post-backup disposal record/replay mechanism, and execute an isolated restore including object versions and decryption keys. Measure achieved RPO/RTO and verify deleted records remain unavailable. The correct PostgreSQL boundary is documented in [PostgreSQL 18 PITR recovery](https://www.postgresql.org/docs/18/continuous-archiving.html#BACKUP-PITR-RECOVERY).

### AUD-007 — Shared multi-practice SaaS tenancy is not implemented

**Priority:** P0 if sharing one database across practices; otherwise a documented architecture/scope decision. **Controls:** ARCH-002–ARCH-012, QA-003.

**Observed:** the current schema and application model are firm-wide and contain no general tenant ownership boundary. The live test database has 181 ordinary application tables, none with RLS enabled. Runtime roles are restricted, and client/matter/team permissions are a separate useful boundary, but they do not turn firm-wide billing, account, compliance and audit queries into multi-tenant queries.

**Required closure:** either explicitly deploy one isolated stack/database/storage/key set per practice and test that operational boundary, or design authoritative tenant context and database/object/cache/job isolation before offering shared-database SaaS. Lack of RLS is not automatically a vulnerability in a deliberately isolated single-practice deployment.

### AUD-008 — Appointment functionality is a personal calendar, not a complete booking engine

**Priority:** P0 only for the promised scheduling scope. **Type:** functional capability gap. **Controls:** SCH-001–SCH-009, REL-001.

**Observed:** the current workspace supports personal appointment creation/listing/cancellation and optional matter association. `0076_personal_calendar.sql` has no resource/overlap exclusion rule. Recurrence, practitioner/room capacity, external calendar sync and cancellation/reminder booking rules are not established by this implementation. Two overlapping personal calendar events are not necessarily invalid; the issue is claiming exclusive-resource booking guarantees that are not built.

**Required closure:** confirm the initial scheduling promise. If exclusive bookings are needed, add database-enforced conflict handling and concurrent-booking tests; implement and test the other promised workflows or keep them outside the release scope.

### AUD-009 — Telehealth is outside the implemented application scope

**Priority:** scope-dependent. **Type:** unimplemented optional module. **Controls:** TEL-001–TEL-010, ARCH-027, ARCH-034, REL-001.

**Observed:** no video-room/signaling/provider integration or admission/recording workflow was found. The current web permissions policy explicitly disables camera and microphone. The repository describes a legal-practice system, so healthcare-specific obligations cannot be assumed merely because the generic checklist includes telehealth.

**Required closure:** retain this module as excluded/N/A with an approved scope decision, or implement it and complete its dedicated tests, vendor/privacy review and clinical approvals before enabling it. Do not simply relax camera/microphone permissions and call telehealth complete.

### AUD-010 — Key rotation and recovery evidence are incomplete

**Priority:** P0 for release operational readiness. **Type:** cryptographic lifecycle gap. **Controls:** ARCH-017, OPS-011, OPS-029–OPS-032.

**Observed:** `SecretBox` accepts one current key/version, and document vault code uses a fixed version. Managed deployment derives purpose-specific keys from one persistent root and intentionally refuses accidental root replacement. This protects against inadvertent key loss, but no completed multi-version rotation/re-encryption or compromised-root recovery drill was found in this pass.

**Required closure:** document and test current/previous key handling, rewrapping/re-encryption, key access separation, backup restoration and emergency rotation. Do not replace the persistent root in a live installation as a casual credential change.

### AUD-011 — Policy and assurance decisions remain unresolved

**Priority:** P0 for deciding applicable release requirements. **Controls:** AUTH-005, ARCH-026–ARCH-035, OPS-028, REL-005–REL-007.

The code currently enforces 12–128-character passwords with mandatory MFA; the generic checklist proposes a 15-character application baseline. This is a policy difference, not proof that MFA-protected 12-character passwords violate NIST. Agree the actual baseline before changing existing authentication rules. Likewise, determine healthcare/telehealth applicability, processor contracts, transfer/retention rules, SLO/RPO/RTO owners and independent approval responsibilities. No legal/provider-account compliance sign-off was performed in this review.

### AUD-012 — Animated content and an AI tab fail text contrast

**Priority:** P0 for the selected accessibility release target. **Type:** reproduced UI defect. **Controls:** WEB-020, WEB-021, WEB-022.

**Observed:** the full browser suite detected a 3.43:1 contrast ratio on the reconciliation CSV export action during a simultaneous text/background transition. A secondary button inherited the dark primary-button hover state, so intermediate animation colours failed the 4.5:1 normal-text requirement. Page-entry opacity also reduced contrast on matter hints and dashboard notes (including a measured 4.48:1 result), and the active AI tab used a blue with a measured 4.09:1 contrast on white. These cases did not appear in the earlier eight-screen overview scan.

**Locally repaired and verified:** secondary-button hover now keeps a light background and dark text; page-entry animation keeps text fully opaque while retaining a small translation; selected AI tabs use a darker blue. The original contrast failures no longer reproduce in rebuilt finance, matter and dashboard accessibility assertions. AUD-014 still prevents complete matter/document workflow passes, and broader manual accessibility/independent review remain outstanding.

### AUD-013 — Health endpoint does not establish runtime dependency readiness

**Priority:** P0 to define the release health/alerting contract. **Type:** operational gap. **Controls:** OPS-019, OPS-027, OPS-028.

**Observed:** `apps/api/src/health/health.controller.ts` returns a constant `status: ok`. Database startup connectivity is checked, but a later database failure does not change that health answer. The managed service points its health check at this endpoint. This pass found no equivalent runtime dependency-readiness endpoint in the reviewed path.

**Required closure:** distinguish liveness from readiness and monitored dependency status; test database, storage and scanner failures according to which workflows they block. Avoid restarting every process when an optional dependency fails, while ensuring routing and on-call alerts detect unusable critical services.

### AUD-014 — Legacy AI component styles conflict with the enforced CSP

**Priority:** P0 for the affected UI release scope. **Type:** reproduced policy/UI compatibility defect, not a demonstrated CSP bypass. **Controls:** WEB-001, WEB-023, QA-004, DOC-001.

**Observed:** after the document-upload test selectors were repaired, the full upload/download/reload flow reached its CSP assertion and recorded 40 `style-src-attr` violations. The matter-opening workflow independently reached its CSP assertion and recorded 19 more instances of the same directive. `apps/web/src/app/(staff)/matters/[matterId]/ai-workbench-section.tsx` contains inline styles rendered alongside the matter's document controls; the AI governance component also contains inline styling. The app's `style-src` correctly requires approved styles, so these legacy attributes conflict with the intended policy. Earlier selector failures prevented this assertion from running.

**Required closure:** migrate the affected static/dynamic styles to approved CSS/classes and appropriate native/SVG attributes, preserve the enforced CSP, then rerun document, matter and AI interactions with the CSP event collector. Do not remove the assertion or enable blanket `unsafe-inline` to make the test green. The upload/download data assertions pass in this retest before the policy assertion fails; that is partial functional evidence rather than a complete document-workflow pass.

## Small repairs made during verification

- Browser selectors now open the client-search disclosure, match File exactly, use the renamed Team directory link, scope portal statuses to their own region and verify the signed-in account in its current header location. The permission, takeover, malware, account-identity and download assertions remain intact.
- Secondary-button hover, page-entry opacity and selected AI-tab colours were corrected for AUD-012 and verified in the rebuilt affected browser tests.
- The password-reset, rate-limit, scanner-freshness, audit-integrity and recovery findings remain open; this pass has not changed those application/security behaviours.
- The document CSP assertion was retained and exposed AUD-014. It remains an open finding rather than an ignored test failure.

## Recommended closure order

1. Resolve AUD-001 recovery atomicity and add fault-path integration coverage.
2. Establish the deployed rate/abuse boundary and scanner freshness policy (AUD-002/003).
3. Correct and rehearse recovery and key lifecycle procedures (AUD-006/010).
4. Implement independent audit integrity and automated release/security gates (AUD-004/005).
5. Resolve the retained CSP compatibility failure and define/test runtime readiness (AUD-014/013).
6. Decide single-practice versus shared tenancy, scheduling promises and telehealth scope (AUD-007/008/009).
7. Complete staging/cloud/contract evidence and an independent penetration assessment before production approval.

## Remaining verification boundaries

Production DNS/TLS/CDN/WAF, actual Render account permissions, external SMTP inbox delivery, cloud storage policies, monitored alerts, immutable backup copies, full recovery drills, vendor contracts and independent penetration testing remain external/unverified. This pass did not prove every one of the 293 controls, and no full checklist item is marked complete solely from a source annotation or passing happy-path test.
