# Combined checklist integration review

This records the initial timer/checklist pass. The subsequent [expense and linked-source billing review](2026-10-31-expenses.md) verifies checks 047 and 050; consult the live tracker for aggregate status.

Date: 31 October 2026. Source: the owner's `Combined_Clio_LEAP_Reglify_Checklist.docx` with 192 requirements across 24 sections.

## Scope and findings

The owner confirmed one client law firm per installation and asked to leave external provider selection open while learning the implementation. The tracker retains all 192 source checks; shared-database tenant isolation checks 012-015 and cross-firm analytics check 136 have an explicit single-firm scope exclusion. Staff, matter-team and client-portal separation remain required.

The [complete requirement tracker](../requirements/combined-feature-checklist.md) records implementation references and remaining actions. No source item is silently treated as complete because a menu, prototype, historical report or similarly named module exists.

Material open work includes contact/lead CRM, expenses, billing settlement/PDFs, document automation and OCR, workflow/deadline templates, approved deterministic risk rules, persisted challenges, complete sealed decision snapshots with external anchoring, compliance reporting, practice packs, subscription decisions and external integrations. PostgreSQL currently uses Kysely rather than the checklist's Prisma layer. These are recorded gaps, not implemented features.

## Implemented in this change

Migration `0081_durable_work_timers.sql` adds one persistent worker timer and immutable consumption receipts. The session determines the worker; strict request schemas reject caller-supplied account IDs. All changes compare revisions under a worker-specific database transaction lock, preventing stale device writes.

The toolbar now reads server state, derives elapsed time from timestamps, refreshes between tabs and devices, and carries a paused timer's identity/revision through matter selection to the time form. Manual entries leave the timer intact. Saving a timer inserts one time entry, consumption receipt, timer reset and audit event in one transaction. Replaying the same reviewed details returns the original entry ID; changed details conflict. The existing time-entry triggers continue checking clearance, team membership, roles and date-specific rates.

A GitHub Actions workflow now provisions disposable test configuration and runs source guards, builds, real API/database tests and browser acceptance. A hosted Actions run has not been observed in this session.

The requirements validator checks that all 192 IDs and original source descriptions survive, all referenced evidence files exist, and verified items have dated acceptance evidence. The [learning guide](../requirements/implementation-learning-guide.md) explains the implementation and how to reproduce it.

## Validation

- API TypeScript check: passed.
- Web TypeScript check: passed.
- API production build: passed.
- Web production build: passed.
- Focused workspace, finance and metrics tests: 3 files, 34 tests passed against PostgreSQL, including timer concurrency, privacy, stale revisions, timestamp accounting after 75 seconds without browser ticks, resume/reset, idempotent conversion, failed clearance, audit rollback and preservation of sessions longer than 24 hours.
- Browser acceptance: the new Chromium timer journey and its AML setup both passed. The journey checks reload persistence, a second tab, pause synchronization, handoff through matter selection, one saved entry and reset.
- Hidden-character check, security source guard and `git diff --check`: passed.
- Requirement/source/evidence validation: all 192 records pass.

Earlier browser attempts failed on ambiguous test selectors for the matter dropdown; the test now uses its combobox role. Earlier sandboxed browser runs completed their assertions but needed interruption during Windows test-server cleanup. The final run outside the sandbox completed normally: 2 tests passed in 26.4 seconds, exit code 0.

Checks 041-044 are marked verified with this dated review and the test sources attached as acceptance evidence. The other 183 applicable checks remain open for implementation or acceptance verification; five checks have the owner's single-firm scope exclusion.

## Limits

This verifies the changed timer workflow and the listed regressions. It does not establish completion of the remaining checklist, a successful hosted CI run, external provider connectivity, professional regulatory/accounting review, or final client acceptance. Existing historical security/load/restore reports remain historical evidence and were not rerun as part of this timer change.
