# API

**Current state (2026-10-13):** Health, authentication, staff management,
clients, matters, documents, portal access and the read-only client portal API
are built. Tasks and Notifications are built. Finance steps 14a to 14f add
rates, time and billing plus the encrypted bank register, receipts, allocation
corrections, derived ledger/cash-book APIs and the client-payment request,
approval and bank-outcome workflow, safe bank-statement imports, immutable
matching, client reconciliation, Compliance sign-off, five-week status, safe
exports and the capability response used by the staff Finance workspace.
Compliance steps 15a to 15f add firm controls, versioned CDD, risk and clearance,
gate enforcement, sanctions screening/freezes/licences, and separately encrypted
nominated-officer restricted reports and SAR/DAML records, plus retention,
disposal, fixed regulatory exports and the staff-screen capability responses.
People / HR steps 16a to 16f add the safe directory, self-service and
current-manager projections, protected employment/work-pattern history, exact
leave records, reason-free sickness, restricted health and separately shaped
operational adjustments, lifecycle checklists, versioned right-to-work evidence
and professional-status records, development cycles, required learning,
objectives and appraisals, membership-scoped confidential cases, category
retention/disposal, reviewed fixed exports, and the live capability and direct-
report lists used by the staff screens.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/matters/:matterId/expenses?before=UUID` | `finance.matter.view`; team or firm-finance access | Paginated expense records, void history, bill links and presentation capabilities |
| GET | `/matters/:matterId/expenses/receipt-options` | Financial record access plus existing document/team permission | Up to 100 latest document versions available as receipts; does not broaden document access |
| POST | `/matters/:matterId/expenses` | `expenses.record`; team or Accounts | Record a dated GBP recharge/disbursement with request UUID, chosen VAT treatment, billable flag and optional exact receipt version |
| POST | `/matters/:matterId/expenses/:expenseId/void` | `expenses.record`; team or Accounts | Append a reasoned void for an unbilled expense; billed entries require credit notes |
| GET | `/hr/access` | `hr.directory`; every active staff role | Presentation-only HR capabilities, linked person id and current direct-report count; route/database checks remain authoritative |
| GET | `/hr/directory` | `hr.directory`; every active staff role | Safe staff directory: work identity, current job title, team and location only |
| GET | `/hr/reports` | Active staff; current effective reporting lines in PostgreSQL | At most 500 safe direct-report directory rows; inactive engagements and superseded assignments disappear immediately |
| GET | `/hr/me` | Active staff with a linked personnel record | Own filtered personnel record, history, correction requests and worker-visible files |
| PUT | `/hr/me/contact` | Active staff; own record in PostgreSQL | Append a new encrypted personal/contact version; never edits history |
| POST | `/hr/me/corrections` | Active staff; own record in PostgreSQL | Append an encrypted correction request for HR review |
| GET | `/hr/reports/:personId` | Active staff; current effective manager in PostgreSQL | Bounded direct-report employment/work-pattern projection; no contact, private data, corrections or files |
| GET | `/hr/people` | `hr.manage` and live HR role | Safe HR personnel list |
| POST | `/hr/people` | `hr.manage` and live HR role | Link one personnel record to a staff account, optionally with encrypted contact/private details |
| GET | `/hr/people/:personId` | `hr.manage` and live HR role | Full HR-managed record; sensitive reads are audited |
| PUT | `/hr/people/:personId/contact` | `hr.manage` and live HR role | Append encrypted contact details |
| PUT | `/hr/people/:personId/private` | `hr.manage` and live HR role | Append encrypted private details |
| POST | `/hr/people/:personId/engagements` | `hr.manage` and live HR role | Create a non-overlapping engagement plus its first terms and minute-based work pattern |
| POST | `/hr/people/:personId/terms` | `hr.manage` and live HR role | Append effective-dated job title, team and work-location terms |
| POST | `/hr/people/:personId/work-patterns` | `hr.manage` and live HR role | Append an effective-dated IANA-time-zone and weekday-minute pattern |
| POST | `/hr/people/:personId/manager` | `hr.manage` and live HR role | Append an effective-dated assignment or clearing; cycles and inactive managers are refused |
| POST | `/hr/people/:personId/end-engagement` | `hr.manage` and live HR role | End an engagement once and encrypt the reason; does not disable the account or change roles |
| GET | `/hr/corrections` | `hr.manage` and live HR role | HR correction queue with decrypted request/decision text |
| POST | `/hr/people/:personId/corrections/:requestId/decision` | `hr.manage` and live HR role | Append the sole encrypted resolved/rejected decision |
| POST | `/hr/people/:personId/files` | `hr.manage` and live HR role | Inspect, malware-scan and encrypt one private HR file in the `hr/` namespace |
| GET | `/hr/people/:personId/files/:fileId/content` | Live HR role, or the subject when worker-visible | Audited streaming download with attachment, no-store, nosniff and sandbox headers |
| GET / POST | `/hr/leave/policies` | `hr.leave` and live HR role | Read versioned policy evidence or append the next effective policy |
| GET | `/hr/leave/requests` | `hr.leave` and live HR role | Pending firm-wide leave queue with encrypted reasons decrypted only in the HR response |
| POST | `/hr/leave/requests/:requestId/decision` | Active staff; PostgreSQL requires current manager for ordinary annual leave or HR for any category | Append approved/refused decision; self-approval, repeat decisions, overlap and insufficient balance are refused |
| POST | `/hr/leave/requests/:requestId/cancel` | Subject or live HR role in PostgreSQL | Append cancellation and, for consumed annual leave, an exact entitlement return |
| GET / POST | `/hr/me/leave` | Active staff with linked personnel record | Own requests, derived balance, ledger, holiday-pay evidence and reason-free sickness; submit own request |
| GET | `/hr/reports/:personId/leave` | Current effective manager in PostgreSQL | Direct-report requests, derived balance and reason-free sickness; no ledger notes or holiday pay |
| GET / POST | `/hr/people/:personId/leave` | `hr.leave` and live HR role | Full leave record or HR-submitted request for the person |
| POST | `/hr/people/:personId/leave/entitlement` | `hr.leave` and live HR role | Append a signed integer-minute grant, accrual, adjustment, carry-over or leaving adjustment |
| POST | `/hr/people/:personId/leave/holiday-pay` | `hr.leave` and live HR role | Store immutable payroll-supplied total/component pence, period and basis; components must reconcile, but Stass never calculates the lawful rate |
| POST | `/hr/people/:personId/sickness` | Active staff; current manager or HR in PostgreSQL | Record dates, notification and operational fitness only; strict input has no medical-reason field |
| GET | `/hr/me/health` | Subject account in PostgreSQL | Own separately encrypted health evidence |
| GET / POST | `/hr/people/:personId/health` | `hr.health` and live HR role | Audited restricted health read or append-only health evidence |
| GET / POST | `/hr/me/adjustments` | Subject account in PostgreSQL | Own private request/decision/progress history or submit a private request |
| GET | `/hr/reports/:personId/adjustments` | Current effective manager in PostgreSQL | Operational instruction and progress only; request grounds/private decision are null |
| GET | `/hr/people/:personId/adjustments` | `hr.health` and live HR role | Audited full private and operational adjustment history |
| POST | `/hr/adjustments/:requestId/decision` | `hr.health` and live HR role | Append an accountable agreed/refused decision; agreed records require a separate operational instruction |
| POST | `/hr/adjustments/decisions/:decisionId/progress` | Current manager or live HR in PostgreSQL | Append implementation/review; only HR may close |
| GET | `/hr/me/lifecycle` | Active staff with linked personnel record | Own lifecycle checklists and item states |
| GET | `/hr/reports/:personId/lifecycle` | Current effective manager in PostgreSQL | Direct report's lifecycle checklist and item states |
| GET / POST | `/hr/people/:personId/lifecycle` | `hr.manage` and live HR role | Full lifecycle history or a joiner/mover/leaver checklist tied to an engagement |
| POST | `/hr/lifecycle/items/:itemId/events` | `hr.manage` and live HR role | Append encrypted completion/reopening evidence for one item |
| POST | `/hr/lifecycle/:checklistId/events` | `hr.manage` and live HR role | Complete/reopen a checklist; required items, current right-to-work and leaver blockers are enforced in PostgreSQL |
| GET | `/hr/lifecycle/:checklistId/blockers` | `hr.manage` and live HR role | Safe ids/statuses for unresolved account, protected-role, client, matter, task or AML ownership; read-only to HR |
| GET | `/hr/me/vetting` | Active staff with linked personnel record | Own safe current right-to-work status and professional records; no right-to-work evidence/detail history |
| GET | `/hr/reports/:personId/vetting` | Current effective manager in PostgreSQL | Expiry/action and public professional status only; sensitive right-to-work and professional fields are null |
| GET | `/hr/people/:personId/vetting` | `hr.vetting` and live HR role | Audited full right-to-work history plus qualifications and professional checks |
| GET | `/hr/vetting/due` | `hr.vetting` and live HR role | Latest failed/follow-up-required or next-30-day right-to-work expiry/follow-up items |
| POST | `/hr/people/:personId/right-to-work` | `hr.vetting` and live HR role | Append a serialized right-to-work version linked to the same person's encrypted identity file |
| POST | `/hr/people/:personId/professional-records` | `hr.competence` and live HR role | Append an encrypted qualification, registration or practising-certificate record |
| POST | `/hr/professional-records/:recordId/checks` | `hr.competence` and live HR role | Append a dated, encrypted-source professional-status check |
| GET | `/hr/me/competence` | Active staff with linked personnel record | Own development, required learning, objectives/appraisals and safe AML-training status |
| GET | `/hr/reports/:personId/competence` | Current effective manager in PostgreSQL | Direct report's competence and review record; AML projection excludes provider/evidence/control content |
| GET | `/hr/people/:personId/competence` | `hr.competence` and live HR role | Audited full competence record with the same narrow AML-training projection |
| POST | `/hr/me/development` | Subject account in PostgreSQL | Create an own development cycle |
| POST | `/hr/reports/:personId/development` | Current effective manager in PostgreSQL | Create a direct report's development cycle |
| POST | `/hr/people/:personId/development` | `hr.competence` and live HR role | Create a person's development cycle |
| POST | `/hr/development/:cycleId/events` | Subject, current manager or HR according to event kind | Worker appends reflection/need/plan/activity/evaluation; manager/HR appends review/requirement/status |
| POST | `/hr/people/:personId/learning-assignments` | `hr.competence` and live HR role | Assign required learning with encrypted detail and due date |
| POST | `/hr/learning-assignments/:assignmentId/events` | Subject or live HR role in PostgreSQL | Append completion/reopening evidence; manager substitution and future completion are refused |
| POST | `/hr/reports/:personId/reviews` | Current effective manager in PostgreSQL | Record an immutable objective or appraisal statement for a direct report |
| POST | `/hr/people/:personId/reviews` | `hr.competence` and live HR role | Record an immutable objective or appraisal statement |
| POST | `/hr/reviews/:reviewId/worker-events` | Subject account in PostgreSQL | One-time acknowledgement or append-only worker response/disagreement |
| GET | `/hr/cases` | Active staff; current case membership in PostgreSQL | At most 500 neutral assigned-case summaries; HR role alone discloses nothing |
| POST | `/hr/cases` | `hr.cases` and live HR role | Open an encrypted grievance, disciplinary or capability case and become its first HR case member |
| GET | `/hr/cases/:caseId` | Active staff; current explicit case membership | Audited encrypted issue, membership and append-only event history; hidden ids answer 404 |
| POST | `/hr/cases/:caseId/members` | Current live HR case member | Assign an active investigator, decision-maker, appeal officer or HR member; incompatible roles require encrypted justification |
| POST | `/hr/case-memberships/:membershipId/end` | Current live HR case member | End membership once; the final live HR case owner cannot be removed |
| POST | `/hr/cases/:caseId/events` | Current case member; event-specific database role | Append encrypted evidence/meeting/response/notice/action/correction, decision-maker outcome, appeal-officer appeal or HR status |
| GET | `/hr/cases/:caseId/accesses` | Current live HR case member | Latest 1,000 protected view/export access records without case content |
| GET / POST | `/hr/retention/rules` | `hr.retention` and live HR role | Read versioned category rules or append the next version; leave is at least 72 months and right-to-work at least 24 |
| GET / POST | `/hr/retention/schedules` | `hr.retention` and live HR role | List schedules or record encrypted evidence against the database-derived latest source date |
| GET | `/hr/retention/schedules/:scheduleId` | `hr.retention` and live HR role | Decrypted schedule evidence and permanent legal-hold history |
| POST | `/hr/retention/schedules/:scheduleId/legal-holds` | `hr.retention` and live HR role | Append imposed/reviewed/released with encrypted authority/reason and the required review date |
| POST | `/hr/retention/schedules/:scheduleId/dispose` | `hr.retention` and live HR role | Recheck due/source/engagement/hold state under locks, remove eligible HR content/objects/exports and retain content-free tombstones |
| GET | `/hr/retention/disposals` | `hr.retention` and live HR role | Safe prepared/completed disposal history with category, rule version and count |
| GET / POST | `/hr/exports` | `hr.export` and live HR role | List visible fixed bundles or prepare one for worker access, litigation or a regulator from explicit scopes |
| GET | `/hr/exports/:exportId/review` | `hr.export`; active HR and every included case membership | Integrity-checked review view of the fixed encrypted bundle before decision |
| POST | `/hr/exports/:exportId/decision` | `hr.export`; different active HR reviewer and included case memberships | Permanently approve or reject release with an encrypted review note |
| GET | `/hr/exports/:exportId/content` | Same live review boundary; approved only | Audited SHA-256-checked JSON attachment with private/no-store, nosniff and sandbox headers |
| POST | `/compliance/restricted-reports` | `aml.internal_report`; every active staff role | JSON report or multipart report followed by one protected attachment -> neutral `{receiptId,received}` only |
| GET | `/compliance/restricted-reports` | Current nominated officer + active Compliance, rechecked in PostgreSQL | 100 safe restricted-queue summaries; `before` continues the keyset page |
| GET | `/compliance/restricted-reports/:reportId` | Current nominated officer + active Compliance | Decrypted report, attachments, decision, external report and DAML/DATF history; records a protected access event |
| POST | `/compliance/restricted-reports/:reportId/decision` | Current nominated officer + active Compliance | `{externalReportRequired,legalGrounds,imposeHold}` -> the sole permanent decision and optional generic protected hold |
| POST | `/compliance/restricted-reports/:reportId/external-report` | Current nominated officer + active Compliance | Records a SAR/terrorist-financing filing only after a report-required decision; does not submit it externally |
| POST | `/compliance/restricted-reports/:reportId/external-report/:externalId/events` | Current nominated officer + active Compliance | Appends a received DAML/DATF status, encrypted legal basis/reference and any permitted activity |
| GET | `/compliance/restricted-reports/:reportId/attachments/:attachmentId/content` | Current nominated officer + active Compliance | Audited encrypted-file download with no-store/restrictive headers |
| GET | `/compliance/restricted-reports/:reportId/accesses` | Current nominated officer + active Compliance | Separate insert-only view/download access history |
| POST | `/compliance/restricted-reports/:reportId/exports` | Current nominated officer + active Compliance | Creates a fixed separately encrypted restricted JSON bundle for a recorded regulatory purpose |
| GET | `/compliance/restricted-reports/:reportId/exports/:exportId/content` | Current nominated officer + active Compliance | Integrity-checked restricted export download; records an `export` access event and uses attachment/no-store headers |
| GET | `/compliance/access` | `aml.approve` | `{canRestricted,attentionCount}` for the staff workspace. The count contains ordinary queues only and excludes restricted reports and linked holds |
| GET | `/compliance/clients` | `aml.approve` | At most 500 id/reference/kind/name choices for firm-wide Compliance forms; PostgreSQL rechecks the live role |
| GET/POST | `/compliance/retention` | `aml.retention` | List schedules, or record the evidenced relationship end, five-year regulation 40 rule and encrypted evidence; all matters must be closed |
| GET | `/compliance/retention/:scheduleId` | `aml.retention` | Schedule with decrypted evidence and its permanent legal-hold event history |
| POST | `/compliance/retention/:scheduleId/legal-holds` | `aml.retention` | Append `imposed`, `reviewed` or `released` with encrypted authority/reason and the required review date |
| POST | `/compliance/retention/:scheduleId/dispose` | `aml.retention` | Recheck due date, closed relationship, holds and officer boundary; delete stored objects and AML content, leaving content-free tombstones |
| GET | `/compliance/retention/disposals` | `aml.retention` | Safe prepared/completed disposal-run history and record counts |
| GET/POST | `/compliance/exports` | `aml.export` | List or create fixed encrypted ordinary AML JSON bundles; restricted material is never included |
| GET | `/compliance/exports/:exportId/content` | `aml.export` | Audited integrity-checked ordinary export download with attachment/no-store headers |
| POST | `/clients/:clientId/cdd` | `aml.assess`; visible client, or Compliance | `{intendedRelationship,reason}` -> the sole live versioned draft; 409 while another draft exists |
| GET | `/clients/:clientId/cdd` | `aml.view_evidence`; same record rule | `{cases,next}`: 100 safe summaries, newest first; `before` continues without identity or evidence detail |
| GET | `/clients/:clientId/cdd/:caseId` | `aml.view_evidence`; same record rule | Protected full CDD detail. Cross-client or hidden ids answer 404 |
| POST | `/clients/:clientId/cdd/:caseId/subjects` | `aml.assess`; draft | Add an encrypted individual or legal-entity identity and its relationship |
| POST | `/clients/:clientId/cdd/:caseId/ownership` | `aml.assess`; draft | Add a case-local ownership/control edge with optional percentage and encrypted control basis |
| POST | `/clients/:clientId/cdd/:caseId/authorities` | `aml.assess`; draft | Add verified authority for an authorised representative, linked to protected evidence |
| POST | `/clients/:clientId/cdd/:caseId/verifications` | `aml.assess`; draft | Add source, dates, method, outcome and evidence link; exact identifiers/provider/reliance detail is encrypted |
| POST | `/clients/:clientId/cdd/:caseId/evidence` | `aml.assess`; draft | Multipart metadata then one inspected, malware-scanned file, up to 50 MB; AML-encrypted and rate-limited |
| GET | `/clients/:clientId/cdd/:caseId/evidence/:evidenceId/content` | `aml.view_evidence`; same record rule | Audited protected attachment with no-store and restrictive headers |
| POST | `/clients/:clientId/cdd/:caseId/submit` | `aml.assess`; draft | Fix the complete case, client snapshot and five current approved firm-control versions; 409 if incomplete or final |
| POST | `/clients/:clientId/cdd/:caseId/abandon` | `aml.assess`; draft | Permanently close a mistaken draft with `{reason}` so a replacement version can be created; collected facts remain fixed |
| GET | `/compliance/country-lists` | `aml.firm_controls` | `{countryLists,next}`: 100 versions, newest first |
| GET | `/compliance/country-lists/pending-approval` | `aml.firm_approve` | Versions still awaiting approval |
| POST | `/compliance/country-lists` | `aml.firm_controls` | `{countries,source,effectiveFrom}` -> the next numbered version; codes are sorted and must be distinct |
| POST | `/compliance/country-lists/:listId/approval` | `aml.firm_approve` | A Partner other than the preparer approves once; 409 otherwise |
| POST | `/matters/:matterId/aml-risk` | `aml.assess`; matter team, or Compliance | Fix a permanent assessment version with scope, rating, factors, jurisdictions, value band, review plan and encrypted written answers; 409 when a database rule refuses it |
| GET | `/matters/:matterId/aml-risk` | `aml.view_evidence`; same record rule | `{assessments,next}`: 100 summaries without written answers |
| GET | `/matters/:matterId/aml-risk/:assessmentId` | `aml.view_evidence`; same record rule | Full assessment with decrypted answers and governing controls |
| POST | `/matters/:matterId/aml-risk/:assessmentId/measures` | `aml.assess`; matter team, or Compliance | Add a discrete CDD/EDD measure with an encrypted description; latest assessment of an open matter only |
| POST | `/matters/:matterId/aml-risk/:assessmentId/measures/:measureId/results` | `aml.assess`; same | Append `satisfied`/`not_satisfied` with encrypted reasoning and evidence from the relied-on CDD case |
| POST | `/matters/:matterId/aml-risk/:assessmentId/sources` | `aml.assess`; same | Append a source-of-funds/wealth conclusion: person, pence range, outcome, evidence, encrypted reasoning |
| GET | `/matters/:matterId/aml-risk/:assessmentId/work` | `aml.view_evidence`; same record rule | Measures with their results, and source conclusions |
| POST | `/matters/:matterId/aml-risk/:assessmentId/clearance` | `aml.approve` (Compliance) | `{decision,reasoning}`: one decision per assessment, never by its preparer; 409 when the work is incomplete or out of date |
| POST | `/matters/:matterId/aml-risk/:assessmentId/clearance/senior-approval` | `aml.firm_approve` (Partner) | Senior-management approval for a high-risk or PEP clearance, by a partner other than the preparer and approver |
| GET | `/matters/:matterId/aml-risk/:assessmentId/clearance` | `aml.view_evidence`; matter record rule | `{clearance}` or `{clearance: null}` |
| GET | `/matters/:matterId/aml-gate` | `aml.view_evidence`; matter record rule | `{state,dueSince,workAllowedUntil,clearanceId}` with state `pending`, `cleared` or `review_due` |
| GET | `/compliance/holds` | `aml.approve` | Active holds (`?all=true` for all), 100 at a time |
| POST | `/compliance/holds` | `aml.approve` | Hold one `matterId` or a whole `clientId` with an encrypted reason |
| POST | `/compliance/holds/:holdId/lift` | `aml.approve` | Lift a hold once, with an encrypted reason |
| GET | `/compliance/reviews` | `aml.approve` | `{matters,next}`: open matters pending, held, due, or due within 30 days; 100 at a time, newest first |
| POST | `/matters/:matterId/aml-risk/:assessmentId/start-exceptions` | `aml.approve` | Early start for time/documents, at most 30 days, low-risk only |
| POST | `/matters/:matterId/start-exceptions/:exceptionId/approval` | `aml.firm_approve` | A different partner approves the early start |
| GET | `/compliance/sanctions/status` | `aml.sanctions` | Active list version, report date, last success/failure and `fresh` |
| GET | `/compliance/sanctions/lists` | `aml.sanctions` | `{lists,next}`: imported versions, newest first |
| POST | `/compliance/sanctions/lists` | `aml.sanctions` | Upload the official CSV as multipart `file`: `imported` or `unchanged`; 409 for an older report, 422 for another file |
| POST | `/compliance/sanctions/clients/:clientId/screenings` | `aml.sanctions` | Screen the client record and its latest CDD subjects now; `{state}` |
| GET | `/compliance/sanctions/clients/:clientId` | `aml.sanctions` | `{state}`: `clear`, `unscreened`, `stale`, `possible_match` or `confirmed` |
| GET | `/compliance/sanctions/candidates` | `aml.sanctions` | `{candidates,next}`: unresolved candidates on each subject's latest screening |
| POST | `/compliance/sanctions/candidates/:candidateId/resolution` | `aml.sanctions` | `{outcome: false_positive or confirmed, reasoning}` once; returns the client's new `{state}` |
| POST | `/compliance/sanctions/licences` | `aml.sanctions` | Record a licence for a confirmed designation; money only with a pence limit |
| POST | `/compliance/sanctions/licences/:licenceId/revocation` | `aml.sanctions` | Revoke a licence once, with an encrypted reason |
| GET | `/compliance/sanctions/licences?clientId=` | `aml.sanctions` | The client's licences with decrypted conditions |
| GET | `/compliance/sanctions/frozen-funds?clientId=` | `aml.sanctions` | Balances frozen on confirmation and receipts frozen on arrival |
| GET | `/matters/:matterId/money-status` | `finance.view_all` | `allowed`, `frozen` or `contact_compliance`, with any money licence's limit, use and expiry |
| POST | `/matters/:matterId/tasks` | `tasks.create` + team, open matter | `{title, description?, dueOn?, priority?, assigneeId}` -> 201 with the task. The assignee must be active on the same team; 404 outside the team, 409 matter or team state changed |
| GET | `/matters/:matterId/tasks` | `tasks.view` + team | `{tasks, next}`: 100 at a time, newest first; `?before=<next>` continues the list. 404 outside the team |
| GET | `/tasks/:taskId` | `tasks.view` + team | The task with assignee and creator display names and its oldest-first change history. 404 outside the team |
| PATCH | `/tasks/:taskId` | `tasks.manage` + team, open matter | Change one or more detail fields. 200 with the current task; 400 for empty, invalid or unknown fields; 404 outside the team; 409 if state changed meanwhile |
| PUT | `/tasks/:taskId/assignee` | `tasks.manage` + team, open matter | Reassign to an active member of the same team. 200 with the current task; 409 for an invalid assignee or changed state |
| POST | `/tasks/:taskId/complete` | `tasks.manage` + assignee or supervising partner, open matter | Mark open task completed. 204; repeating the current state is a no-op |
| POST | `/tasks/:taskId/cancel` | `tasks.manage` + assignee or supervising partner, open matter | Mark open task cancelled. 204; a completed task must be reopened first |
| POST | `/tasks/:taskId/reopen` | `tasks.manage` + assignee or supervising partner, open matter | Reopen a completed or cancelled task. 204; repeating the current state is a no-op |
| POST | `/finance/rates` | `rates.manage` | `{accountId, hourlyRate, effectiveFrom}` -> 201 with the permanent rate. Money is an exact string such as `"250.00"`; 409 for a duplicate date or ineligible account |
| GET | `/finance/rate-accounts` | `rates.manage` | Active partners and fee earners eligible for a future rate, with display names and eligible roles |
| GET | `/finance/rates` | `finance.view_all` | `{rates, next}`: 100 at a time, newest first. Optional `accountId`; `before` continues the list |
| POST | `/matters/:matterId/time-entries` | `time.record` + current team, open matter | `{workedOn, minutes, description}` -> 201 with the entry and database-selected rate. Records only the caller's own time; 409 if no rate applies or state changed |
| GET | `/matters/:matterId/time-entries` | `finance.matter.view` + team, or `finance.view_all` | `{timeEntries, next}`: 100 safe summaries at a time. Private descriptions and correction reasons are omitted |
| GET | `/time-entries/:entryId` | Same record rule as the matter list | Full entry and oldest-first correction history; 404 when hidden |
| POST | `/time-entries/:entryId/corrections` | `time.record` + original worker and current team | `{reason, replacement}` where replacement is a full date/minutes/description value or `null` to void. Returns the full current entry; a no-op adds no history |
| POST | `/matters/:matterId/bill-drafts` | `bills.manage`, open matter | `{taxPoint, dueOn, supplier, lines[1..100]}` -> 201 with the draft and exact net, VAT and gross strings. A line may link available time from the same matter |
| GET | `/finance/bill-drafts` | `bills.manage` | `{drafts,next}`: 100 newest unissued drafts with matter/client labels and totals for the Accounts queue |
| GET | `/bill-drafts/:draftId` | `bills.manage` | The mutable draft with lines and totals; 404 once it has been issued |
| PUT | `/bill-drafts/:draftId` | `bills.manage` | Replace the complete mutable draft. 409 if it was issued or state changed meanwhile |
| POST | `/bill-drafts/:draftId/issue` | `bills.manage` | Create the permanent numbered bill snapshot. 201 with the bill; 409 if already issued, linked time was voided/reused, or required billing data is missing |
| GET | `/matters/:matterId/bills` | `finance.matter.view` + team, or `finance.view_all` | All issued bill summaries for the matter, newest number first. Narratives and client details are omitted; 404 when hidden |
| GET | `/bills/:billId` | Same record rule as the matter bill list | Full permanent bill snapshot; 404 when hidden |
| POST | `/bills/:billId/credit-notes` | `bills.manage` | `{reason, lines[1..100]}` -> 201 with a permanent numbered credit note. Each exact net amount names an original bill line and cannot exceed its uncredited balance |
| GET | `/credit-notes/:creditNoteId` | Same record rule as its bill | Full permanent credit note; 404 when hidden |
| POST | `/bills/:billId/deliveries` | `bills.manage` | Record a permanent delivery event with `{method, note}`; does not send the bill |
| POST | `/credit-notes/:creditNoteId/deliveries` | `bills.manage` | Record a permanent delivery event with `{method, note}`; does not send the credit note |
| GET | `/bills/:billId/content` | Same record rule as the bill | Audited UTF-8 text attachment generated from the fixed snapshot, with no-store and restrictive content headers |
| GET | `/credit-notes/:creditNoteId/content` | Same record rule as the credit note | Audited UTF-8 text attachment generated from the fixed snapshots, with the same safe headers |
| POST | `/finance/bank-accounts` | `client_money.record` | `{kind,name,sortCode,accountNumber,openedOn}` -> 201 with safe register fields only. Full details are encrypted and never returned; 409 for a duplicate or invalid live state |
| GET | `/finance/bank-accounts` | `finance.view_all` | `{bankAccounts}` with safe name, kind, last four digits and opening/closure dates; no full bank details |
| GET | `/finance/access` | `finance.view_all` | Live action capabilities for the Finance UI. These booleans only control presentation; every action route still checks its permission and database rules |
| POST | `/finance/bank-accounts/:bankAccountId/close` | `client_money.record` | `{closedOn,reason}` -> 201 with the permanently closed safe register record; 409 if already closed or the date is invalid |
| POST | `/finance/receipts` | `client_money.record` | `{bankAccountId,matterId,receivedOn,amount,reference,purpose}` -> 201 with the immutable client/business transaction and exact amount string |
| POST | `/finance/allocations` | `client_money.record` | `{side,sourceMatterId,targetMatterId,amount,reason}` -> 201 with the immutable same-client correction; client money cannot be over-allocated |
| GET | `/finance/matters/:matterId/ledger` | `finance.view_all` | Derived client/business balances and 100 newest postings. `before` continues the list |
| GET | `/finance/matters/:matterId/ledger/export` | `finance.view_all` | Audited UTF-8 CSV of every posted ledger entry, with formula-like cells made literal and restrictive attachment headers |
| GET | `/finance/bank-accounts/:bankAccountId/cash-book` | `finance.view_all` | Safe bank register record, derived balance and 100 newest bank postings. `before` continues the list |
| GET | `/finance/bank-accounts/:bankAccountId/cash-book/export` | `finance.view_all` | Audited formula-safe UTF-8 CSV of every posted cash-book entry |
| POST | `/finance/payment-requests` | `client_money.request` | Request a `refund` or `third_party` payment with encrypted `{name,sortCode,accountNumber}`, or a `costs_transfer` naming a business account and issued bill. All kinds name the matter, client bank account, evidence document, purpose and exact `amount` |
| GET | `/finance/payment-requests` | `finance.view_all` | `{paymentRequests,next}`: 100 safe requests at a time, newest first. Includes permanent state events but never payee details or encryption fields |
| GET | `/finance/payment-requests/:paymentRequestId` | `finance.view_all` | One safe request and its oldest-first events; no payee details |
| GET | `/finance/payment-requests/:paymentRequestId/payee` | `client_money.record` | Audited decrypted payee details for a pending or approved external payment only; 409 after a terminal event or for a costs transfer |
| POST | `/finance/payment-requests/:paymentRequestId/approve` | `client_money.approve`, different Accounts holder | `{}` -> approved request. Rechecks evidence, bank history, unreserved client balance and any billed-cost balance |
| POST | `/finance/payment-requests/:paymentRequestId/reject` | `client_money.approve`, different Accounts holder | `{reason}` -> rejected request |
| POST | `/finance/payment-requests/:paymentRequestId/cancel` | `client_money.request`, original requester | `{reason}` -> cancelled pending or approved request and releases any reservation |
| POST | `/finance/payment-requests/:paymentRequestId/paid` | `client_money.record` | `{bankReference,occurredOn}` -> paid request and immutable balanced postings; a billed-cost transfer also posts the business side |
| POST | `/finance/payment-requests/:paymentRequestId/bank-rejected` | `client_money.record` | `{reason}` -> terminal bank-rejected request and releases its reservation without posting money |
| POST | `/finance/statement-imports` | `finance.reconcile` | Multipart fields `bankAccountId`, `periodStart`, `periodEnd`, `openingBalance`, `closingBalance`, then one UTF-8 CSV `file`. Exact header `date,amount,reference,description`; 5 MB/10,000-row limits; 409 for a duplicate or unbalanced statement |
| GET | `/finance/statement-imports` | `finance.view_all` | `{statements,next}`: 100 safe immutable imports with rows and match/reversal history; hashes and fingerprints are omitted |
| GET | `/finance/statement-imports/:statementImportId` | `finance.view_all` | One safe import with signed decimal-string balances and rows |
| POST | `/finance/statement-rows/:statementRowId/matches` | `finance.reconcile` | `{financeTransactionId}` -> permanent match id; account, signed amount, date and reference must equal the posted bank transaction |
| POST | `/finance/statement-matches/:statementMatchId/reverse` | `finance.reconcile` | `{reason}` -> permanent reversal id. The original remains visible in row history |
| POST | `/finance/reconciliations` | `finance.reconcile` | `{asOf,statementImportIds,explanations}` -> immutable server-calculated client reconciliation. Requires one statement per open client account and an explanation for every outstanding item/difference |
| GET | `/finance/reconciliations` | `finance.view_all` | `{reconciliations,next}`: 100 newest fixed snapshots and sign-off state |
| GET | `/finance/reconciliations/status` | `finance.view_all` | Statement deadlines for open client/business accounts and the firm-wide signed client-reconciliation deadline; warns during the last seven of 35 days |
| GET | `/finance/reconciliations/:reconciliationId` | `finance.view_all` | One snapshot with three totals, two differences, selected statement ids, outstanding items/explanations and sign-off |
| GET | `/finance/reconciliations/:reconciliationId/export` | `finance.view_all` | Audited formula-safe UTF-8 CSV generated from that fixed snapshot |
| POST | `/finance/reconciliations/:reconciliationId/sign-off` | `finance.reconciliation_sign_off`, different Compliance holder | `{}` -> signed snapshot; prepared-but-unsigned work does not satisfy status |
| GET | `/health` | Public | Liveness check for load balancers and monitoring |
| POST | `/auth/sign-in` | Public | Email and password. 200 `{"next":"two_factor"}` with a session cookie waiting for 2FA, 401 `Email or password is incorrect` for every kind of failure, or 429 after too many failures from the caller's network address |
| POST | `/auth/two-factor` | Public, but needs a session waiting for 2FA | `{"code"}`: a 6-digit authenticator code or a backup code. 200 `{"account"}` with a new session cookie. 401 `The code is incorrect` (try again) or `Please sign in again` (no waiting sign-in, 5 wrong codes, or account blocked) |
| POST | `/auth/invitations/inspect` | Public, needs invitation token | `{"token"}` → `{email, displayName, kind}` or 404 |
| POST | `/auth/invitations/password` | Public, needs invitation token | `{"token","password"}` → `{"twoFactor": {secret, uri}}`, or 400 with the reasons the password was refused |
| POST | `/auth/invitations/complete` | Public, needs invitation token | `{"token","code"}` → `{"backupCodes": [10 codes]}`, shown once. Activates the account |
| POST | `/auth/password-reset/request` | Public | `{"email"}` → always 204 |
| POST | `/auth/password-reset/complete` | Public, needs reset token | `{"token","password"}` → 204, 404 (invalid or expired link), or 400 with the reasons the password was refused |
| GET | `/auth/session` | Any signed-in account | The signed-in account: id, kind, display name |
| POST | `/auth/sign-out` | Public | Ends the current session if there is one, clears the cookie. Always 204 |
| GET | `/staff` | `staff.view` | `{"staff": [{id, email, displayName, status, roles}]}`: every staff account, including invited and disabled |
| POST | `/staff/invitations` | `staff.invite` | `{"email","displayName"}` → 201 `{accountId, expiresAt}`. Inviting someone already invited sends a fresh link. 409 if the address already has an active, disabled or client account |
| PUT | `/staff/:accountId/roles/:role` | `staff.roles.manage` | Grants a role. 204, also when already held. 403 on your own account, 404 not a staff account, 409 account disabled |
| DELETE | `/staff/:accountId/roles/:role` | `staff.roles.manage` | Revokes a role. 204, also when not held. 403 on your own account, 404 not a staff account, 409 last active administrator or compliance holder |
| POST | `/staff/:accountId/disable` | `staff.disable` | Disables the account and ends its sessions. 204, also when already disabled. 403 on your own account, 404 not a staff account, 409 last active administrator or compliance holder |
| POST | `/staff/:accountId/enable` | `staff.disable` | Re-enables a disabled account: it becomes invited, its password is removed and a new invitation is emailed. 200 `{expiresAt}`. 403 on your own account, 404 not a staff account, 409 not disabled |
| POST | `/clients` | `clients.create` | Creates an individual or organisation client ([clients.md](clients.md#api)). 201 `{id, reference}`. 400 for any unknown field |
| GET | `/clients` | `clients.view` | `{"clients": [{id, reference, kind, name}], "next"}`: the clients you can see, 50 at a time, newest first. `?before=<next>` for the following page |
| GET | `/clients/search?q=` | `clients.search` | `{"clients": [{id, reference, kind, name}]}`: up to 20 clients of the whole firm by reference or part of the name. `q` 2 to 100 characters. 60 searches per person per hour, then 429 with `Retry-After` |
| GET | `/clients/:clientId` | `clients.view` + visibility | The client's details. 404 if it does not exist or the caller may not see it |
| PATCH | `/clients/:clientId` | `clients.edit` + visibility | `{"kind", ...fields to change}` → 200 with the client. 400 for unknown fields, nothing to change, or the wrong `kind`; 404 as for GET |
| POST | `/clients/:clientId/contacts` | `clients.edit` + visibility | `{givenNames, familyName, jobTitle?, email?, phone?}` → 201 `{id}`. 404 as for GET, 409 for an individual client |
| PATCH | `/clients/:clientId/contacts/:contactId` | `clients.edit` + visibility | Fields to change, or `active` → 200 with the contact. 404 unless the contact belongs to this client and the caller may see it |
| POST | `/matters` | `matters.open` | `{clientId, title, matterType, supervisingPartnerId, feeEarnerIds?, conflictCheckId, parties?}` → 201 `{id, reference, status}`; status is `awaiting_clearance` if the check found any possible match. The opener joins the team. 404 client not visible; 400 supervising partner or team member not allowed, check not usable (not yours, other client, over 24 hours old, already used), or a party not in the check |
| POST | `/conflict-checks` | `matters.open` | `{clientId, names[1..20]}` → 201 `{id, names, matches, matchCount, createdAt}`. The client's own name is added; up to 50 strongest matches, each with name, relation and references only. 404 client not visible, 429 over the hourly allowance shared with client search (one unit per name) |
| GET | `/matters/:matterId/conflict-check` | `matters.view` + team | The check the matter was opened on, and its clearance if any |
| POST | `/matters/:matterId/conflict-clearance` | `matters.supervise` + supervising partner | `{"reason"}` (10 to 500 characters) → 204: the matter opens. 403 not the supervising partner, 404 not on the team, 409 not awaiting clearance |
| GET | `/matters` | `matters.view` | `{"matters": [...], "next"}`: matters you are on the team of, 50 at a time, newest first. `?before=<next>` |
| GET | `/matters/:matterId` | `matters.view` + team | Details, client summary and team. 404 if not on the team |
| PATCH | `/matters/:matterId` | `matters.edit` + team | `{title?, matterType?}` → 200 with the matter. 409 closed |
| POST | `/matters/:matterId/close` | `matters.supervise` + supervising partner | `{"reason"}` → 204. Final. 403 not the supervising partner, 409 already closed or an open task remains |
| PUT | `/matters/:matterId/team/:accountId` | `matters.supervise` + supervising partner | Adds a fee earner. 204, also when already on the team. 400 not active staff who can work on matters |
| DELETE | `/matters/:matterId/team/:accountId` | `matters.supervise` + supervising partner | Removes a fee earner, who loses access at once. 204, also when not on the team. 409 for the supervising partner |
| POST | `/matters/:matterId/supervisor` | `matters.supervise` + supervising partner | `{accountId}` → 204: hands supervision to that partner; the previous one stays as a fee earner. 400 not an active partner |
| POST | `/matter-supervision-takeovers` | `matters.supervise` | `{matterReference, reason}` → 204: the caller becomes supervising partner. Works for matters the caller cannot see yet. 404 no such reference, 409 the supervising partner can still act |
| POST | `/matter-compliance-accesses` | `matters.access_with_reason` | `{matterReference, reason}` → 200 with the matter and its documents (newest 100), read-only, for this request only; recorded, and the supervising partner is emailed. 404 no such reference, 429 after 30 in an hour |
| POST | `/documents/:documentId/versions/:number/compliance-downloads` | `matters.access_with_reason` | `{reason}` → the file as an attachment; recorded as its own access and emailed to the supervising partner. 400 no reason, 404 no such version, 410 withdrawn, 429 after 30 accesses in an hour |
| GET | `/matters/:matterId/compliance-accesses` | `matters.supervise` + supervising partner | `{"accesses": [{id, accessedBy, reason, accessedAt, document}]}`; `document` is `{id, title, version}` for a download, else null. 403 not the supervising partner |
| GET | `/clients/:clientId/matters` | `matters.view` + client visibility | The client's matters you are on the team of |
| GET | `/matters/:matterId/documents` | `documents.view` + team | `{documents, next}`: 100 at a time, newest first, with each one's latest version. `?before=<next>` |
| GET | `/documents/:documentId` | `documents.view` + team | The document, its client-sharing setting and every version |
| GET | `/documents/:documentId/versions/:number/content` | `documents.view` + team | The file, as a download; recorded. See [documents.md](documents.md#api) |
| POST | `/documents/:documentId/versions` | `documents.add` + team, open matter | Multipart `file` → 201 with the new version, checked as a first upload |
| POST | `/documents/:documentId/withdrawal` | `documents.withdraw` + uploader or supervising partner | `{reason}` → 204. Final; the document is no longer listed or downloaded |
| PUT | `/documents/:documentId/client-sharing` | `documents.share` + team | Shares the document with the client → 204 |
| DELETE | `/documents/:documentId/client-sharing` | `documents.share` + team | Stops sharing the document → 204 |
| POST | `/matters/:matterId/documents` | `documents.add` + team, open matter | Multipart `title`, `category`, then `file` (PDF, Word, Excel, PowerPoint, text, email, JPEG, PNG; up to 50 MB) → 201. Scanned for malware and stored encrypted; see [documents.md](documents.md#api) for every refusal |
| POST | `/clients/:clientId/portal-access` | `portal.invite` + client visible | `{contactId?}` → 201: invites the client's person to the portal at the address on record. See [portal.md](portal.md#api) |
| GET | `/clients/:clientId/portal-access` | `portal.invite` + client visible | Who can see the client in the portal now |
| DELETE | `/clients/:clientId/portal-access/:linkId` | `portal.invite` + client visible | Ends that person's access → 204 |
| GET | `/portal/matters` | Client account + live portal link | Client-safe open and closed matters, 50 at a time; no matters awaiting conflict clearance |
| GET | `/portal/matters/:matterId` | Client account + live portal link | Reference, title, type, status, opened date and team names only. 404 outside the account's linked clients |
| GET | `/portal/matters/:matterId/documents` | Client account + live portal link | Shared, unwithdrawn documents, 100 at a time, with the latest version's metadata only |
| GET | `/portal/documents/:documentId/content` | Client account + live portal link | The latest shared version as a download; recorded with the client actor. No route exposes an earlier version |
| GET | `/colleagues` | `matters.open` | `{"colleagues": [{id, displayName, isPartner}]}`: active staff who can be put on a matter's team (partner or fee earner), by name. No email addresses or other roles |
| POST | `/clients/:clientId/take-over` | `clients.take_over` | `{"reason"}` (10 to 500 characters) → 204: the caller becomes responsible for the client. Works for clients the caller cannot see yet. 404 no such client, 409 the responsible person can still see the client (active and holding `clients.view`) |

`/health` returns exactly `{"status":"ok"}`. It must never return version
numbers, environment names, dependency status or anything else an attacker
could use to fingerprint the system.

## Cross-cutting behaviour

See [security.md](security.md#request-pipeline) for the full request pipeline.

## Writing a route

Every route declares who may call it, its input and its output. Without all three, it returns 500 and the handler never runs.

| Decorator | Who may call |
|---|---|
| `@Public()` | Anyone. Only for sign-in, sign-out and health |
| `@StaffOnly()` | Signed-in staff |
| `@ClientOnly()` | Signed-in clients |
| `@AnyAccount()` | Any signed-in account |
| `@RequirePermission('staff.invite')` | Signed-in staff holding a role with that permission (see [authorization.md](authorization.md)) |

A session waiting for its 2FA code counts as not signed in.

```ts
const createClientSchema = z.strictObject({ name: z.string().min(1).max(200) });
const clientSchema = z.object({ id: z.uuid(), name: z.string() });

@Post()
@StaffOnly()
@ResponseSchema(clientSchema)
create(@Body({ schema: createClientSchema }) body: z.infer<typeof createClientSchema>) {
  return this.clients.create(body);
}
```

- Request schemas: `z.strictObject` (unknown fields rejected).
- Response schemas: `z.object` (undeclared fields removed).
- Route IDs: `@Param('id', { schema: z.uuid() })`.

## Error format

```json
{ "statusCode": 403, "message": "You do not have access to this matter" }
{ "statusCode": 500, "message": "Internal Server Error", "reference": "<uuid>" }
```

## Running locally

```sh
cp apps/api/.env.example apps/api/.env
npm run build -w @practice/api
npm run start:local -w @practice/api
```
