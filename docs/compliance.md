# Compliance and AML

**Current state (2026-10-11):** The project owner approved this first-version
design. Steps 15a to 15c are built: permissions, protected nominated-officer and
deputy appointments, fixed firm-control versions with separate Partner approval,
training completions and independent-review records; versioned client CDD,
encrypted identity facts and separately protected evidence; high-risk-country
lists, matter risk assessments, CDD/EDD measures and source-of-funds/wealth
conclusions; Compliance clearance with senior-management approval; and a
compliance gate that PostgreSQL enforces on time, billing, documents and money,
with holds, an early-start exception and a review queue. Step 15d-1 imports the
official UK Sanctions List and step 15d-2 screens clients and their CDD subjects
against it. Step 15d-3 and steps 15e and 15f remain planned.

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
| `aml.approve` - clear or refuse a matter assessment firm-wide (step 15c-3) | | | | | yes |
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
- `aml.country_list_published`, `aml.country_list_approved`;
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

## Step 15c-1 API

- Compliance uses `GET/POST /compliance/country-lists` to publish a numbered
  high-risk-country list: ISO codes, the source it was copied from and an
  effective date. Codes are sorted and must be distinct. A Partner other than
  the preparer approves it with `POST /compliance/country-lists/:id/approval`;
  `GET /compliance/country-lists/pending-approval` lists unapproved versions.
  An assessment uses the latest approved version already in force.
- `POST /matters/:matterId/aml-risk` fixes a permanent assessment version for a
  matter the caller's team holds, or any matter for Compliance. It records AML
  scope, the rating, eight risk-factor flags, the jurisdictions involved, an
  expected-value band, a review date within five years and a grace period of 0
  to 90 days. Ten written answers, plus grounds when lowering a rating, are
  encrypted under `AML_ENCRYPTION_KEY` with context `aml-risk:<id>`.
- `GET /matters/:matterId/aml-risk` lists 100 safe summaries without the
  written answers; `GET /matters/:matterId/aml-risk/:id` returns the detail.
  Unknown and hidden matters both answer 404.

PostgreSQL decides the version, whether a jurisdiction is on the current list,
which submitted CDD case is relied on, whether the rating was lowered, and which
five firm controls and which country list governed the assessment. It refuses:

- a rating other than `high` for a PEP, unusual transactions or a listed
  jurisdiction, the cases where regulation 33 requires enhanced due diligence;
- in-scope work for a client without a submitted CDD case;
- a lower rating than the previous version without written grounds;
- a closed matter, a missing current control or country list, or a review date
  outside the next five years.

The API also refuses written answers shorter than 20 characters and the same
text given for two questions, since copied text shows a question was not
considered. Audit metadata holds only the matter id and version: the rating is
left out because it can reveal PEP or high-risk-country status.

## Step 15c-1 verification

Database tests prove sorted and distinct country codes, separate partner
approval, refused direct writes for the application and owner (including later
in a transaction that called a protected function), fixed versions and
governing controls, forced high ratings, CDD reliance, lowering grounds,
matter-team access, closed-matter refusal, context binding, serialized
concurrent versions and owner immutability. HTTP tests cover permissions,
hidden matters, sorted lists, narrative-free summaries, ciphertext and audit
content, copied answers and the in-scope and lowering rules. Each database
safeguard and the copied-answer check was deliberately broken once in the
test database or a restored file copy, and a test failed each time.

## Step 15c-2 API

- `POST /matters/:matterId/aml-risk/:assessmentId/measures` adds a discrete
  measure (`identity`, `beneficial_ownership`, `authority`, `purpose_nature`,
  `ongoing_monitoring`, the enhanced kinds `additional_sources`,
  `ownership_background`, `transaction_reasons`, `source_of_funds`,
  `source_of_wealth`, `enhanced_monitoring`, or `other`) with an encrypted
  description.
- `POST .../measures/:measureId/results` records `satisfied` or
  `not_satisfied` with encrypted reasoning and up to 50 evidence ids. Results are
  append-only; the latest one counts.
- `POST .../sources` records a source-of-funds or source-of-wealth conclusion:
  the relevant person from the relied-on CDD case, a pence range, outcome,
  evidence and encrypted reasoning.
- `GET .../work` returns the measures, their results and the conclusions.

Work is accepted only for the latest assessment version of an open matter the
caller's team holds, or any matter for Compliance. Evidence and people must come
from the CDD case the assessment relies on; an assessment without one accepts
no evidence links. An assessment named under the wrong matter answers 404.
Audit metadata holds only the matter id, because even a measure's kind can hint
at PEP or high-risk status. All three tables are insert-only through protected
functions and immutable for the owner.

## Step 15c-3 API

- `POST /matters/:matterId/aml-risk/:assessmentId/clearance` (`aml.approve`,
  Compliance only) records `approved` or `refused` with encrypted reasoning.
  The preparer can never clear their own assessment, and an assessment gets one
  decision. Approval fixes the ids of the latest measure results and source
  conclusions it relied on.
- `POST .../clearance/senior-approval` (`aml.firm_approve`, Partner) adds the
  senior-management approval a high-risk or PEP clearance needs. The partner
  must be neither the preparer nor the Compliance approver, and need not be on
  the matter team.
- `GET .../clearance` returns the decision or `{clearance: null}`;
  `GET /matters/:matterId/aml-gate` returns the live gate.

PostgreSQL refuses approval unless the assessment is the matter's latest, its
review date has not passed, and its governing controls, country list and CDD
case are still current. In addition:

- every measure's latest result and every latest source conclusion is satisfied;
- in-scope work has identity, beneficial-ownership and purpose measures;
- high risk has an enhanced-monitoring measure and another enhanced measure,
  plus a source-of-funds conclusion unless no money is expected;
- a PEP has a source-of-wealth conclusion.

The gate is `pending` without an approved clearance (with senior approval where
needed). It is `review_due` from the earliest day a relied-on input changed: the
review date, a newer assessment version or CDD case, an edit to the client's
identity details, or a superseded or expired control or country list. Other
work continues for the assessment's grace period: `workAllowedUntil` is the last
allowed day, so a grace of 0 blocks at once. Money is blocked at once. Otherwise
the gate is `cleared`.

## Step 15c-4 enforcement and API

A `BEFORE INSERT` trigger on each gated table asks PostgreSQL for the gate:

| Work | Tables | Allowed when |
|---|---|---|
| Time | `time_entries` | cleared; review due within grace; pending with an approved early start for time |
| Documents | `documents`, `document_versions` | cleared; review due within grace; pending with an approved early start for documents |
| Billing | `bill_drafts`, `issued_bills` | cleared; review due within grace |
| Money | `client_payment_requests`, approved `client_payment_events`, ledger allocations in `finance_transactions` | cleared only |

Bank-confirmed receipts, bank outcomes and credit notes stay recordable: they
record what already happened, and refusing them would hide it. Tasks are not
gated. Every refusal is the same `check_violation`, which the ordinary APIs
return as a generic 409, so a hold cannot be told apart from missing CDD or an
overdue review. Gate checks take shared advisory locks on the matter and client
that holds, assessments and clearances take exclusively, so a hold and a payment
commit in a defined order.

- `POST /compliance/holds` (`aml.approve`) holds one matter (`matterId`) or a
  whole client (`clientId`) with an encrypted reason; `POST
  /compliance/holds/:holdId/lift` lifts it once. `GET /compliance/holds` lists
  active holds (`?all=true` for every hold). The gate is `held` first.
- `POST /matters/:matterId/aml-risk/:assessmentId/start-exceptions`
  (`aml.approve`) grants an early start for `time` and/or `documents`, never
  money, for at most 30 days, on a current low or standard assessment without
  mandatory high-risk factors, by someone other than the preparer, while no hold
  is active. `POST /matters/:matterId/start-exceptions/:id/approval` needs a
  Partner other than the granter and preparer. A newer assessment version ends it.
- `GET /compliance/reviews` (`aml.approve`) lists open matters that are pending,
  held, due for review or due within 30 days, 100 at a time, newest first, with a
  `before` cursor (changed in step 15d-2, so a long backlog never hides a matter).

Audit metadata for holds is empty, so the audit log does not show which client
or matter is held.

When the migration runs, every open matter without a clearance becomes
`pending`, as decided: there is no grandfathering.

## Step 15d-1 sanctions list

Stass reads the official CSV published at
`https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv`. Its first line is
`Report Date: DD-Mon-YYYY`, then a header row, then one row per name and address
of each designation; one `Unique ID` spans many rows. Columns are found by
header name, so a reordered file still parses and a renamed required column is
refused. The parser streams the file (the 8 October 2026 list is 50 MB, with
6,406 designations and 15,551 distinct names, and parses in about 1.5 seconds),
stops at 150 MB, and keeps only what screening needs: each designation's id,
type, regime, designation date, birth dates (a year, year and month, or full
date), nationalities, and its distinct names with their normalized form and
word tokens. Control and text-direction characters are replaced rather than
refusing the official file.

- With `SANCTIONS_LIST_URL` set, the API downloads the list on start and every
  six hours over HTTPS, with a two-minute timeout, no redirects and the size
  limit. Unset, lists are only uploaded by hand.
- `POST /compliance/sanctions/lists` (`aml.sanctions`, Compliance) uploads the CSV
  as multipart `file`. `GET /compliance/sanctions/status` returns the active
  version, last success and failure, and `fresh`; `GET
  /compliance/sanctions/lists` lists versions.
- One PostgreSQL function imports a list in one transaction, so a partial list
  is never visible. An identical file is recorded as `unchanged`. A list whose
  report date is older than the active one is refused and the refusal recorded.
- Every import, unchanged check and failure is kept. The list is `fresh` while
  a check succeeded in the last 48 hours. A failed refresh leaves the last good
  version active and is visible in the status.

## Step 15d-2 screening

Each client is screened as its client record (name and date of birth) and as
every subject of its latest submitted CDD case. CDD names are decrypted in the
API only to search; they are never stored with a result, and the audit record
holds only the client id and how many subjects were screened, never a name or a
match.

- **Matching** proposes candidates for a person to resolve. A list name is a
  candidate when it equals the subject's normalized name, or when both have at
  least two words and every word of the shorter appears in the longer. One shared
  word never matches. A date of birth is recorded as `match`, `conflict` or
  `unknown` against the designation's (often partial) dates, but never used to
  dismiss a match.
- **When:** submitting a CDD case screens that client at once. Every newly
  activated list rescreens every client with an open matter in the background.
  `POST /compliance/sanctions/clients/:clientId/screenings` (`aml.sanctions`)
  screens on demand.
- **Resolution:** `GET /compliance/sanctions/candidates` lists unresolved
  candidates on each subject's latest screening; `POST
  /compliance/sanctions/candidates/:id/resolution` records `false_positive` or
  `confirmed` with encrypted reasoning, once, by a live Compliance holder. A false
  positive carries forward to later screenings only for the same subject and
  designation, and only while neither has changed since: a client edit, a newer
  CDD case or any change to the designation's names, kind or dates reopens it.

`app.aml_sanctions_state` gives each client one position, worst first:
`confirmed`, `possible_match`, `stale` (no fresh list), `unscreened` (the client
record or a CDD subject has no screening against the active list since its
identity last changed), or `clear`. A confirmed match stays in force across new
lists. Its effects:

- `possible_match` or `confirmed` makes every matter of the client `held`, so
  all gated work stops with the same generic refusal as any other hold.
- Clearance needs `clear`, enforced by a trigger on every clearance insert.
- Money needs `clear` as well as a cleared gate. A new list therefore blocks money,
  but not other work, until the client is rescreened.

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
- **15c. Built 2026-10-11.** Versioned client/matter risk assessments, scope, CDD/EDD and source
  evidence, multi-party approval, compliance gate, exceptional limited start
  and ongoing-review queue. Built in four parts:
  - **15c-1. Built 2026-10-10.** Partner-approved high-risk-country list
    versions and permanent matter risk-assessment versions.
  - **15c-2. Built 2026-10-10.** Discrete CDD/EDD measures and source-of-funds/wealth conclusions.
  - **15c-3. Built 2026-10-11.** Compliance and senior-management clearance, its fixed snapshot
    and the live gate state.
  - **15c-4. Built 2026-10-11.** Gate enforcement in time, billing, documents and Finance, the
    early-verification exception and the ongoing-review queue.

  Decisions confirmed by the project owner on 10 October 2026:
  - When the gate is enforced, matters already open without clearance become
    `pending` and are blocked until cleared. There is no grandfathering.
  - The gate does not block tasks, so staff can chase onboarding work.
  - Compliance enters each high-risk-country list version by hand with its
    source, and a different active partner approves it. Nothing is downloaded.
  - An overdue review blocks money movement at once. Time, documents and
    billing continue for a grace period of 0 to 90 days fixed in the approved
    assessment's monitoring plan.
- **15d.** Official UK Sanctions List import, candidate screening/resolution,
  rescreening, holds, frozen funds, licence conditions and Finance enforcement.
  Built in three parts:
  - **15d-1. Built 2026-10-11.** List import, versions, scheduled refresh and
    staleness.
  - **15d-2. Built 2026-10-11.** Screening of clients and CDD subjects, candidate resolution,
    rescreening on each new list, and sanctions holds in the gate.
  - **15d-3.** Confirmed designations: frozen funds, licences and Finance
    enforcement.
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
