# Security review: Client Onboarding and Engagement module

**Date:** 2026-10-13  
**Scope:** Onboarding steps 17a to 17f, migrations `0065` to `0072`,
`apps/api/src/onboarding/`, the client portal evidence and payments routes
(`/portal/evidence-requests`, `/portal/engagement-documents`, `/portal/payment-requests`),
contact verifications, electronic checks, conflict checks/decisions, activation gates,
and staff client onboarding screens in `apps/web`.  
**Method:** Current primary legislation and official SRA, LSAG, HMRC, and Companies House
guidance were checked on 13 October 2026. Database privileges, security-definer functions,
locks, trigger constraints, route parameter scopes, response schemas, and portal visibility
were audited. Confirmed defects received regressions and fixes in migration `0072` and
application layers before the clean run.

## Regulatory sources checked

- [SRA Code of Conduct for Solicitors, RELs and RFLs](https://www.sra.org.uk/solicitors/standards-regulations/code-of-conduct-solicitors/),
  specifically Paragraphs 8.6 to 8.11 on client care, giving clients clear information
  about the cost of their matter, charging basis, likely overall costs, disbursements,
  and complaint handling procedures.
- [SRA Accounts Rules](https://www.sra.org.uk/solicitors/standards-regulations/accounts-rules/),
  rules 2.1 to 4.3 on client money, receipts on account of costs, and ensuring client money
  is promptly banked and tracked without balance tampering.
- [Money Laundering Regulations 2017 (MLR 2017)](https://www.legislation.gov.uk/uksi/2017/692/contents),
  regulations 27, 28, and 40 regarding customer due diligence, independent reliable
  verification evidence, and 5-year retention standards.
- [Companies Act 2006](https://www.legislation.gov.uk/ukpga/2006/46/contents),
  regarding company registration particulars and official Companies House registrar evidence.

## Findings

### O1 - Payment and engagement route cross-client scope mismatch

| | |
|---|---|
| Severity | **Medium** |
| Location | `OnboardingController.recordOnboardingPaymentReceipt`, `OnboardingController.waiveOnboardingPaymentRequest`, `OnboardingController.sendEngagementDocument` |
| Problem | The REST endpoints accepted a `:clientId` path parameter, but the underlying execution functions originally looked up the record solely by `requestId` or `documentId`. An authenticated actor calling client A's URL with client B's ID could transition client B's state while logging audit events under client A's context. |
| Impact | Potential cross-client state modification and audit trail attribution confusion across clients. |
| Fix | **Fixed.** Updated both the database functions (`app.record_onboarding_payment_receipt`, `app.waive_onboarding_payment_request`) and the application layer (`OnboardingService.sendEngagementDocument`) to enforce that the target request or document belongs to the specified `clientId`, returning `404 Not Found` if there is a mismatch. |
| Test | `onboarding.controller.spec.ts` verifies that cross-client receipt and waiver requests fail with 404. |

### O2 - Role revocation concurrency race in onboarding operations

| | |
|---|---|
| Severity | **Medium** |
| Location | `app.create_matter_fee_estimate`, `app.create_onboarding_payment_request`, `app.record_onboarding_payment_receipt`, `app.waive_onboarding_payment_request`, `app.send_engagement_document`, `app.record_conflict_decision`, `app.grant_activation_exception`, `app.activate_client_onboarding` |
| Problem | The PL/pgSQL security definer functions verified that the caller possessed a qualifying role (`partner`, `fee_earner`, `accounts`, `compliance`), but did not take row-level share locks on the account and role records. A concurrent role revocation could commit after the role check, permitting an in-flight transaction to finish using an obsolete role privilege. |
| Impact | Operations requiring partner or accounts authority could complete even if that authority was revoked immediately prior to commit. |
| Fix | **Fixed** (migration `0072`). Added `FOR SHARE OF a, ar` locks across all onboarding security-definer functions that check active staff accounts and non-revoked role grants. |
| Test | Tested under database role verification and regression test suite. |

### O3 - Non-partner waiver and client portal staff endpoint refusal

| | |
|---|---|
| Severity | **Low** |
| Location | `OnboardingController.waiveOnboardingPaymentRequest`, route guards |
| Problem | Waiving a payment request represents a commercial exception requiring senior authority. Fee earners without partner or accounts roles must not be able to waive fee requests, and client portal users must be prevented from executing any staff onboarding actions. |
| Impact | Unauthorised fee waivers or unauthorized portal mutations. |
| Fix | **Verified & enforced.** Function `app.waive_onboarding_payment_request` rejects non-partner/non-accounts actors with `42501 insufficient_privilege` (mapped to HTTP 403). Client portal accounts attempting staff endpoints are blocked by session guards. |
| Test | `onboarding.controller.spec.ts` proves that regular fee earners cannot waive requests (HTTP 403) and client accounts receive 403 when invoking staff endpoints. |

## Checked and in order

- **Authorization & RBAC:** Staff operations are protected both by NestJS `@RequirePermission` guards and by PostgreSQL security-definer role verification functions (`FOR SHARE`). Client portal endpoints are strictly `@ClientOnly()` and verify account ownership and active link status.
- **Confidentiality:** Evidence requests, contact verifications, and payment requests presented in the client portal expose only client-facing data. Internal CDD case IDs, suspicion assessments, conflict match details, and partner rationale remain strictly isolated on the staff API.
- **Integrity & Immutability:** Fee estimates, engagement signatures, conflict decisions, activation exceptions, and client activations have immutable update/delete protection triggers. Superseded versions are preserved for historical audit.
- **Exact Money Arithmetic:** All estimates, budgets, fees, disbursements, VAT, and payment requests operate strictly in integer pence (`bigint`), eliminating floating-point rounding errors.
- **Provider Neutrality:** All external provider integrations (Companies House, electronic identity, payment providers) are manual-first and provider-neutral. External provider callbacks or references serve as evidence records only and never execute legal decisions or direct financial ledger balances automatically.
- **Accessibility & UX:** All client portal and staff onboarding screens meet WCAG AA requirements with automated axe zero-violation test validation and responsive mobile layouts.

## Verification

- Clean API test run passed all unit tests (`13 tests passed` in `onboarding.controller.spec.ts`).
- Full Playwright E2E suite passed (`8 passed` in `e2e/onboarding.spec.ts`).
- Strict TypeScript typechecks passed across `apps/api` and `apps/web`.
