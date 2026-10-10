# Compliance and AML

**Current state (2026-10-10):** First-version design proposed for project-owner
approval. Nothing in this document is implemented yet. Step 15a is the first
planned implementation step.

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

## Roles and proposed permissions

Permission names are not added to code until their implementation step.

| Permission | Administrator | Partner | Fee earner | Accounts | Compliance |
|---|---:|---:|---:|---:|---:|
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
  encrypted or private stored file. Published versions are immutable and a new
  version supersedes rather than edits one.
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

## Build order

Every implementation step gets positive and negative tests, concurrency and
owner-role probes for database safeguards, deliberate breaks of its controls,
and updated documentation before the next step.

- **15a.** Permissions, nominated-officer appointments, fixed firm-wide risk/
  policy versions, partner approval, training records and independent-review
  records.
- **15b.** Client CDD cases, people/entity subjects, ownership/control,
  authority, identity verification and protected evidence storage.
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

## Approval needed

Implementation should not begin until the project owner approves the decisions
above, especially the separate nominated-officer appointment, onboarding matter
gate, dual approval for exceptional early work, official-list ingestion,
external-only regulator submission and controlled five-year disposal model.
