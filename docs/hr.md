# People and HR

**Current state (2026-10-13):** First-version design approved. Steps 16a to
16e are built: separate HR authority, protected employment and lifecycle
history, encrypted personnel files/data and right-to-work evidence, exact leave
evidence, reason-free sickness administration, restricted health records,
bounded manager projections, versioned professional checks, development cycles,
required learning, objectives and appraisals, membership-scoped confidential
cases, category retention/disposal and reviewed fixed exports. Step 16f and the
final HR security review remain.

How Stass will keep the firm's employment records, staff lifecycle, absence,
professional-development and fair-process evidence without turning an ordinary
staff account or system administrator into an HR records administrator. Stass
will record workflow and evidence. It will not give employment-law advice,
calculate payroll, decide whether a person is fit to work, score people, or make
an employment decision.

## Regulatory and professional basis

This design was checked on 12 October 2026 against current primary and official
guidance:

- [ICO guidance on collecting and keeping employment records](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/employment-practices-and-data-protection-keeping-employment-records/collecting-and-keeping-employment-records/)
  requires a documented lawful basis and purpose, data minimisation, accuracy,
  category-specific retention, transparency and need-to-know access. Special
  category and criminal-offence data need additional conditions and safeguards;
  consent is often unsuitable in an employment relationship.
- [ICO guidance on workers' health information](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/information-about-workers-health/data-protection-and-workers-health-information/)
  calls for a particularly high level of security and separate access. Managers
  should normally receive only the fitness or adjustment information necessary
  to manage work, not diagnoses or medical evidence.
- [The current Home Office right-to-work checklist](https://www.gov.uk/government/publications/right-to-work-checklist/employers-right-to-work-checklist-accessible-version)
  requires the prescribed check before work, dated secure evidence, follow-up
  checks for time-limited permission, and retention throughout the engagement
  plus two years before secure destruction.
- [Working Time Regulations 1998, regulation 16B](https://www.legislation.gov.uk/uksi/1998/1833/regulation/16B)
  requires adequate annual-leave and holiday-pay records to be retained for six
  years from creation. [Current government holiday-pay guidance](https://www.gov.uk/holiday-entitlement-rights/holiday-pay)
  confirms that the record must cover leave and what was paid; different worker
  patterns have different calculation rules.
- [Equality Act 2010](https://www.legislation.gov.uk/ukpga/2010/15/section/20)
  and [government workplace-adjustment guidance](https://www.gov.uk/reasonable-adjustments-for-disabled-workers)
  require reasonable adjustments where the duty applies. The system must let
  the firm record an operational adjustment without exposing the underlying
  health information to everyone implementing it.
- [SRA Code of Conduct for Firms](https://www.sra.org.uk/solicitors/standards-regulations/code-conduct-firms)
  requires effective systems and records, fair and respectful treatment, and
  competent managers and employees whose professional knowledge remains
  current. [SRA continuing-competence guidance](https://www.sra.org.uk/continuing-competence)
  expects reflection, identified needs, a plan, a record of activity and an
  evaluation rather than a bare training-hours total.
- [Acas Code of Practice on disciplinary and grievance procedures](https://www.acas.org.uk/acas-code-of-practice-on-disciplinary-and-grievance-procedures/html)
  sets the fairness baseline: act promptly and consistently, investigate,
  explain the case, let the employee respond and be accompanied, and provide an
  appeal. Employment tribunals take the Code into account.

These rules and the firm's employment terms can change. They must be checked
again during the module's security review and before production. This design is
not legal advice. Before enabling each record category, the firm must document
its purpose, Article 6 basis, any Article 9 or DPA 2018 Schedule 1 condition,
retention rule, privacy information and responsible owner.

## Decisions

| Topic | Proposed decision | Why |
|---|---|---|
| Domain boundary | An employment record is linked one-to-one to a staff account, but account access and employment status remain separate | HR cannot quietly grant system access, and an Administrator cannot gain personnel-file access merely by managing accounts |
| Workforce | Support employees, workers, LLP/equity partners, consultants, apprentices and trainees through versioned engagements | A law firm's workforce is wider than employees, and statutory rights differ by relationship |
| HR authority | Add a separate `hr` role with no client, matter, finance, audit or AML access by default | Personnel access is a distinct need-to-know duty, not an Administrator or Partner privilege |
| Self-service | Every active staff member can read a safe version of their own current record and request corrections; direct editing is limited to personal contact and emergency-contact fields | Self-service improves accuracy without letting a person rewrite contracts, checks, leave decisions or history |
| Line managers | Effective-dated reporting lines give a manager narrowly scoped access to direct reports' work pattern, leave, operational adjustments, objectives and competence work | A manager needs enough to manage; they do not need pay, identity documents, diagnoses, grievance evidence or all HR notes |
| Record classes | Separate directory, ordinary personnel, compensation, right-to-work, health/adjustment and case records, each with its own response shape and access rule | One broad “personnel file” endpoint would inevitably over-disclose sensitive data |
| Encryption | Use a new `HR_ENCRYPTION_KEY` for sensitive structured fields and to wrap one random key per private file; bind every ciphertext to record id and purpose | A copied database or object store must not reveal addresses, pay, identity checks, health facts or case material |
| Employment history | Engagement terms, manager changes, compensation, working patterns and departures are effective-dated append-only events; corrections supersede with a reason | The firm must be able to show what applied at a past date without silently rewriting it |
| Leave units | Store working patterns and entitlements as integer minutes, with UK local dates; never binary floating point or a universal “days” conversion | Part-time and non-standard patterns need exact, auditable calculations |
| Holiday pay | Keep the leave event plus an immutable payroll-supplied pay record in pence and its calculation basis; Stass does not calculate normal pay | The legal evidence is kept without duplicating a payroll engine or pretending a simple salary division is always lawful |
| Sickness | A manager may record dates, notification and work status. Symptoms, fit notes, occupational-health evidence and adjustment grounds use the restricted health boundary | Absence administration should not expose medical detail |
| Adjustments | HR records the confidential request and evidence; a separate operational instruction says only what a manager must implement, its review date and status | The manager can implement support without being shown a diagnosis |
| Right to work | Record the check route and version, checker, check date, restrictions, outcome, evidence and required follow-up. The system warns but never declares a person legally eligible | The prescribed process and source guidance change, and the employer remains responsible |
| Competence | Use reflect, identify, plan, activity and evaluate records with supervisor review; qualifications and practising status are separate evidence | This matches the SRA model and avoids treating attendance alone as competence |
| Reviews | Objectives and appraisal statements are fixed once acknowledged. The worker can add a response or disagreement rather than edit the manager's opinion | Accuracy includes preserving a clearly identified opinion and the worker's response |
| Casework | Grievance, disciplinary and capability cases have an explicit case team, separated investigator/decision-maker/appeal roles where practicable, fixed evidence and a complete event history | The `hr` role alone is not enough reason to browse every confidential allegation or witness statement |
| Decisions | Stass never auto-rejects leave, infers illness, ranks performance, recommends discipline, or makes dismissal/redundancy decisions | Significant employment decisions require accountable humans and contextual legal judgement |
| Retention | Versioned category rules calculate review/disposal dates; holds suspend disposal; protected disposal removes content but keeps a content-free tombstone | ICO guidance rejects one retention period for every employment record |
| Leavers | HR records the engagement end and checklist; Administrator separately disables the account and existing module safeguards still apply | Departure evidence cannot become an HR bypass around access-control administration |
| Notifications | Email and ordinary notifications contain only a generic action and link, never pay, health, absence reason, allegation or outcome | Mailboxes and notification lists are a broader confidentiality boundary |

## Roles and proposed permissions

`hr.directory`, `hr.manage`, `hr.leave`, `hr.health`, `hr.vetting` and
`hr.competence`, `hr.cases`, `hr.retention` and `hr.export` are implemented
through step 16e. No reserved HR permission remains.

| Permission | Administrator | Partner | Fee earner | Accounts | Compliance | HR |
|---|---:|---:|---:|---:|---:|---:|
| `hr.directory` - safe staff directory | yes | yes | yes | yes | yes | yes |
| `hr.manage` - employment, reporting lines, work patterns and lifecycle | | | | | | yes |
| `hr.compensation` - encrypted pay and benefit terms, not payroll operation | | | | | | yes |
| `hr.vetting` - right-to-work and professional-check evidence | | | | | | yes |
| `hr.health` - sickness evidence, health facts and adjustment grounds | | | | | | yes |
| `hr.leave` - firm-wide entitlement, absence and holiday-pay evidence | | | | | | yes |
| `hr.competence` - firm-wide qualifications, development and reviews | | | | | | yes |
| `hr.cases` - triage a case and participate only when explicitly assigned | | | | | | yes |
| `hr.retention` - hold, review and dispose of HR records | | | | | | yes |
| `hr.export` - prepare a fixed worker-access or regulatory bundle | | | | | | yes |

The `hr` role is grantable only through the existing Administrator workflow. It
is a sensitive role: the holder and every active Compliance holder receive the
existing generic role-change notice. Administrator cannot read HR content and
HR cannot invite, enable, disable or assign roles. Revoking the last HR holder
is allowed because the rest of Stass remains operable; the UI must make the
resulting unowned work visible before confirmation.

Self-service and line-manager actions do not come from a broad role permission.
They use staff-only routes and recheck the record relationship in PostgreSQL on
every request. Losing the reporting line removes access on the next request.
An HR role does not by itself open a confidential case: a live `hr.cases`
permission and current case membership are both required, with an access entry
for each detail view or download. A designated Partner may be added to a case
team without receiving general HR access, for example where the subject is an
HR holder or the procedure needs an independent appeal officer.

## Record classes and visibility

| Class | Examples | Worker | Current manager | HR | Other staff |
|---|---|---:|---:|---:|---:|
| Directory | display name, job title, team, work email, work location | yes | yes | yes | yes |
| Employment | engagement kind, start/end, working pattern, manager, policy acknowledgements | own | bounded current facts | yes | no |
| Personal | home/contact details, emergency contact, date of birth | own safe view/edit | no | yes | no |
| Compensation | salary/rate, allowances, benefits, change reason | own current/history | no | yes | no |
| Vetting | right-to-work route/evidence, professional checks and restrictions | own safe status | expiry/action only when necessary | yes | no |
| Leave | entitlement, requests, decisions, carry-over and holiday-pay evidence | own | direct reports, without medical reason | yes | no |
| Health | symptoms, fit notes, occupational health, adjustment grounds | own where appropriate | operational fitness/adjustment only | yes | no |
| Competence | reflection, needs, plan, activity, evaluation, qualifications | own | direct reports | yes | no |
| Review | objectives, statements, acknowledgement and response | own | direct reports | yes | no |
| Case | allegation, evidence, meetings, decision and appeal | disclosed procedural copies, not unrestricted live case | only if assigned | only if assigned | no |

The worker-facing response is not a raw database row. Third-party witness data,
confidential references, legal advice and information subject to an applicable
access exemption need a human disclosure review. Stass will therefore generate
a reviewable export; it will not claim that clicking “download my data” alone
fulfils a subject access request.

## Employment lifecycle

```text
Accepted engagement
    -> HR creates personnel record and proposed start
    -> right-to-work / required professional checks
    -> Administrator separately invites or links the staff account
    -> joiner checklist and current terms become effective

Active engagement
    -> effective-dated manager, work pattern and terms
    -> leave / absence / adjustments
    -> competence, objectives and reviews
    -> mover checklist for material role or team change

Leaving
    -> HR records reason category, last day and leaver checklist
    -> Administrator separately disables account and ends sessions
    -> ownership/supervision/appointments handed over in their owning modules
    -> category-specific retention and disposal dates start
```

An account may be invited before its engagement starts for controlled setup,
but it receives no HR management authority from the personnel record. Ending an
engagement does not directly change roles or account status. The leaver queue
must show unresolved client ownership, matter supervision, tasks, protected
roles, nominated-officer appointments and HR case ownership using safe ids and
status only; each owning module performs its own transfer.

The database allows only one current primary engagement per staff account. A
returning worker gets a new engagement linked to the same permanent personnel
record. Dates, contractual hours and status transitions use protected functions
with database time and row locks; an overlapping engagement, retroactive change
over a later event, manager cycle or a manager outside an active engagement is
refused.

## Leave and absence

- A versioned firm policy defines the leave year, standard entitlement,
  carry-over rules, booking notice and approval route. The stored policy is
  evidence, not a legal calculator; HR records any individual contractual or
  statutory adjustment explicitly.
- Each effective working pattern has weekday minutes and a time zone. A request
  expands to immutable per-date minutes when approved, so later pattern changes
  never change historical consumption.
- Entitlement is an append-only ledger: opening grant, accrual/adjustment,
  carry-over, approved consumption, cancellation return and leaving adjustment.
  Every entry states its source and exact integer minutes. The balance is
  derived, not an editable field.
- A worker requests annual, family-related, compassionate, unpaid or other
  leave. The current line manager may approve or refuse ordinary leave for a
  direct report with a reason; HR can administer all categories. The same actor
  cannot approve their own request.
- The database locks the person and leave year when approving, preventing two
  requests from consuming the same balance or overlapping. Cancellation adds
  events; it never deletes the original request or decision.
- Sickness absence records start/end dates, notification time and work status.
  The manager-facing form has no free-text medical field. Detailed reasons, fit
  notes, occupational-health evidence and phased-return grounds use the health
  boundary.
- Holiday-pay evidence records the pay period, exact pence paid, normal/basic or
  rolled-up basis as supplied by payroll, included pay elements and who attested
  or imported it. Stass validates shape and arithmetic totals but does not decide
  the legally correct pay rate.
- The system retains annual-leave and holiday-pay records for at least six years
  from creation. A longer firm/legal-claims rule is versioned and justified.

## Vetting, qualifications and competence

- A right-to-work record fixes the guidance/checklist version, manual/online/
  digital-provider route, date, checker, identity-match method, permission type,
  work restrictions, expiry/follow-up date, result and evidence hash.
- Time-limited permission creates a due item. An overdue or failed follow-up is
  escalated to HR and prevents HR from marking the joiner/mover checklist
  complete, but the software does not dismiss, suspend or disable the worker.
- Right-to-work copies stay encrypted for the engagement plus two years and are
  then due for secure disposal unless a documented legal hold applies.
- Professional records cover SRA number/status where applicable, role-relevant
  qualifications, practising-certificate period and any restriction. Stass may
  record a dated external check and source; it does not represent cached data as
  current after its check date.
- A development cycle contains reflection, identified need, planned response,
  completed activity, evidence and evaluation. The worker owns their narrative;
  a manager or HR can add review, requirement and status without replacing it.
- Firm-required courses can be assigned by HR. AML training remains owned by
  Compliance; HR receives only a safe completion/due status through an exported
  service method, never AML evidence or restricted-report information.

## Health, adjustments and casework

Health data is encrypted with record-and-purpose authenticated context and read
through separate repository methods. List and manager responses never contain
diagnoses, symptoms, treatment, disability category, medical document names or
free text. A manager sees only `fit`, `not_fit`, `may_be_fit` or `not_assessed`,
the dates and the operational adjustment instruction needed for their duty.

Adjustment history records request, assessment, agreed action, implementation,
review and closure as permanent events. A refusal needs an accountable human,
reason and review route; no cost or absence threshold makes the decision. An
emergency-contact disclosure is a separately audited action and only permitted
for a recorded urgent purpose.

Formal grievance, disciplinary and capability cases are distinct from ordinary
performance reviews. Each case fixes:

- kind, subject, raiser where applicable, policy version and opened time;
- current investigator, decision-maker, appeal officer and any HR case members;
- allegation or grievance issues, evidence, meetings, companions and responses;
- procedural notices, outcome, reasons, actions and appeal history; and
- a category-specific retention review, legal hold and final disposal record.

The database prevents one person from recording incompatible investigation,
decision and appeal roles unless HR records why the firm's size made separation
impracticable. Evidence and events are append-only; a correction identifies the
superseded item. Case queues expose neutral ids, type and due state only. Detail
views/downloads append a protected access record and a normal content-free audit
event.

General whistleblowing is **not** stored in first-version HR casework. It needs
a protected-disclosure recipient and confidentiality boundary that still works
when HR or senior management is implicated. The firm's published internal and
external reporting routes remain the authority until that separately designed
feature exists. AML suspicion continues to use the nominated-officer-only step
15e route and must never be copied into HR.

## Private files and encryption

- HR files use random `hr/<uuid>` object keys and never enter ordinary matter
  documents, client sharing, search, email attachments or the portal.
- Uploads reuse the document module's bounded streaming, strict file-type,
  active-content and malware inspection. Allowed categories are narrower and
  declared by the HR route.
- Each file gets a random data key. `HR_ENCRYPTION_KEY` wraps it with AES-256-GCM
  using the HR record id, file id and purpose as authenticated context.
- Structured sensitive values use the same master key with distinct contexts.
  Ciphertext cannot be moved between people, purposes or record kinds without
  authentication failure.
- Downloads recheck live authorization after retrieving metadata, stream
  decryption without a plaintext disk copy, record access, and return safe
  attachment headers plus `private, no-store`, `nosniff` and sandbox CSP.
- Database and object disposal is two-phase: a protected transaction fixes the
  eligible object keys, the service removes them, and finalization rechecks
  retention, holds and case membership before clearing ciphertext and keys.

`HR_ENCRYPTION_KEY` is an implemented independent 32-byte base64 secret. It is
never reused as the document, Finance, AML, suspicion, mail or TOTP key. The
environment loader refuses a missing, malformed or reused key. Examples contain
only a placeholder; each environment supplies its own uncommitted secret.

## Retention, legal hold and worker access

A versioned schedule applies a rule to each category rather than to the whole
personnel file. At minimum:

| Category | First-version rule |
|---|---|
| Right-to-work evidence | Engagement duration plus two years, then dispose |
| Annual-leave and holiday-pay evidence | Six years from record creation |
| Active contractual terms and compensation | While needed for the engagement, claims and statutory records under the firm's approved rule |
| Health and adjustments | Shortest justified period for the stated employment/health purpose; review at closure and departure |
| Competence and professional status | Firm's documented SRA/regulatory evidence period, reviewed at departure |
| Grievance, disciplinary and capability | Case-specific firm rule; confidential and no longer than necessary, subject to claims/other legal hold |
| Directory and emergency details | While current; obsolete values disposed when no longer needed except minimal change evidence |

A hold is an append-only imposed/reviewed/released event with encrypted reason,
authority and scope. The latest trusted-time event determines state. A disposal
job is resumable and records only person id, category, rule version, disposed
time and actor after content removal. It never retains a filename, narrative,
health fact, allegation, pay value or evidence hash.

HR can create a fixed encrypted export for a worker-access request, litigation
or regulator. The request's purpose and scope are recorded; third-party and
exempt material must be reviewed and redacted by an authorised human before a
bundle is released. Downloads are time-limited in policy but the export event,
hash and outcome remain. Stass does not send the bundle by email.

## Audit and notifications

Successful and refused create/change/read/download/export/disposal actions are
audited. Metadata contains ids, category, event kind, state and counts only. It
never contains home address, personal phone/email, National Insurance number,
date of birth, emergency-contact detail, compensation, absence reason, health
fact, qualification identifier, objective, appraisal text, allegation, witness,
decision reason, filename or encryption material.

Restricted health and case detail also writes a dedicated access row protected
from application/owner update, delete and truncate. This records the viewer,
record, access kind and trusted database time without copying content.

Notifications are deliberately generic, for example “An HR action needs your
attention”. The recipient follows a link and is authorised again. No health,
case, pay, leave reason or right-to-work outcome is sent through the ordinary
email outbox. Reminder deduplication and final recipient-role/relationship checks
follow the Notifications module's existing pattern.

## Proposed API and screens

The exact schemas are fixed in each implementation step. Planned route groups:

| Area | Routes / screens | Principal authorization |
|---|---|---|
| Directory and self | `/hr/directory`, `/hr/me`, correction request | signed-in staff; own record or safe directory fields |
| HR workspace | `/hr`, due joiners/leavers, checks, leave, reviews, retention | relevant `hr.*` permission |
| Personnel | `/hr/people/:accountId`, engagements, terms, manager, work pattern, lifecycle | `hr.manage`; own safe subroutes |
| Leave | `/hr/me/leave`, `/hr/reports/:personId/leave`, HR leave queue | own, current manager, or `hr.leave` record rule |
| Health/adjustments | separate evidence and operational-adjustment routes | `hr.health`; manager gets operational projection only |
| Vetting | right-to-work, professional checks, evidence and follow-up | `hr.vetting`; worker gets safe status |
| Competence/reviews | development cycles, qualifications, objectives and acknowledgements | own, current manager, or `hr.competence` |
| Cases | neutral queue, case detail, membership, evidence, decision and appeal | `hr.cases` plus active case membership |
| Retention/export | schedules, holds, disposal runs and reviewable bundles | `hr.retention` or `hr.export` |

The staff navigation shows “People” to every staff member for the directory and
self-service. The “HR workspace” appears only when a capability response says
the account can perform an HR operation. A manager sees a “My team” view derived
from current reporting lines. Server pages use the API's filtered response;
client components do not hold or infer business rules.

Desktop and 390 px views, keyboard-only workflows, error summaries and WCAG
2.2 AA automated checks are required. Browser tests prove that Administrator,
Partner and former managers cannot reach HR data by guessing routes or ids, and
that manager projections omit pay, medical and case fields.

## Not in the first version

- Recruitment marketing, applicant tracking, interview scoring or automated CV
  screening. A later recruitment design must isolate unsuccessful-candidate
  data and its shorter retention.
- Payroll calculation, PAYE/NI submissions, pension administration, expenses,
  benefits-provider integrations or bank payments. Stass records employment and
  holiday-pay evidence supplied by the responsible system.
- Clock-in, keystroke, email, browser, location, biometric or productivity
  monitoring. Any future monitoring needs a stated purpose, proportionality
  assessment, worker transparency and usually a DPIA before collection.
- Automatic performance, absence-risk, promotion, redundancy, disciplinary,
  dismissal, health or wellbeing scoring. No AI receives HR records in the
  first version.
- General whistleblowing disclosures, settlement agreements, trade-union
  collective-bargaining records or occupational-health provider integration.
- Workforce planning, rota scheduling and room/equipment booking.

## Build order

### Step 16a: foundation and employment records

Built on 12 October 2026 in migration `0059_hr_foundations.sql` and
`apps/api/src/hr/`:

- The separate `hr` role has only `hr.directory`, `hr.manage` and the
  all-staff confidential-report submission permission. Administrator, Partner
  and Compliance do not inherit personnel access. Granting HR triggers the
  existing sensitive-role notice to active Compliance holders.
- PostgreSQL owns the access decision. Protected functions lock and recheck a
  live HR role, the subject account or the effective current reporting line;
  `pms_app` cannot read or write HR tables directly. History tables reject
  owner update, delete and truncate.
- One personnel record links to one staff account. Engagements cover every
  designed workforce kind and cannot overlap. Terms, weekday-minute work
  patterns and manager assignments are effective-dated append-only events.
  Retroactive entries over newer history, inactive managers, self-management
  and direct/indirect reporting cycles are refused.
- Contact details, date of birth, engagement-ending reasons, correction text
  and filenames are AES-256-GCM ciphertext under `HR_ENCRYPTION_KEY`, bound to
  record id and purpose. Ending an engagement does not disable an account or
  alter roles.
- `/hr/directory` returns only work identity and current directory facts.
  `/hr/me` exposes the subject's safe record and permits only append-only
  contact changes and correction requests. `/hr/reports/:personId` returns a
  current manager only the employment summary and current work pattern.
- HR files use random `hr/<uuid>` object keys, streaming type/active-content
  inspection, ClamAV and per-file encryption. Only HR uploads; the subject can
  download only a file whose immutable `worker_visible` flag is true. Downloads
  are audited and use attachment, `private, no-store`, `nosniff` and sandbox
  headers.
- Every successful change, HR view of another person's full record and file
  download is content-free in the ordinary audit log. Correction requests and
  decisions are separately encrypted and append-only.

Focused tests cover the role matrix and security notices, key validation and
separation, cipher context binding, positive and negative HTTP paths, manager
replacement, cycles/overlaps/retroactivity, direct-table denial, owner
immutability, strict unsafe input and encrypted file round trips.

### Step 16b: leave, sickness administration and adjustments

Built on 12 October 2026 in migration
`0060_hr_leave_health_adjustments.sql` and the HR API module:

- Versioned policies retain the leave-year anchor, standard minute entitlement,
  carry-over limit, booking notice and `manager_or_hr`/`hr_only` annual approval
  route as evidence. Each request pins the applicable policy version. Policies
  do not calculate legal entitlement or holiday pay.
- The signed, append-only entitlement ledger stores exact integer minutes.
  Annual approval locks the person and leave year, derives each working date
  from the then-effective pattern, rejects overlap or insufficient balance, and
  fixes the approved daily expansion permanently. Cancellation appends an event
  and a matching return; it does not rewrite the decision or consumption.
- Workers and HR can submit encrypted leave requests. The current effective
  manager may approve/refuse only ordinary annual leave, never their own. HR can
  decide every category. Request, decision and ledger-note ciphertexts use
  separate purpose-and-row contexts.
- Payroll-supplied holiday-pay evidence records integer pence, period, basis and
  named component amounts whose pence sum must equal the recorded total, with a
  database-derived minimum six-year retention date. Stass stores the evidence
  and does not calculate the lawful rate.
- Sickness administration contains dates, notification time and the operational
  `fit`, `not_fit`, `may_be_fit` or `not_assessed` status only. Strict request
  schemas reject extra medical-reason fields. Detailed sickness, fit-note,
  occupational-health and adjustment-ground records use the encrypted health
  boundary and are unavailable to managers.
- Adjustment requests and accountable decisions remain private to the worker
  and HR. An agreed decision separately encrypts the operational instruction,
  effective date and review date shown to the current manager. Implementation,
  review and closure append permanent events; managers cannot close a record.
- `/hr/me/leave`, `/hr/reports/:personId/leave` and HR person/queue routes apply
  self, current-manager and HR rules in PostgreSQL. Manager responses contain no
  holiday pay or ledger notes. Separate health and adjustment routes audit
  sensitive reads and return only the appropriate private or operational shape.
- Direct `pms_app` table access and owner update/delete/truncate remain refused.
  Change audits contain ids, dates, kinds, minute/pence totals and outcomes, not
  request reasons, health facts, adjustment text or encryption material.

Focused integration coverage proves role/record separation, encryption at rest,
exact minute expansion, self-approval and protected-category refusal, balance
and overlap enforcement, cancellation return, reason-free sickness, health and
adjustment projections, holiday-pay retention, direct-table denial and immutable
history.

### Step 16c: joiners, movers, leavers and vetting

Built on 12 October 2026 in migration `0061_hr_lifecycle_vetting.sql` and the
HR API module:

- HR creates joiner, mover and leaver checklists tied to one engagement and a
  real effective date. Leavers require the already-recorded final day and a
  structured departure category. Checklist and item completion/reopening are
  permanent encrypted events; completed checklists must be reopened before
  more item work.
- Completing a joiner or mover requires every required item and the latest
  right-to-work check to be a non-overdue pass. Completing a leaver also
  requires the account to be disabled and existing protected roles, client
  responsibility, matter supervision, open tasks and AML appointments to have
  been resolved in their owning modules. HR receives safe blocker ids/statuses
  but cannot change accounts or those records.
- Right-to-work checks are versioned per engagement under a database lock. They
  fix the guidance version, route, date, permission type, outcome, expiry,
  follow-up and checker. Private identity-match, restriction and provider facts
  are encrypted under `HR_ENCRYPTION_KEY`; evidence must be an existing
  encrypted `identity` HR file belonging to the same person.
- The due queue shows only each engagement's latest failed, follow-up-required
  or next-30-day follow-up/expiry check. A check cannot be future-dated or
  backdated over the previous one, and a later failure replaces an earlier
  pass for lifecycle completion.
- Qualification, professional-registration and practising-certificate records
  keep encrypted identifiers/restrictions plus append-only dated status checks
  with encrypted source/notes. A check cannot be future-dated or backdated over
  later evidence.
- Self-service returns the worker's safe current vetting status and professional
  record. A current manager receives expiry/action and public professional
  status only; result, permission, check date, identifiers, restrictions,
  sources and notes are null. HR receives full history and the read is audited.
- `pms_app` cannot read or write the seven lifecycle/vetting tables directly.
  Protected functions recheck live HR or self/current-manager access, and owner
  update, deletion and truncation are refused.

Focused integration coverage proves lifecycle state and blocker enforcement,
safe self/manager/HR projections, evidence-person binding, ciphertext/audit
separation, right-to-work versioning and due dates, professional check history,
strict inputs, direct-table denial and owner immutability.

### Step 16d: competence and reviews

Built on 12 October 2026 in migration `0062_hr_competence_reviews.sql` and the
HR API module:

- Development cycles cover a fixed period. The worker appends their reflection,
  identified need, plan, activity/evidence and evaluation; a current manager or
  HR appends requirements, reviews and status. Neither side can write as the
  other, and no event replaces an earlier narrative.
- HR can assign required learning with a due date and encrypted details. The
  worker or HR can append completion evidence or reopen the assignment;
  duplicate completion and future-dated completion are refused. A manager can
  read the record but cannot attest completion for the worker.
- A current manager or HR creates an immutable objective with a target date or
  an immutable appraisal statement for a fixed period. Only the worker can
  acknowledge it or append a response/disagreement; acknowledgement is
  one-time and the manager's statement is never rewritten.
- Every narrative, requirement, learning detail/evidence, objective, appraisal
  and worker response is AES-256-GCM ciphertext under `HR_ENCRYPTION_KEY` with
  a distinct row-and-purpose context. Ordinary audit metadata contains only
  ids, event kinds, dates and states.
- Self, current-manager and HR reads are rechecked in PostgreSQL. `pms_app`
  cannot directly access the six tables and owner update/delete/truncate is
  refused. Losing the reporting line removes manager access on the next call.
- AML training remains owned by Compliance. A small Compliance-exported service
  returns only approved material id/title/version and completion/due status to
  the HR competence response; provider, evidence reference, control content and
  every other AML record remain outside HR.

Focused integration coverage proves the record rules, worker/manager authorship
split, assignment state/date rules, fixed review and response history,
encryption/audit separation, safe AML projection, strict shapes, direct-table
denial and owner immutability.

### Step 16e: confidential cases, retention and exports

Built on 13 October 2026 in migration `0063_hr_cases_retention_exports.sql`
and the HR API module:

- A grievance, disciplinary or capability case starts with an encrypted issue,
  a fixed policy version, optional raiser and due date. Its queue contains only
  neutral ids, type, state and due information. Case detail is available only
  to active staff with a current explicit membership; holding HR alone does not
  open it.
- The opening HR holder becomes the first `hr_member`. A current HR case member
  can assign an active staff member as investigator, decision-maker or appeal
  officer, or add another live HR holder. One person cannot hold incompatible
  procedural roles unless the encrypted small-firm separation reason is
  recorded. The last live HR case owner cannot be removed.
- Evidence, meeting, response, notice, outcome, action, appeal, correction and
  status events are append-only encrypted records. PostgreSQL reserves outcomes
  for the decision-maker, appeals for the appeal officer and status for a live
  HR case member. A correction names the earlier same-case event; it never
  replaces it. Every detail view or export writes a separate protected access
  row and a content-free ordinary audit event.
- Versioned retention rules cover personal, employment, leave, health,
  right-to-work, competence and case records. Leave rules cannot be shorter
  than 72 months and right-to-work rules cannot be shorter than 24 months.
  Each schedule's basis must equal the latest date derived by PostgreSQL from
  the protected source records; a newer record or active engagement changes the
  basis and blocks disposal.
- Legal holds are permanent imposed/reviewed/released events with encrypted
  authority and reason. Preparation and finalization both lock the person and,
  for a case, the case; recheck the due date, source basis and latest hold; and
  serialize against new events or holds. Disposal removes eligible encrypted
  rows and `hr/` objects, removes fixed exports that could retain the content,
  and keeps only record id, kind, category, rule version, actor and trusted time
  in a tombstone.
- HR prepares a fixed AES-256-GCM JSON bundle for worker access, litigation or
  a regulator by selecting explicit scopes. Case material includes only cases
  assigned to the preparer, and both preparer and reviewer must retain those
  memberships. A different active HR holder must inspect the fixed bundle and
  approve it before download. Rejection is permanent; approved downloads check
  SHA-256 integrity and use attachment, private/no-store, nosniff and sandbox
  headers. Stass never emails the bundle.
- `pms_app` has no table access. Protected functions recheck active accounts,
  live HR roles and current case membership under row locks. Owner changes and
  truncation are refused outside the sole disposal path.

Focused HTTP and exclusive migration coverage proves membership and live-role
revocation, role separation and encrypted override reasons, event authorship,
access logging, ciphertext/audit separation, trusted retention bases, legal
holds, content-free disposal, two-person export release, strict shapes, direct
table denial, owner immutability and races between reads/revocation, holds/
disposal and events/disposal.

- **16a. Foundation and employment records — built.** Separate `hr` role and
  permissions, protected employment/person/manager/work-pattern history, HR
  encryption and private-file boundary, safe directory, self-service and
  correction workflow.
- **16b. Leave, sickness administration and adjustments — built.** Exact entitlement
  ledgers, approval concurrency, six-year holiday/pay evidence, health-separated
  absence and the operational-adjustment projection.
- **16c. Joiners, movers, leavers and vetting — built.** Lifecycle checklists,
  right-to-work versions/evidence/follow-ups, qualifications and professional
  status without giving HR account-management authority.
- **16d. Competence and reviews — built.** Reflect/identify/plan/activity/evaluate,
  firm assignments, objectives, appraisal acknowledgement and worker response.
- **16e. Confidential cases, retention and exports — built.** Explicit case teams,
  investigation/decision/appeal event history, category schedules, holds,
  controlled disposal and reviewable fixed exports.
- **16f. Staff, manager and HR screens.** Add the complete People/self-service,
  My team and least-privilege HR workspaces with browser coverage.
- **Security review.** Recheck the current law/guidance; threat-model insider and
  former-manager access, health/case inference, ids, exports, files, concurrency,
  notification leakage, key loss and disposal; deliberately break every control
  and restore it before the module is complete.

Each step ships with database privilege/concurrency tests, positive and negative
HTTP tests, type checks, production builds and updated documentation before the
next step.

## Approval

The first-version scope is approved and steps 16a to 16e are implemented. A change to
role authority, health/case access, retention, payroll boundary or automated
decision policy changes the security model and is agreed here before code.
