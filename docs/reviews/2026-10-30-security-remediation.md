# Security remediation follow-up

Scope: local working tree following the baseline production-readiness audit.
Development data was preserved. Only isolated pms_test/pms_e2e and randomly named
recovery scratch databases were recreated. No public deployment was attacked or
configured. This is engineering verification, not independent security certification.

The [updated 293-control import](2026-10-30-security-remediation-controls.csv)
records partial remediation and pending review without replacing the baseline.

## Finding status

| Finding | Current implementation | Remaining release evidence |
|---|---|---|
| AUD-001 Reset atomicity | Hash before locking; reset consumption, password update, session revocation, audit and encrypted notice commit together. Failure injection and concurrent-use tests pass. | Production recovery journey and independent review. |
| AUD-002 Abuse limits | Database-backed shared IP/auth/recovery/account limits, atomic concurrent enforcement, Retry-After, private-table permissions and fail-closed database handling. Strict forwarded-address parsing at Render proxy. | Provider WAF/DDoS/origin policy and distributed deployment checks. |
| AUD-003 Scanner freshness | Verify ClamAV definition timestamps, enforce 48-hour maximum and bounded status timeout, fail closed; configure UTC. | Provider updater monitoring and freshness alerts. |
| AUD-004 Audit integrity | Separate Ed25519-signed row hashes/disposal journal, comparison against previous checkpoints, restricted reader and KMS/Object-Lock storage tooling. Tamper/deletion tests pass. | Independent account/bucket/key provisioning, trusted first checkpoint, schedule, alerts and operational exercise. |
| AUD-005 Release gates | Pinned GitHub jobs for tests/build, dependency/secret scans, CodeQL/SARIF, Trivy IaC/images, SBOM and source provenance. Linux passive ZAP wrapper observes authenticated synthetic browser journeys. Actionlint/YAML validation passes. | Actual GitHub runs, branch protection, passive DAST execution/triage and independent staging penetration test. |
| AUD-006 Recovery | Corrected recovery.signal/configuration instructions and removed nonexistent automatic disposal replay claim. Encrypted snapshot/restore verifies all application table counts/hashes. Signed disposal verifier blocks unknown/resurrected IDs. | Provider PITR and object/key recovery drill, journal completeness, approved disposal replay when needed, achieved RPO/RTO and officer approval. |
| AUD-007 Tenancy | Explicit isolated-stack-per-firm deployment boundary; no shared-database SaaS or RLS claim. | Verify separate provider resources, credentials and keys for each actual firm. Shared SaaS remains unimplemented. |
| AUD-008 Scheduling | Personal calendar scope explicitly documented. | Exclusive-resource booking, recurrence and clinical scheduling remain outside current implementation. |
| AUD-009 Telehealth | Explicitly excluded from current legal-practice release; camera/microphone remain disabled. | Separate implementation, vendor/privacy/security review if later requested. |
| AUD-010 Key lifecycle | Versioned current/retained keys for all seven encryption purposes; old reads/new writes and stable finance fingerprints tested. Managed derivation preserves original keys and database credentials. | Secret-manager setup, operator recovery/rotation drill and reviewed bulk re-encryption before retiring old versions. |
| AUD-011 Policy/assurance | Existing 12-128-character policy, mandatory MFA and breached-password checks documented accurately. Unsupported AI compliance guarantee removed. | Firm policy approval, jurisdiction/vendor/contracts and independent assurance. |
| AUD-012 Contrast | Removed opacity-based page entrance, corrected hover and selected-tab contrast; retained reduced-motion behavior. | Full browser regression evidence below; human accessibility review remains useful. |
| AUD-013 Readiness | Separate liveness /health and generic /ready dependency checks for DB, bucket and fresh scanner; Render routes readiness through /api/ready. | Real platform routing/alert/failure exercise. |
| AUD-014 CSP styles | Replaced legacy AI/portal inline styles with external CSS and native progress; strict CSP retained. Added source guard against inline attributes and unsafe rendering. | Full browser CSP regression evidence below. |

Additional financial safety repair: removed invented bank details from the staff
form and portal fallback. Empty/invalid details no longer become payment instructions;
the portal asks the client to contact the firm. Receipt status says payment recorded,
without claiming bank reconciliation. Regression assertions verify absent defaults.

Full-browser testing additionally exposed a proxy integration defect: server-side
reads were grouped under the web server's address and could throttle unrelated
users. Reads now preserve the validated edge address chain; Compose assigns the
web server a fixed trusted private address. Failed/rate-limited reads use the safe
retry boundary rather than showing empty records or falsely treating a user as
signed out. New 429/503 browser regression cases cover that failure behavior.

## Verification

- Clean full API run: **2,107 passed; zero failed or skipped**.
- Final key-configuration validation after allowing an empty optional Compose key
  ring: **71 passed**, including retained-key validation. No other runtime API
  behavior changed after the full-suite run.
- Hosting/key-rotation/checkpoint tests: **7 passed**.
- Real-schema disposal recovery verification: **1 passed**, including refusal of a
  signed journal pointing to a currently present record and an unknown category.
- Local AES-256-GCM logical restore: **182 application tables**, all row counts and
  content hashes matched. Production RPO, object recovery and sign-off remain unproven.
- API/web typechecks and production builds passed. Security source guard and
  production-hygiene checks passed. Workflow syntax passed pinned Actionlint.
- npm advisory scan: **zero known vulnerabilities**. Dependency-age policy passed
  for 346 packages with 37 recorded exceptions.
- Full rebuilt browser run: **99 passed; zero failed, skipped or flaky**, including
  login/MFA/recovery, client and matter access, uploads/downloads, strict CSP,
  accessibility, billing, HR, onboarding, portal access and tasks. The corrected
  payment and shared-proxy cases passed, together with the new 429/503 retry cases.
- Current-source secret scan: **792 text files, zero findings** after the reviewed
  invented-password test exception and exact migration-identifier allowlist.
  Git-history scan: **137 reachable commits, zero findings** with reviewed ignores.
- Pinned Caddy configuration validation passed. Local /health, /ready and sign-in
  returned HTTP 200 with security headers; preview is http://localhost:3000.

The [sanitized evidence summary](2026-10-30-security-remediation-evidence.json)
contains final counts and explicit verification limits. Interrupted browser attempts
are not passing evidence. A completed earlier run had 94 passes and three failures
which exposed shared server-address throttling; all three passed in the final full
run. Fixtures assign independent synthetic test addresses, while production limits
remain enabled and server-rendered reads preserve the trusted address chain.

Raw diagnostics remain ignored because they can contain synthetic credentials,
tokens and traces. Do not upload those logs as public CI artifacts.

## Production gate

The project is **not yet signed off for live client data**. Complete the external
items in [security operations](../security-operations.md) and the provider recovery
drill. The original 293-control register is retained as baseline evidence; this
follow-up does not mark unrelated or externally unverified controls complete.
