# Security review: Compliance and AML module

**Date:** 2026-10-11  
**Scope:** Compliance steps 15a to 15f, migrations `0048` to `0058`,
`apps/api/src/compliance/`, the AML gates in Finance/Documents, protected object
storage, exports and all staff Compliance screens.  
**Method:** current primary legislation and official SRA, LSAG, NCA, UK
government sanctions and ICO guidance were checked on 11 October 2026. Database
privileges, security-definer functions, locks, encryption contexts, object
namespaces, response schemas, downloads, audit/access logs and screen visibility
were read. Confirmed defects received regressions and fixes before the clean run.

## Sources checked

- [Money Laundering Regulations 2017, regulation 40](https://www.legislation.gov.uk/uksi/2017/692/regulation/40)
  requires the relevant CDD and transaction-supporting records for five years
  from completion/end of relationship and then deletion of personal data unless
  an enactment, court/legal-proceedings need or consent exception applies.
- [SRA client and matter risk-assessment warning notice](https://www.sra.org.uk/solicitors/guidance/client-and-matter-risk-assessments/)
  requires early, written, tailored assessments that reflect firm risk and
  determine CDD/EDD and monitoring; generic tick-box scoring is inadequate.
- [SRA AML/LSAG guidance collection](https://www.sra.org.uk/solicitors/resources/money-laundering/guidance-support/)
  identifies the Treasury-approved 2025 LSAG guidance as current official legal-
  sector guidance.
- [SRA financial-sanctions guidance](https://www.sra.org.uk/solicitors/guidance/financial-sanctions-regime/)
  applies to every regulated firm and stresses that licences/exceptions and each
  applicable regime must be considered rather than treating AML checks as enough.
- [UK government sanctions collection](https://www.gov.uk/government/collections/uk-sanctions)
  confirms that the UK Sanctions List is the sole source for UK designations
  from 28 January 2026 and links current regimes, licensing and reporting.
- [NCA suspicious-activity-report guidance](https://www.nationalcrimeagency.gov.uk/what-we-do/crime-threats/money-laundering-and-illicit-finance/suspicious-activity-reports)
  keeps submission and live DAML/DATF handling in the official SAR channels.
- [ICO storage-limitation guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-protection-principles/a-guide-to-the-data-protection-principles/storage-limitation/)
  requires justified periods, periodic review and actual deletion or
  anonymisation rather than indefinite/offline retention.
- [ICO criminal-offence-data guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/criminal-offence-data/what-are-the-rules-on-criminal-offence-data/)
  requires an Article 6 basis plus official authority or a DPA 2018 Schedule 1
  condition, with DPIA/accountability obligations where risk warrants it.

## Findings

### C1 - Legal-hold state used UUID order instead of event time

| | |
|---|---|
| Severity | **High** |
| Problem | The initial 15f migration selected the “latest” imposed/reviewed/released event with `ORDER BY id DESC`. UUIDv7 usually follows time but is not the legal event clock and test UUIDs are random, so a released hold could appear active or an active event could appear released. |
| Impact | Disposal could be wrongly refused or, in the unsafe ordering, proceed while a legal hold remained active. |
| Fix | **Fixed.** Every latest-event query and the index now order by trusted `recorded_at DESC, id DESC`; history reads are chronological. |
| Test | The focused migration test imposes, reviews and releases a hold before disposal. The original ordering failed that test and was restored. |

### C2 - Object deletion and database finalization did not share one lock scope

| | |
|---|---|
| Severity | **High** |
| Problem | Preparation originally committed before private-object deletion. New CDD/report content could be attached before finalization, leaving an undeleted object or silently deleting a just-created database record. |
| Impact | A protected file could become an orphan outside the retention record, or a concurrent disclosure could be erased without its object/key appearing in the prepared set. |
| Fix | **Fixed.** The service now keeps prepare, object deletion, finalization and audit in one database transaction. Preparation takes the client advisory lock, `FOR UPDATE` locks the client and every matter, and locks every AML parent row through which child content can be attached. Existing CDD/report functions take conflicting client/matter/parent locks. A concurrent submission waits; once disposal commits it is inserted as a new retained record rather than being swept into the completed run. |
| Test | The database concurrency regression holds disposal open, starts a disclosure on another connection, proves it cannot commit, finalizes, then proves the disclosure commits and remains. |

### C3 - A mixed client-wide AML schedule allowed unsupported 6-10 year retention

| | |
|---|---|
| Severity | **Medium** |
| Problem | The initial schedule accepted 6-10 years for the entire AML file. Regulation 40 sets five years for CDD and the relationship records in this bundle; its narrower ten-year ceiling for specified transaction records is not a general permission to retain all personal data. Free-text “governing rule” did not prove an exception. |
| Impact | CDD, identity and suspicion-related personal data could be kept longer than the implemented purpose justified. |
| Fix | **Fixed.** The database and request schema now accept exactly five years. Enactment, court/legal-proceedings or other approved exceptions use an evidenced, reviewed legal-hold event. |
| Test | HTTP rejects six years and PostgreSQL retains the exact derived-date constraint. |

### C4 - Incomplete disposal evidence and firm governance remain deployment controls

| | |
|---|---|
| Severity | **Information / before production** |
| Items | Live object/database deletion is implemented, but the hosting design must define backup expiry and restoration-time re-disposal so erased data is put beyond use in backups. The firm must document its Article 6 basis, any Article 9/10 and Schedule 1 condition, appropriate policy document, DPIA decision, privacy information, real MLRO/nominated-officer appointment, retention exceptions and review ownership. Stass cannot make those legal/governance choices. |

## Checked and in order

- **Authorization:** ordinary AML permissions are role-derived and repeated in
  protected functions; restricted reads/actions require both active Compliance
  and a live nominated-officer appointment. Unknown/forbidden restricted ids
  remain indistinguishable. The bounded Compliance client picker exposes four
  fields only and rechecks the role in PostgreSQL.
- **Confidentiality:** ordinary AML and suspicion material use distinct keys,
  contexts, tables, object namespaces and export paths. Restricted existence is
  absent from normal search, portal, email, task/notification lists and the
  ordinary attention count. Queue summaries contain no facts or client name.
- **Integrity and history:** submitted CDD, assessments, decisions, sanctions
  results, holds, SAR/DAML events and approvals are insert-only. Separation of
  preparer/reviewer/partner remains database-enforced. Disposal is the single,
  explicit exception and leaves complete content-free tombstones for independent
  records that had ids.
- **Sanctions:** the importer uses the current sole UK Sanctions List, bounded
  validated CSV and atomic activation. Human resolution, ownership/control,
  freezes and live licence conditions remain distinct from SAR decisions.
- **Exports and downloads:** ordinary and restricted bundles never mix; stored
  bytes are authenticated ciphertext with SHA-256. Downloads verify integrity
  and send attachment, `private, no-store`, `nosniff` and sandbox CSP headers.
- **Screens:** role/capability checks determine navigation; the reporter receives
  only a neutral receipt; irreversible disposal requires explicit confirmation;
  narrow screens do not overflow and axe found no automated violations.
- **No external submission:** Stass records that an external filing occurred but
  does not draft or send a SAR, DAML/DATF request, sanctions report or licence
  request. Official portals remain authoritative.

## Verification

- The clean API database was recreated from all migrations. The deterministic
  full run passed **101 test files and 1,821 tests**. API production build and
  API/web strict type-checks passed.
- The production web build and full Playwright run passed **83 of 83 tests**.
  The Compliance journeys cover neutral reporting, ordinary work, a complete
  protected CDD workflow, retention and separately authorized restricted work,
  with axe and narrow-layout checks.
- Five deliberate 15f control mutations each caused its focused regression to
  fail and were restored: UUID-only legal-hold order, 6-10-year retention,
  removal of `no-store`, restricted-report leakage into the ordinary count and
  omission of the nominated-officer disposal check.
- The all-files hidden-character check, `git diff --check`, and the offline
  production dependency audit passed; the cached audit reported zero
  vulnerabilities.
- No commit was made by this review.
