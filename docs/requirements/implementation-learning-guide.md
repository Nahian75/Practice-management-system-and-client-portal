# Implementing the combined platform

The owner confirmed on 31 October 2026 that this is a system for one client law firm. Keep a separate database and private storage configuration for that installation. Staff permissions, matter-team membership and client-portal separation remain mandatory. Multiple firms sharing one database and cross-firm analytics are outside this installation's scope.

Provider choices remain open so they can be learned and implemented deliberately. A configured adapter, a provider test account, verified callbacks and an end-to-end test are needed before calling an integration connected. No real payment, identity, PEP, mail or calendar service has been added by this change.

## How to use the checklist

Start with [the full tracker](combined-feature-checklist.md). Every original item is preserved by ID, with its code references, remaining work and owner. The JSON file is the editable acceptance record. Run `npm run check:features` to validate it; `node scripts/check-feature-checklist.mjs --render` regenerates the readable view.

`present_unverified` means relevant code exists, rather than that the whole requirement passed. Add dated acceptance evidence before marking an item `verified`. Never replace the source wording to make an incomplete implementation appear complete. The import script rebuilds the baseline and will replace manual tracker edits; use it only for a deliberate baseline refresh.

## First implementation: a durable work timer

Previously the timer lived in `sessionStorage`, which belongs to one browser tab. Two tabs could track separately, and a save could not atomically consume the elapsed time. Migration `0081_durable_work_timers.sql` adds a server record per worker and a permanent receipt for each consumed timer.

```mermaid
sequenceDiagram
    participant Tab as Browser tab
    participant API as Authenticated timer API
    participant DB as PostgreSQL
    Tab->>API: Start/pause/reset with last revision
    API->>DB: Lock worker timer in a transaction
    DB-->>API: Current timer revision
    alt Revision changed elsewhere
        API-->>Tab: 409; reload current state
    else Revision matches
        API->>DB: Save new state and audit
        API-->>Tab: New revision and server time
    end
    Tab->>API: Save paused timer with reviewed work details
    API->>DB: Lock timer; check receipt and matter access
    API->>DB: Insert time through existing finance triggers
    API->>DB: Save receipt, reset timer and audit atomically
    API-->>Tab: Time-entry ID (same ID for identical retry)
```

Read `apps/api/src/workspace/work-timer.service.ts` with the migration. The important concepts are:

1. The account comes from the authenticated session. The API rejects extra input fields such as another account ID.
2. Each change includes the last revision seen. Another tab or device cannot silently overwrite a newer revision.
3. An advisory transaction lock serializes changes for one worker across API instances. Unrelated workers use different locks.
4. Elapsed time uses timestamps. Background-tab throttling changes display frequency, rather than the actual recorded duration.
5. Browser tabs refresh immediately through `BroadcastChannel`; devices refresh every 15 seconds while visible, on focus and on return to the page. This is polling, not the WebSocket requirement.
6. Saving reuses the existing `time_entries` database triggers, which check current roles, matter/team access, clearance and the rate for the chosen work date.
7. A receipt links the timer to one time entry. Repeating identical details returns that entry; changing the details after consumption produces a conflict. A failed audit rolls back the time entry, receipt and timer reset together.
8. The user reviews rounded minutes and chooses the matter/date/description before saving. A manual entry leaves the separate timer intact. Sessions longer than 24 hours cannot be consumed as one day: record separate daily entries manually and reset after reviewing them. The API preserves the long timer rather than silently truncating it.

The toolbar stores no authentication token or timer authority in browser storage. It adjusts the clock display using server time. The API is the authority when changes are submitted.

### Reproduce verification

Start Docker Desktop and the local dependencies using the existing setup instructions. Then run:

```powershell
npm run typecheck -w @practice/api
npm run typecheck -w @practice/web
npm test -w @practice/api -- --run src/workspace/workspace.controller.spec.ts
npm test -w @practice/api -- --run src/finance/finance.controller.spec.ts src/workspace/workspace-metrics.spec.ts
npm run build -w @practice/api
npm run build -w @practice/web
```

For the browser journey, use the existing isolated `pms_e2e` database. Preparing it recreates that test database; it does not reset the development database:

```powershell
cd apps/web
node e2e/prepare-database.mjs
npx playwright test work-timer.spec.ts --project chromium --workers=1
```

The new GitHub Actions workflow runs the source checks, both builds, real API/database tests and browser suite with disposable configuration. Its first hosted run remains to be observed; a locally passing build does not prove a hosted CI job has passed.

## Next implementation: matter expenses and billing sources

Read [the expense review](../reviews/2026-10-31-expenses.md), then migration `0082_matter_expenses.sql`. The web form submits reviewed details to the API, which supplies the authenticated actor to a protected PostgreSQL function. Money is stored as integer pence. The entry cannot be edited or deleted; a separate void record preserves the original and the correction reason.

The optional receipt is a foreign key to a document version, rather than the current document. A later upload therefore cannot change the evidence originally relied on. Receipt choices use both financial and document access checks: being allowed to see an expense does not grant permission to open every document.

When Accounts selects an expense in a draft, its ID travels with the line. SQL checks that the matter, amount, kind, narrative and VAT treatment still match and that the entry is billable and unvoided. On issue, the invoice retains that source ID. The unique constraint on issued sources prevents two competing drafts from charging the same expense. The issuing transaction and the void function lock the expense so only one outcome can commit.

To follow the workflow, open a cleared matter, upload a receipt through Documents, and use **Expenses and disbursements** to record the cost. In **Matter finance**, select the recorded expense in a draft bill. The linked amount is fixed. Review and issue, then confirm that the expense shows **Billed**. For an unbilled mistake, expand **Void expense** and enter a reason. A billed mistake uses a credit note.

Run the focused tests with:

```powershell
npm test -w @practice/api -- --run src/finance/billing.controller.spec.ts src/finance/billing.migration.spec.ts src/auth/permissions/permissions.spec.ts src/workspace/workspace.controller.spec.ts
```

After building both applications and preparing the isolated browser database as above:

```powershell
cd apps/web
npx playwright test expenses.spec.ts work-timer.spec.ts --project chromium --workers=1
```

## Work that remains

Keep the rest of the checklist open. A useful implementation order is contact/intake CRM; document templates and workflows; approved compliance rules and challenges; exact decision snapshots, cryptographic chains and independent verification; then reporting and provider adapters. Each feature needs a persistent model, backend authorization, a usable screen and tests for both success and refusal.

For compliance rules, implement a draft/review/approve/version lifecycle before activating risk weights or deadline calculations. The source document's proposed rules are requirements to review, not verified regulatory content. Keep manual reasoning fully usable while AI and provider connections remain undecided.

The requested Prisma layer differs from the established Kysely design. Replacing the database layer is still an open architecture item. Preserve the existing protected database functions and finance/compliance transaction guarantees during any migration.
