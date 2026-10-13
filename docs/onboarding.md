# Client onboarding and engagement

**Current state (2026-10-13):** This is the approved target design from the
UK Law Firm Developer Requirements Addendum. The existing Compliance / AML,
conflicts, documents, portal and Finance controls remain the foundation. Step
17a is in progress; later step 17 work is not yet available to users.

Stass must make the onboarding decision visible and reviewable without
pretending that a document upload, a database result or a vendor response is a
legal or professional decision. A client can provide evidence and sign firm
documents. Staff and Compliance decide whether the evidence is acceptable and
whether the firm may act.

## Approved operating assumptions

- The first complete route is provider-neutral and manual-first. Optional
  provider connections are enabled only after the firm selects and contracts
  with that provider and configures its credentials.
- Companies House data is independent company evidence, not an AML clearance.
  Inconsistencies are shown for human review and never silently overwrite the
  client record.
- Bangladesh and other overseas evidence uses a documented manual or approved
  commercial-provider route. Stass never says "government verified" unless an
  authorised, live government integration actually supplied that result.
- Email contact verification proves control of the email channel at a point in
  time. It is not identity verification. Phone verification is optional and is
  available only when an SMS provider is configured.
- A client upload, e-signature, liveness result or provider pass never marks
  AML complete. The existing written matter assessment, measures, sanctions
  work and Compliance clearance remain authoritative.
- Client money and office money remain separate. A payment-provider event is
  recorded and reconciled through the existing protected Finance ledger; it
  does not post or reverse money by editing a balance.

## Onboarding sequence

The default sequence is configurable by matter type and jurisdiction:

```text
client record
  -> conflict search and resolution
  -> email contact verification (optional phone OTP when configured)
  -> individual identity or company evidence
  -> client and matter AML/risk work
  -> Compliance approval
  -> letter of authority / client-care letter / fee agreement
  -> signature review
  -> initial invoice or payment request
  -> activation and ongoing monitoring
```

Requirements have a visible state, responsible reviewer, evidence reference,
last event time and due date. Missing and overdue mandatory requirements block
activation. An exception is a separate, reasoned, time-limited approval; it
does not edit the underlying failed or missing result. The existing conflict,
AML, sanctions and client-money gates remain independently enforceable.

## Policy library

The existing immutable firm-control library is expanded instead of creating a
second policy store. It covers AML, sanctions, conflicts, client care,
complaints, confidentiality, data protection, retention, information security
and Finance, alongside firm risk assessments and training material.

Each version fixes its category, title, content hash, source, owner, effective
date, review date, preparer and separate Partner approval. A policy can require
staff acknowledgement within a configured number of days. Acknowledgements
name the exact immutable version and are themselves insert-only. Staff see
only approved effective policies; Compliance can report who has and has not
acknowledged a version.

## Contact verification

Staff send a single-use, expiring email link to the address currently recorded
for an individual client or an organisation contact. The record keeps the
channel, address snapshot, request time, expiry, attempts and successful time.
A later address change makes that result stale rather than transferring it to
the new address. Rate limits apply per staff actor, client and destination.

The client and staff screens say "email verified", never "identity verified".
Phone OTP is hidden until a real SMS provider is selected and configured.

## Identity and company evidence

Staff issue explicit evidence requests. A linked portal account may upload only
against an open request for one of its authorised clients or matters. Files use
the existing streaming type inspection, malware scan, encrypted object storage,
size limits and audit controls. They are never placed in ordinary shared
documents and are not downloadable through the general portal.

Supported request types include passport, driving licence, proof of address,
company certificate, authority evidence, source evidence and an explicitly
described additional item. Staff review records outcome, reviewer, time,
reason, exceptions and the evidence ids used. Rejection preserves history and
allows a replacement request.

Electronic checks record provider, service, provider reference, document type,
check date, result, optional liveness result, evidence match, exception and raw
response hash. Raw identity images remain protected by the AML evidence and
retention controls. A manual review route always exists.

For UK companies, an optional Companies House adapter reads the official API
when a key is configured. The returned snapshot and retrieval time are fixed;
differences in name, number, registered office or officers are listed for human
resolution. Overseas companies use uploaded registry evidence or an approved
provider. Beneficial-owner conclusions remain in CDD.

## Conflict checks

The check covers current and former clients, contacts, counterparties,
connected persons, companies and related matters using normalised and fuzzy
names plus recorded aliases. Results are `clear`, `potential`, `escalated`,
`approved_with_controls` or `cannot_act`.

Every non-clear result keeps reviewer, decision time, rationale and safeguards.
Unresolved, escalated or cannot-act results block activation. Search results
show only the references needed to review a match; confidential matter detail
does not leak through the search.

## Engagement documents and signatures

Approved templates generate a letter of authority, client-care letter, fee
agreement, estimate and initial invoice from allow-listed client, matter, firm
and fee fields. The exact template version, input snapshot, generated PDF hash
and generator are fixed.

Letter/signature states are `draft`, `sent`, `viewed`, `signed`, `declined`,
`expired` and `verified`. The complete signed PDF, signer, times and evidence
are retained. The provider-neutral route supports download, wet signature and
secure upload. Staff approve or reject the returned signature with a reason.
An e-sign provider adapter may add provider evidence later without changing the
review boundary.

## Initial fees and payments

Matter setup records consultation, fixed or hourly charging, estimates,
budgets, disbursements and VAT using exact integer money. The fee agreement and
estimate snapshot the approved rates and assumptions. Initial invoices and
payment requests use the existing Finance posting, approval and reconciliation
controls. Provider references are evidence only. Reversals are new ledger
events, never deletion or balance edits.

## Delivery stages

- **17a. In progress.** Expanded policy library, owners, acknowledgement rules
  and staff acknowledgement evidence; configurable matter-type/jurisdiction
  requirement plans follow in this stage.
- **17b.** Email contact verification and secure portal evidence requests and
  uploads.
- **17c.** Manual identity/company reviews, provider result records and the
  optional Companies House adapter.
- **17d.** Wider conflict subjects, decision outcomes, safeguards and the
  combined activation gate.
- **17e.** Versioned templates, generated engagement documents, wet-sign return
  and review; optional e-sign adapter boundary.
- **17f.** Estimates, budgets, initial fees/payment handoff and staff/client
  screens.
- **Security review.** Authorization, confidentiality, provider callbacks,
  upload safety, concurrency, retention, gate bypasses and full regression.

## Provider configuration still requiring a firm choice

The provider-independent route will run without these services. Live phone
OTP, automated identity/liveness, e-sign and card/open-banking collection need
the firm to choose providers and supply sandbox/production credentials,
callback secrets and approved retention terms. Those capabilities must remain
visibly unavailable until configured; Stass must not simulate a successful
external check.

