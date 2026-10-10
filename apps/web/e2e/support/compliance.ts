import { expect, type APIRequestContext } from '@playwright/test';
import { apiSessionFor } from './session';

/** A date `days` from today as YYYY-MM-DD. Close enough to London's date for the generous limits used here. */
export const isoDay = (days = 0) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

type Officers = { preparer: APIRequestContext; approver: APIRequestContext };
let officers: Promise<Officers> | undefined;

/** Two Compliance holders per worker: one assesses, the other clears, as the database requires. */
function complianceOfficers(request: APIRequestContext): Promise<Officers> {
  officers ??= (async () => ({
    preparer: (await apiSessionFor(request, ['compliance'])).api,
    approver: (await apiSessionFor(request, ['compliance'])).api,
  }))();
  return officers;
}

/**
 * Clears a matter's compliance gate through the real API, as a firm would for
 * low-risk work outside the Money Laundering Regulations: an assessment by one
 * Compliance holder, cleared by another. The AML framework comes from aml.setup.ts.
 */
export async function clearMatter(request: APIRequestContext, matterId: string): Promise<void> {
  const { preparer, approver } = await complianceOfficers(request);
  const assessed = await preparer.post(`/api/matters/${matterId}/aml-risk`, {
    data: {
      inScope: false, rating: 'standard', jurisdictions: ['GB'], expectedValue: 'under_10k',
      reviewDueOn: isoDay(365), reviewGraceDays: 30,
      factors: { pep: false, unusualTransactions: false, complexStructure: false, cash: false,
        remoteInstruction: false, adverseInformation: false, sanctionsExposure: false, thirdPartyFunding: false },
      narrative: {
        scopeReason: 'End-to-end test work is not a regulated-sector service.',
        clientRisk: 'A test client created for this browser test only.',
        serviceRisk: 'Ordinary advice delivered through the staff application.',
        purposeAndNature: 'A short matter used to exercise one screen.',
        fundingRisk: 'Any test money comes from the client account set up by the test.',
        sanctionsExposure: 'No counterparties connected with a designated person.',
        rationale: 'Standard risk: a known test client and transparent funding.',
        mitigations: 'Payments only to and from accounts the test creates.',
        requiredChecks: 'No checks beyond this assessment are needed for test data.',
        monitoringPlan: 'The matter is discarded when the test database is recreated.',
        loweringGrounds: null,
      },
    },
  });
  expect(assessed.status(), await assessed.text()).toBe(201);
  const { id } = (await assessed.json()) as { id: string };
  const cleared = await approver.post(`/api/matters/${matterId}/aml-risk/${id}/clearance`, {
    data: { decision: 'approved', reasoning: 'Out of scope and standard risk; work may proceed.' },
  });
  expect(cleared.status(), await cleared.text()).toBe(201);
}
