# Compliance and AML

**Current state (2026-10-10):** The project owner approved this first-version
design. Steps 15a and 15b are built: permissions, protected nominated-officer and deputy
appointments, fixed firm-control versions with separate Partner approval,
training completions and independent-review records, plus versioned client CDD,
encrypted identity facts and separately protected evidence. Steps 15c to 15f
remain planned.

How Stass helps an SRA-regulated firm in England and Wales record and enforce
its anti-money-laundering, counter-terrorist-financing, proliferation-financing
and sanctions controls. Stass is a workflow and evidence record. It does not
decide whether a person is suspicious, replace professional judgement, submit
a report to a regulator, or make an unlawful transaction lawful.

## Regulatory basis

This design was checked on 10 October 2026 against these current primary and
supervisory sources:

- [The Money Laundering Regulations 2017, as amended](https://www.legislation.gov.uk/uksi/2017/692/contents)
  require a written firm-wide risk assessment, proportionate policies and
  controls, staff training, customer and beneficial-owner identification,
  risk-based verification, ongoing monitoring, enhanced due diligence in
  higher-risk cases and records that demonstrate what was done.
- [SRA firm-wide risk-assessment guidance](https://www.sra.org.uk/solicitors/guidance/firm-risk-assessments/)
  requires the firm's actual customers, geographies, services, transactions
  and delivery channels to be assessed, alongside money-laundering,
  terrorist-financing and proliferation-financing risks. Senior management
  must approve and regularly review the assessment.
- [SRA client and matter risk-assessment guidance](https://www.sra.org.uk/solicitors/guidance/client-and-matter-risk-assessments/)
  requires written, reasoned and current assessments rather than an
  unexplained tick-box score. Mandatory high-risk factors must override a low
  numerical score, and the result must determine due diligence and monitoring.
- [SRA AML guidance and the Treasury-approved LSAG guidance](https://www.sra.org.uk/solicitors/resources/money-laundering/guidance-support/)
  cover client due diligence, beneficial ownership, source of funds and wealth,
  politically exposed persons, reliance, monitoring, training and reporting.
- [SRA sanctions guidance](https://www.sra.org.uk/solicitors/guidance/financial-sanctions-regime/)
  applies to every SRA-authorised firm and to clients, controllers,
  counterparties, funders and recipients. It requires ongoing controls and
  distinguishes AML beneficial ownership from sanctions ownership or control.
- [The UK sanctions collection](https://www.gov.uk/government/collections/uk-sanctions)
  identifies the UK Sanctions List as the sole current source for UK
  designations from 28 January 2026 and links the applicable regimes,
  licensing and reporting routes.
- [NCA suspicious-activity reporting guidance](https://www.nationalcrimeagency.gov.uk/what-we-do/crime-threats/money-laundering-and-illicit-finance/suspicious-activity-reports)
  explains the reporting duties under POCA and TACT, use of the secure SAR
  Portal, and the offences concerning failure to disclose, tipping off and
  prejudicing an investigation.
- [Regulation 40](https://www.legislation.gov.uk/uksi/2017/692/regulation/40)
  generally requires CDD and transaction-supporting records for five years
  after the transaction or business relationship ends, followed by deletion
  of personal data unless a stated exception applies.

The rules and published risk lists change. They must be checked again during
the module's security review and before production. This design is not legal
advice and does not decide which of the firm's services fall within the
regulated sector.

## Decisions

| Topic | Proposed decision | Why |
|---|---|---|
| Scope | Record whether each matter is in scope of the Money Laundering Regulations, with a reason and Compliance approval. Apply sanctions controls to every client and matter regardless | AML scope depends on the service; sanctions duties apply to all authorised firms |
| Firm controls | Keep fixed versions of the firm-wide ML/TF/PF and sanctions risk assessments, policies, training material and independent reviews. An active partner approves each version prepared by Compliance | The system must show which approved control framework governed each client/matter decision |
| Roles | Keep `compliance` for ordinary firm-wide AML work. Add a protected nominated-officer appointment, held only by an active Compliance account, for internal disclosures and SAR/DAML decisions | The existing role already represents COLP/COFA/MLRO oversight, but suspicion material needs a narrower need-to-know boundary |
| Client due diligence | Use versioned client CDD cases with identity, authority, ownership/control, purpose and verification evidence. Do not treat a contact or Companies House entry alone as verified CDD | The firm must understand and verify the client, representatives and beneficial owners from reliable independent sources |
| Matter assessment | The fee earner prepares a tailored written client/matter assessment. Compliance approves high-risk, exceptional or out-of-scope decisions and an active partner supplies any required senior-management approval | Keeps professional judgement visible and separates preparation from higher-risk approval |
| Work gate | A matter may be created for onboarding and conflict checks, but substantive work, ordinary documents, time, billing and money movement require both conflict clearance and current compliance clearance | AML needs the proposed service and transaction context, but work must not quietly start before checks finish |
| Early verification exception | No default bypass. A time-limited, action-specific exception needs recorded low-risk grounds, active Compliance approval and a different active partner's approval. It never permits receiving or releasing client money | Reflects the narrow timing exception in regulation 30 without turning it into a general override |
| Risk rating | `low`, `standard` or `high`, always with narrative grounds, mitigations and a review plan. Mandatory high-risk factors force `high`; a formula may suggest but never lower the result | SRA guidance warns against unexplained or definitive tick-box scoring |
| EDD | High risk requires explicit enhanced measures, source-of-funds/source-of-wealth work where applicable, enhanced monitoring and senior-management approval before clearance | Makes the extra measures enforceable rather than a label |
| Sanctions source | Import and retain immutable versions of the official UK Sanctions List. Matching proposes candidates; an authorised human resolves them using identity and ownership/control facts | The list changes frequently, fuzzy names create false positives, and control is wider than a share threshold |
| Sanctions effect | A possible hit stops onboarding and payments pending review. A confirmed designation freezes affected funds and work unless an applicable licence or exception is recorded. Recording a bank-confirmed receipt remains possible but immediately freezes it | Stass must not hide a real bank movement, and it must not enable value to leave or work to continue unlawfully |
| External reports | NCA SAR/DAML and OFSI/OTSI reports remain in their official portals. Stass stores only the protected internal decision, dates, external reference, status and any licence/defence conditions | Avoids duplicating government submission services and limits highly sensitive material |
| Suspicion confidentiality | Internal reports, decisions and attachments use a separate encryption key and nominated-officer access. Ordinary users see only a generic unavailable action; portals, email, normal matter history and exports reveal nothing about a suspicion or SAR | Reduces tipping-off and prejudicing-an-investigation risk |
| Retention | Calculate disposal from the end of the relationship or transaction. A controlled job deletes AML personal data after the required period unless a documented legal-proceedings or statutory hold applies; a content-free disposal record remains | Compliance records cannot simply be kept forever, unlike financial postings |
| Providers | Manual and certified digital verification evidence are both allowed. The provider, method, assurance result and raw response hash are recorded; the firm remains responsible | Avoids locking the design to one vendor or treating a provider result as the legal decision |
| Client portal | No AML, sanctions, source-of-funds or suspicion pages, states, notifications or downloads | These are internal records and may expose sensitive checks or reporting |

## Roles and permissions

Step 15a and 15b permissions exist now; later-step permission names remain planned.

| Permission | Administrator | Partner | Fee earner | Accounts | Compliance |
|---|---:|---:|---:|---:|---:|
| `aml.officers.manage` - record and end nominated-officer/deputy appointments, without reading AML content | yes | | | | |
| `aml.assess` - prepare CDD and risk work for a visible client/matter | | yes | yes | | yes |
| `aml.view_evidence` - view necessary CDD evidence under the record rule | | yes | yes | | yes |
| `aml.approve` - approve CDD, EDD, scope and ongoing reviews firm-wide | | | | | yes |
| `aml.firm_controls` - prepare firm risk, policy, training and audit records | | | | | yes |
| `aml.firm_approve` - approve a fixed firm-control version | | yes | | | |
| `aml.sanctions` - resolve candidates, record licences and control freezes | | | | | yes |
| `aml.internal_report` - send a confidential internal disclosure | yes | yes | yes | yes | yes |

`aml.internal_report` permits submission only. It never permits listing or
reading a submitted report. `aml.suspicion_manage` is not a role permission:
it is derived from a live nominated-officer appointment plus the active
`compliance` role. Losing either takes effect on the next request and is
rechecked in PostgreSQL for changes and sensitive reads.

The administrator records an appointment only from an already active
Compliance holder and cannot read any AML record through that action. The last
active nominated officer cannot be removed or disabled; appointment and role
changes share the same serialized last-holder protection already used for
protected roles. The firm remains responsible for making the real regulatory
appointment outside Stass.

## Compliance lifecycle

```text
Create client
    -> establish identity and ownership/control
    -> screen relevant people and entities
    -> assess client risk and required due diligence

Create proposed matter
    -> conflict check                    -> clear or refuse conflict
    -> scope and matter risk assessment  -> CDD / EDD / source evidence
                                           -> approve or refuse compliance

Both gates clear -> substantive work and permitted money actions
                 -> ongoing monitoring and event-driven reviews
                 -> hold, refresh or re-approve when facts change
```

Conflict and compliance are separate gates. A conflict clearance never implies
AML clearance, and AML clearance never implies the absence of a conflict.
Matter `status` continues to describe conflict/open/closed state; a separate
derived compliance state is `pending`, `cleared`, `review_due` or `held`.

Every work-creating database function rechecks the current gates while holding
the matter row. A simultaneous hold, risk expiry, role loss or attempted work
therefore commits in a defined order. Existing read access remains available
unless a narrower confidentiality rule applies, so staff can wind down safely.

## Firm-wide controls

- A firm-control document has a kind, version, effective period, source and
  private fixed document text with a SHA-256 digest. Step 15b adds the separate
  protected-file path used for CDD evidence. Published versions are immutable
  and a new version supersedes rather than edits one.
- Risk assessments cover customers, geographies, services, transactions and
  delivery channels, and separately identify ML, TF, PF and sanctions risk.
  The author records which SRA sectoral assessment, National Risk Assessment,
  FATF lists and internal evidence informed it.
- An active partner other than the preparer approves each effective risk or
  policy version. Approval fixes the exact content hash. Expiry and overdue
  review are visible; an expired framework prevents new compliance clearance
  but does not erase existing decisions.
- Policies, controls and procedures record their relationship to the current
  firm risk assessment. The application does not generate generic policy text
  or pretend that an uploaded template was tailored.
- Training records fix subject, material version, trainer/provider, completion
  date and evidence. Compliance can schedule required training; staff attest
  only their own completion. A dashboard reports missing and expired training
  without exposing unrelated AML records.
- Independent review records fix reviewer, scope, period, findings document,
  recommendations, management response and completion. Stass does not call a
  self-review independent merely because a checkbox was selected.

## Client identity and ownership

Step 15b implements this section. A visible client's Partner or fee earner, or
Compliance firm-wide, creates one live draft at a time. Draft facts can only be
appended through narrow database functions. A mistaken draft can be abandoned
with a permanent reason and replaced; its facts are retained. Submission locks the draft, checks
completeness, assigns its already-reserved client version and fixes the entire
record; corrections use a later version rather than rewriting it.

- A CDD case belongs to one client and snapshots the client name/details used,
  intended relationship, reason for the checks, preparer and governing firm
  control versions. Later client edits make review due; they never rewrite the
  earlier evidence.
- Subjects can be individuals or legal entities and state their relationship:
  client, authorised representative, director/senior manager, beneficial owner,
  trustee, settlor, beneficiary, protector, funder or other controller.
- Organisation cases record legal form, governing law, registration, registered
  and principal offices, constitutional evidence, directors/senior managers
  and a traversable ownership/control structure. Percentages alone are not the
  only control test.
- A person acting for a client needs separately verified identity and evidence
  of authority. An active organisation contact is not treated as authority.
- Verification records state what reliable independent source was used, when,
  by whom, method, assurance outcome and expiry where relevant. Exact document
  identifiers and provider payloads are encrypted; list responses show only
  safe type, country, dates and status.
- Evidence files use the existing malware/type inspection and encrypted object
  storage, but separate AML metadata, authorization and encryption context.
  They can never become ordinary matter documents or be shared with a client.
- Electronic identity results record the certified provider and service at the
  time of the check. Stass stores the result and hash needed to demonstrate the
  check, not unnecessary biometric templates or a reusable identity profile.
- Reliance on another regulated person records eligibility, written agreement,
  requested/received underlying evidence and review. It does not transfer the
  firm's responsibility and does not apply to sanctions liability.

An individual subject requires a name and date of birth. A legal entity
requires its name, legal form, governing law, registered office and principal
office; registration number is recorded where one exists. The one subject
marked `client` must match the client record's individual/organisation kind.
Every submitted subject needs a current successful verification backed by
case-local evidence. Every authorised representative also needs a case-local
authority record and evidence. Ownership/control edges join two subjects from
the same case, require the owned subject to be a legal entity, and keep both an
optional percentage and a non-percentage control basis.

Submission snapshots the current client record and the latest in-period,
Partner-approved ML/TF, PF, sanctions, AML-policy and sanctions-policy versions.
It fails closed if any required control is absent or expired. The snapshot and
control links are historical evidence; later client or control edits do not
rewrite them. Step 15c will turn relevant later changes into the live
`review_due` gate state.

## Client and matter risk, CDD and EDD

Each submitted assessment is a permanent version with:

- whether the matter is within AML scope, and the reason;
- client, beneficial ownership/control and representative risks;
- service, delivery-channel, geography and jurisdiction risks;
- purpose, intended nature, expected duration and frequency;
- expected transaction size, funding routes and third-party involvement;
- PEP/family/close-associate, high-risk-country, unusual complexity,
  anonymity, cash, remote-instruction and adverse-information factors;
- sanctions exposure, including counterparties and ownership/control;
- the rating, narrative rationale, mitigations, required checks and monitoring
  frequency; and
- the firm-risk and reference-list versions used.

The system validates completeness and mandatory consequences, not whether a
human judgement is substantively correct. It refuses a low/standard rating for
a mandatory high-risk condition, clearance with unfinished required measures,
or a reason copied as empty/generic boilerplate. Compliance can raise a rating;
lowering one requires explicit grounds and a new approval.

CDD measures are discrete requirements with evidence and outcomes rather than
one `verified` flag. They cover identity, beneficial ownership, authority,
purpose/nature and whatever risk-based checks the assessment requires.
Enhanced measures include additional independent sources, deeper ownership and
financial background, transaction reasons, source of funds/wealth, enhanced
monitoring and senior-management approval as applicable.

Source of funds describes the specific money used in a matter or transaction;
source of wealth describes how the relevant person accumulated their overall
wealth. Each conclusion links to evidence, amount/range, relevant person,
reviewer and written reasoning. A bank statement by itself is evidence of a
route, not automatic proof of legitimacy.

The high-risk-country reference is versioned rather than hard-coded. As at this
design, SRA guidance says the definition changed on 30 June 2026 to FATF
jurisdictions subject to a call for action. A later legal change must create a
new reference version and queue affected records for review.

## Clearance and ongoing monitoring

- Compliance clearance fixes the assessment, required measures, evidence and
  approvals it relied on. A superseded or expired input makes the live status
  `review_due`; it does not alter the historical clearance.
- High-risk and PEP relationships require a different active partner's senior-
  management approval. The preparer, Compliance reviewer and partner are fixed
  on the record; no one approves twice merely by holding several roles.
- Review dates come from the approved risk plan and firm policy, not a universal
  interval guessed by Stass. Overdue review blocks new money actions and warns
  before it blocks other work according to the policy version.
- Review is also triggered by relevant client edits, changed ownership or
  authority, new matters, a changed service/purpose, unusual or unexpectedly
  large finance activity, third-party money, expired evidence, PEP/sanctions
  changes, contradictory facts or a staff concern.
- Finance records remain the source of transaction truth. Compliance links
  monitoring conclusions to immutable transaction/payment ids and never copies
  bank details, payees or narratives into a broad compliance list or audit.
- A hold records the affected client/matter/action scope, imposing actor,
  start/end and protected reason. Holds are insert-only events. Ordinary APIs
  receive a generic refusal and cannot distinguish suspicion, sanctions,
  missing CDD or another protected compliance reason.

## Sanctions controls

- A background worker downloads the official machine-readable UK Sanctions
  List over HTTPS, bounds its size and fields, validates it, stores its source
  publication time and SHA-256 hash, and atomically activates the immutable
  parsed version. A failed refresh leaves the last good version and raises a
  visible stale-list incident; it never activates partial data.
- Screening covers clients, beneficial owners/controllers, representatives,
  counterparties, third-party funders and intended recipients. Staff onboarding
  screening is included once HR is designed; this module does not expose HR
  data.
- Matching uses normalized names and aliases plus available date, nationality,
  address and identifier facts. It creates candidates, not automatic legal
  conclusions. Exact-name absence cannot clear an ownership/control concern.
- A result fixes the searched subject facts, list version, candidates and human
  resolution. False-positive reasoning is tied to the designation and
  distinguishing facts so a later list or identity change can invalidate it.
- Every newly activated list queues affected active subjects for rescreening.
  New onboarding and money-release actions fail closed while the required list
  is stale or screening is pending. Risk policy controls additional periodic
  screening.
- A likely match creates an immediate hold. Compliance records whether it is a
  false positive, unresolved or confirmed. Confirmed cases also record frozen
  assets, external report references and applicable licence/exception terms.
- Licence records contain authority, regime, reference, permitted activity,
  amount/fee limits, effective/expiry dates, reporting conditions and the fixed
  source document. Every permitted action checks the live licence conditions;
  expiry cannot be overridden by editing the record.
- A SAR never substitutes for a sanctions report, and a sanctions report never
  substitutes for a SAR. Stass tracks them as different restricted decisions.

## Internal disclosures and external SAR/DAML decisions

- Any active staff account can submit an internal disclosure with the relevant
  client/matter/transaction ids, observed facts, date and protected attachments.
  The report is encrypted before PostgreSQL and becomes immutable on submit.
- The reporter receives only a neutral receipt and cannot reopen the narrative.
  No ordinary task, email, notification count, matter history or client portal
  entry is created. Nominated officers have a separate queue.
- Only a live nominated officer can decrypt, view or decide a report. Every
  view is audited with the report id but not its subject or content.
- The decision records whether an external SAR was required, the legal grounds,
  decision maker and time. When submitted externally it stores the NCA
  acknowledgement/reference, submission time and whether a DAML/DATF was
  requested. The SAR text stays in the NCA portal or a separately uploaded
  encrypted fixed copy if firm policy requires it.
- DAML/DATF status changes are permanent events with received time, external
  reference, outcome, permitted activity and applicable expiry/deadline. No
  transaction is released merely because a waiting period elapsed; an
  authorised officer must record the actual legal basis.
- A decision not to report keeps its protected rationale. An ordinary matter
  closure or client exit record uses an independently supportable reason and
  never refers to the report, in line with SAR confidentiality guidance.
- Stass does not draft suspicion for the reporter, score whether a SAR is
  needed, submit to the NCA, or show a countdown whose wording reveals that a
  report exists.

## Data protection, retention and disposal

- AML narratives, identity identifiers, provider responses, adverse information,
  source evidence and internal disclosures use an AML-specific AES-256-GCM key
  outside PostgreSQL with record/purpose context binding. Files remain encrypted
  in private object storage with a distinct compliance object namespace.
- Response schemas allow-list fields. Logs, audit metadata, URLs, email and
  ordinary notifications exclude names searched, document numbers, PEP or hit
  status, risk reasons, source-of-funds/wealth detail, suspicion, SAR data and
  licence/report narratives.
- Before production the firm records its Article 6 basis, relevant Article 9
  and Article 10/Schedule 1 conditions, privacy information and appropriate
  policy document for special-category and criminal-offence data. Stass cannot
  infer those governance decisions.
- Each client relationship has an evidenced end date for AML retention. Each
  record receives `dispose_after` from the governing rule. A legal hold is a
  permanent event with authority, scope and review date, not an editable flag.
- Disposal is a narrow, audited database function plus object deletion and key
  erasure. It removes protected content while retaining only ids, record kind,
  governing rule, disposal time and actor. Direct app or owner deletion remains
  refused outside that path.
- Exports are fixed, audited regulatory bundles available only to Compliance or
  a nominated officer as appropriate. They carry restrictive attachment and
  no-store headers and never combine SAR material with ordinary CDD exports.

## Database and concurrency rules

- PostgreSQL supplies ids and trusted times. Submitted assessments, evidence
  versions, approvals, screenings, holds, officer decisions and external-status
  events are append-only. Corrections supersede; they do not rewrite history.
- Security-definer functions recheck and lock the active account, role or
  nominated-officer appointment on every protected action. Role removal,
  account disable and the action therefore commit in a defined order.
- Clearance takes locks on the client, matter, current assessment, subjects,
  required checks, sanctions results and approvals before inserting its fixed
  snapshot. A concurrent change cannot be missed.
- Work and Finance functions lock the matter/client compliance gate before
  accepting a change. A hold and a payment cannot each commit believing it won
  the race.
- The application role gets no direct write access to final compliance tables.
  Owner-level update/delete/truncate triggers protect history, except the
  explicit retention-disposal path for content whose deletion is required.
- Confidential row existence is not exposed by 403/404 differences, list
  counts, paging cursors or timing-sensitive preliminary queries.

## Audit

Planned ordinary event families:

- `aml.control_published`, `aml.control_approved`, `aml.training_recorded`;
- `aml.cdd_submitted`, `aml.risk_submitted`, `aml.clearance_approved`,
  `aml.clearance_refused`, `aml.review_completed`;
- `aml.sanctions_list_activated`, `aml.screening_resolved`,
  `aml.sanctions_hold_applied`, `aml.licence_recorded`;
- `aml.evidence_viewed`, `aml.exported`, `aml.record_disposed`.

Metadata contains ids, version numbers, safe states and counts only. It never
copies subject identity, evidence, risk rationale, source information or match
facts. Change and audit share one transaction.

Suspicion actions use the generic family `compliance.restricted_record_changed`
and a random restricted-record id. Only nominated officers can resolve that id
to an internal report. Sensitive views use a separate insert-only access log
available only to nominated officers; they do not put SAR facts into the wider
audit log read by all Compliance holders.

## API and screens

- Client and matter screens show their compliance gate, review due date and the
  actions the current staff member may take. They do not expose restricted
  reasons. Onboarding screens collect identity/ownership subjects, evidence,
  tailored risk, CDD/EDD measures and approval history.
- Compliance gets firm-control, due-review, CDD/EDD, sanctions-candidate,
  frozen-funds, licence and training dashboards. Nominated officers get a
  separately authorized restricted-report queue with no global count elsewhere.
- Accounts sees only the operational outcome needed for Finance: allowed,
  frozen or contact Compliance, plus approved licence constraints. It does not
  see risk narratives, candidate names or SAR state.
- Lists use keyset paging and safe summaries. Sensitive detail and file routes
  set no-store and restrictive download headers and audit successful access.
- Regulatory exports are generated server-side from fixed records. There are
  no client-facing Compliance routes and no compliance data in general search.

Proposed route families include `/compliance/controls`, `/compliance/training`,
`/clients/:id/cdd`, `/clients/:id/aml-risk`, `/matters/:id/aml-risk`,
`/compliance/reviews`, `/compliance/sanctions`, `/compliance/holds` and the
separately guarded `/compliance/restricted-reports`. Exact request/response
schemas are fixed during their implementation step.

## Notifications

- Due CDD, expiring evidence, training and ordinary compliance-review work may
  create in-app notifications for the named staff account. Email remains
  generic and contains no client name, AML status or link token.
- Sanctions refresh failures and unresolved operational holds notify active
  Compliance holders and, where money is frozen, Accounts. The message says
  only that a protected Compliance action is required.
- Internal disclosures and SAR/DAML work never use the ordinary notification
  or email outbox. Nominated officers find them only after entering the
  separately authorized queue.

## Not in the first version

- Automatic submission to the NCA SAR Portal, OFSI, OTSI, SRA or another
  regulator.
- A commercial identity, PEP, adverse-media or global-sanctions subscription.
  Provider adapters may be added later without changing the evidence model.
- Automated adverse-media scraping, facial recognition, biometric-template
  storage, liveness decisions or AI-generated risk/SAR conclusions.
- Screening foreign sanctions lists unless the firm's approved risk framework
  selects and governs them; the UK Sanctions List is the first built source.
- Trust-register, Companies House or Land Registry API integration. Evidence
  from them can be recorded manually first.
- A legal opinion on AML scope, privilege, whether suspicion exists, whether a
  licence applies, or when the firm may terminate a retainer.
- HR vetting beyond a future integration point for staff sanctions screening.

## Step 15a API

- Administrators use `GET/POST /compliance/officers` and
  `POST /compliance/officers/:id/end`. The target must be an active Compliance
  holder. Administrators receive appointment metadata only, not firm-control
  content.
- Compliance uses `GET/POST /compliance/controls` and
  `GET /compliance/controls/:id`. Each kind receives a database-serialized
  version number; content, source, dates, preparer, trusted publication time
  and SHA-256 digest are fixed.
- Partners use `GET /compliance/controls/pending-approval` and
  `POST /compliance/controls/:id/approval`. PostgreSQL rechecks the active
  Partner role and refuses self-approval and repeat approval.
- Any active member of staff can use `POST /compliance/training` for their own
  completion and `GET /compliance/training/me`. Compliance can record and list
  completions firm-wide. A completion requires an approved training-material
  version and cannot be future-dated or duplicated.
- Compliance uses `GET/POST /compliance/independent-reviews`. Reviewer,
  organisation, independence basis, period, scope, findings, recommendations,
  management response and completion are fixed together.

List routes return stable 100-row keyset pages with an optional `before` UUID
and a nullable `next` cursor, so older regulatory records are never silently
hidden by a fixed result cap.

All request bodies are strict and bounded. Multi-line document fields allow
ordinary line breaks but reject unsafe control and text-direction characters.
PostgreSQL recalculates the SHA-256 digest relationship and validates supported
date ranges even when a database function is called directly. All responses
are allow-listed and carry the API's global `no-store` header.

## Step 15a verification

HTTP tests cover role boundaries, appointment eligibility, version numbering,
Partner separation, approved-material training, self-attestation,
firm-wide-list restrictions, independent reviews and safe responses. Database
tests run with both application and owner roles to prove direct-write denial,
immutable history, live-role rechecks, separate approval and the protected
last nominated officer. The appointment database spec runs serially because
the last-holder rule is intentionally firm-wide.

Thirteen deliberate application and migration breaks were caught and restored:
permission mapping, route separation, hidden text, cursor filtering, audit
action, digest matching, owner immutability, preparer/approver separation,
training date and approval requirements, last-officer continuity, serialized
version allocation and live-role enforcement. A clean database then passed the
complete API suite (78 files, 1,662 tests). API and web type-checks and
production builds passed, together with all 77 Playwright browser tests, the
offline production audit (zero cached vulnerabilities), and the
hidden-character and diff checks.

## Step 15b API

- `POST /clients/:clientId/cdd` creates the client's sole live draft from
  bounded `intendedRelationship` and `reason` narratives. `GET` on the same
  path returns 100 newest safe summaries with a `before` UUID cursor.
- `GET /clients/:clientId/cdd/:caseId` returns the authorised protected detail,
  including its subjects, evidence metadata, ownership/control edges,
  authorities, verifications, snapshot and governing controls.
- `POST /clients/:clientId/cdd/:caseId/abandon` permanently closes a mistaken
  draft with a reason, allowing the next client version to be prepared without
  deleting its already collected evidence.
- Draft-only `POST` routes under that case add `/subjects`, `/ownership`,
  `/authorities` and `/verifications`. Bodies are strict. Electronic checks
  require their provider and service. Reliance records require eligibility,
  agreement, underlying-evidence and review facts.
- `POST /clients/:clientId/cdd/:caseId/evidence` is a streaming multipart
  upload. Metadata fields precede one `file`. It accepts the same inspected
  types and 50 MB limit as ordinary documents, fails closed when ClamAV is
  unavailable, and enforces 200 files / 2 GiB per uploader per hour under a
  database advisory lock.
- `GET /clients/:clientId/cdd/:caseId/evidence/:evidenceId/content` streams an
  authorised attachment with restrictive headers and records
  `aml.evidence_viewed`. `POST .../submit` performs the locked completeness and
  current-control checks and records `aml.cdd_submitted` transactionally.
- Other audit events: `aml.cdd_draft_created`, `aml.cdd_draft_abandoned`,
  `aml.evidence_uploaded`, `aml.evidence_refused` and
  `aml.evidence_upload_limited`.

`aml.assess` permits Partners and fee earners only for clients they already see;
Compliance can prepare firm-wide. `aml.view_evidence` follows the same client
record rule. Accounts and administrators get neither permission. A hidden or
cross-client case/evidence answers 404 without revealing whether it exists;
an already submitted draft answers 409 to an otherwise authorised caller.

Subject details, exact evidence metadata, authority/control narratives,
document identifiers, provider results and reliance facts are AES-256-GCM
encrypted with record-and-purpose context under `AML_ENCRYPTION_KEY`. Evidence
files use per-file keys wrapped by that same AML master key and random
`compliance/<uuid>` object keys, rather than the ordinary document key or
namespace. Configuration refuses to reuse another application encryption key.
Only safe type, country, dates, state and counts appear in list or audit data;
file names and exact identifiers are decrypted only on protected detail or
download paths.

## Step 15b verification

Focused HTTP tests cover client visibility, Compliance firm-wide access,
permission denial, strict inputs, safe summaries, individual and organisation
flows, ownership/control traversal, representative authority, manual and
electronic verification, cross-case references, evidence upload/download,
submission snapshots, current controls, immutability and safe audit metadata.
Database tests use both application and owner roles to prove protected-only
inserts, live-role rechecks, context binding, case-local graph nodes,
future-date rejection, final-history immutability and serialized single-draft
creation. Cipher and object-storage tests prove context/key separation,
non-plaintext ciphertext, the private compliance namespace and streaming
round trips.

## Build order

Every implementation step gets positive and negative tests, concurrency and
owner-role probes for database safeguards, deliberate breaks of its controls,
and updated documentation before the next step.

- **15a. Built 2026-10-10.** Permissions, nominated-officer appointments,
  fixed firm-wide risk/policy versions, Partner approval, training records and
  independent-review records.
- **15b. Built 2026-10-10.** Versioned client CDD cases, people/entity subjects,
  ownership/control, authority, manual/electronic identity verification,
  reliance facts and separately encrypted protected evidence storage.
- **15c.** Versioned client/matter risk assessments, scope, CDD/EDD and source
  evidence, multi-party approval, compliance gate, exceptional limited start
  and ongoing-review queue.
- **15d.** Official UK Sanctions List import, candidate screening/resolution,
  rescreening, holds, frozen funds, licence conditions and Finance enforcement.
- **15e.** Encrypted internal disclosures, nominated-officer access, external
  SAR/DAML decision/status records and confidentiality-safe holds.
- **15f.** Retention/legal holds/disposal, regulatory exports, staff and
  Compliance screens, safe notifications, narrow-screen and accessibility
  tests.
- Security review against the then-current MLR, SRA/LSAG, sanctions, NCA and
  data-protection guidance.

## Approval

The project owner approved the design on 10 October 2026. That approval covers
the staged build above; it does not appoint a real nominated officer, approve a
firm policy, make a regulatory decision or authorise an external submission.
