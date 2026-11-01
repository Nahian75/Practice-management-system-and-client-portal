# Main branch and CI remediation - 1 November 2026

## Failure and repair

The push succeeded. The failure email came from GitHub Actions run [41239582202](https://github.com/Nahian75/Practice-management-system-and-client-portal/actions/runs/41239582202), for remote main `e7f37b1`.

That run passed secret scanning, dependency installation, source safeguards, both type checks and production builds, and all 2,167 API tests across 126 files. Browser acceptance reported 100 passed and one failed. The failing compliance-access screen included a 22.4-pixel-high "Look at another matter" button, below the 24-pixel accessibility target minimum and too close to the document download button.

The shared `.link-button` rule now gives controls a two-rem minimum height and inline-flex alignment. Existing larger button targets remain intact. The compliance browser test now measures the target and runs axe at both 1280-pixel and 390-pixel viewport widths. No accessibility rules, assertions, authorization checks or workflow failure conditions were disabled.

The existing CI workflow now also runs `node --test scripts/*.test.mjs` after API tests. This covers hosting configuration, key rotation, audit checkpoints, disposal recovery and scaling checks. The disposal test needs database fixtures created by the API suite, so the order is intentional.

## Branch consolidation

GitHub already contained only `main` when inspected. Stale local remote-tracking references were removed with `git fetch origin --prune`. The clean local main was fast-forwarded to remote main, preserving recent dependency, audit-chain, document-access and CI fixes.

The sole remaining non-main local branch was archived to the ignored recovery bundle `logs/local-scaling-branch-before-removal.bundle`. The bundle was verified before deleting the branch; its unmerged security-workflow commit remains recoverable. Only `main` remains locally and remotely. Automatic deletion of merged branches is enabled on GitHub. Scheduled dependency updates may create new review branches in the future; security updates were not disabled to maintain a permanently empty branch list.

## Local validation

- Installed the exact updated lockfile with `npm ci`: zero reported known vulnerabilities.
- Both workspace type checks and production builds passed.
- Security-source and production-hygiene checks passed, including the production Node version and image digest checks.
- All 10 hosting, recovery and scaling script tests passed after starting private services.
- Full browser acceptance passed: 101 tests, zero failures or skips, in 4.9 minutes with two workers. This includes the new desktop/mobile compliance target-size and axe regression.
- Docker Desktop was initially stopped; an initial disposal test failed with `ECONNREFUSED`. It passed after the existing services were started without deleting volumes.

## Production release limit

Successful CI verifies the tested code and workflows; it does not establish that a hosted production environment is configured or approved for live client data. The existing [production gate](2026-10-30-security-remediation.md#production-gate), hosting-specific TLS and private networking, provider configuration, backup/object restoration and independent review requirements still apply. This repair does not mark those external controls complete.
