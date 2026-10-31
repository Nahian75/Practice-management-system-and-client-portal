# Code cleanup and verification - 31 October 2026

## Scope and removals

The working tree was clean before cleanup. The README, architecture and testing instructions, workspace scripts, dependencies, application entry points and web `AGENTS.md` were inspected before editing.

- Removed the unused `StatusTag` component and its unused tag variants and blue/purple color variables. Active success, warning, danger and badge styles remain.
- Removed the superseded `practice-dashboard` / `ops-*` stylesheet and 24 obsolete dashboard rules in `manage.css`. The current dashboard renders `reference-dashboard` classes instead.
- Moved the still-required Tailwind theme and utility imports from the removed dashboard stylesheet into `apps/web/src/app/tailwind.css`, preserving their layout import position.
- Combined duplicate fuzzy-citation result construction, clarified the word variable and corrected the threshold comment. Added a regression test for the inclusive 85% boundary, an 80% rejection and mixed-result totals.

No dependencies, lockfile entries, database migrations, public routes, authentication controls or permission rules were changed. Generated files were not edited directly.

## Evidence and retained items

Source imports and exported symbols were checked across tracked TypeScript and JavaScript, with repository-wide reference searches and review of framework conventions and runtime loading. After cleanup, source files without incoming imports outside the Next.js app directory are the API main entry point, invitation and retention CLIs, migration entry point and Next.js proxy. These are intentional entry points.

The web source has no dynamic component loader that discovers `StatusTag`. The removed dashboard class families are absent from active rendering code. The remaining `manage.css` rules were compared with the original after excluding only the obsolete dashboard rules and matched exactly.

Retained items include:

- `AiService.formatChronology` and `CitationGroundingService.calculateWordSimilarity`: no callers were found, but their services are exported from the Nest module. They remain because removing them could change an interface.
- `SqlFileMigrationProvider.getMigrations`: called through the Kysely migration-provider interface.
- The downloadable public logo: its URL may have external consumers. The locally hosted font and its license are also retained.
- Other uncertain selectors, operational scripts and configuration: lack of a direct import alone does not prove they are unused.

This review does not establish repository-wide zero dead code or complete runtime reachability. Dependency checks did not establish a safe dependency removal.

## Citation matching clarification

The algorithm is unchanged. It normalizes source text and quotes, accepts exact substrings, then accepts a fuzzy match when at least 85% of quote words occur as substrings in the referenced normalized document. The active fallback does not use the separate Jaccard helper. Matching is not proof of factual accuracy; existing human review and warning requirements remain.

## Validation

| Check | Result |
| --- | --- |
| `npm run typecheck --workspaces` | Both applications passed before and after cleanup |
| `npm run build --workspaces` | Both baseline builds passed; affected applications were rebuilt successfully after their final changes |
| Focused API citation, controller and adversarial suites | 47 tests passed across 3 files, using `--maxWorkers=1` |
| `node --test scripts/*.test.mjs` | 10 tests passed |
| `npm run test:e2e -w @practice/web -- --workers=1` | Final uninterrupted run reported 101 passed in 12.5 minutes |
| `npm test -w @practice/api -- --maxWorkers=4` | 2,094 passed, 44 failed; 115 files passed and 9 failed |
| `npm run check:security-source` | Passed, zero issues |
| `npm run check:production-hygiene` | Passed |
| `npm run check:features` | Passed validation of the 192-item checklist; this is not a claim that every feature is implemented |
| `npm run check:dependency-age` | Passed: 346 packages checked, with 37 recorded exceptions |
| `npm run check:hidden-characters` | Failed on existing `U+FEFF` at line 1, column 1 of `docs/requirements/combined-checklist-source.txt` |
| `git diff --check` | Passed |
| Formatting and linting | No formatter or lint command is configured |

The focused API command selected `src/ai/citation-grounding.service.spec.ts`, `src/ai/ai-security-review.spec.ts` and `src/ai/ai.controller.spec.ts`.

### Failures and execution limits

The initial full API baseline was stopped after repeated integration failures. It already showed email-related timeouts and reconciliation failures. A complete rerun with local service access and the CI worker limit finished with the counts above. Failures included missing or delayed invitation/security emails, 20-second timeouts, and finance reconciliation fixtures that lacked a statement for every open client account. Tests and safeguards were not weakened to hide these failures.

Browser validation initially needed Docker access. An intermediate browser run overlapped an API rebuild and was stopped after invitation CLI files were temporarily absent. The final run used completed builds and reported all 101 tests passing. PowerShell returned exit 1 while redirecting warning output despite the passing summary; the same wrapper behavior was independently reproduced with a successful Node command that only wrote a warning to stderr.

The hidden-character script reads committed `HEAD` for `--all`, rather than uncommitted working-tree content. Its reported BOM predated this cleanup. Historical verification counts in earlier reviews describe their original runs and do not override these results.

### Follow-up - 1 November 2026

GitHub Actions run `41232637120` stopped at the hidden-character check because of that BOM. The leading three UTF-8 BOM bytes were removed from `docs/requirements/combined-checklist-source.txt`; the remaining bytes match the previously committed source exactly. The checker and its rules were not weakened. This fixes that workflow blocker; the earlier API failures remain separate, and later CI steps still need their own results.

Ignored local evidence is available in `logs/cleanup-api-tests.log`, `logs/cleanup-ai-tests.log`, `logs/cleanup-e2e.log` and `logs/cleanup-web-build.log`. Logs, configuration, browser traces and credentials are not part of the commit.
