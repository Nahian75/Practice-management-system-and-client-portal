import { createHash } from 'node:crypto';
import { expect, test as setup } from '@playwright/test';
import { isoDay } from './support/compliance';
import { apiSessionFor } from './support/session';

// Runs once, before any test, so parallel workers never publish competing
// versions: approving a newer control makes every cleared matter due for review.
setup('publishes the approved AML framework every matter clearance relies on', async ({ request }) => {
  const compliance = await apiSessionFor(request, ['compliance']);
  const partner = await apiSessionFor(request, ['partner']);
  for (const kind of ['ml_tf_risk_assessment', 'proliferation_financing_risk_assessment',
    'sanctions_risk_assessment', 'aml_policy', 'sanctions_policy']) {
    const content = `End-to-end ${kind} framework.`;
    const created = await compliance.api.post('/api/compliance/controls', {
      data: { kind, title: `E2E ${kind}`, content, source: 'End-to-end test fixture', effectiveFrom: isoDay(), reviewDueOn: '2099-12-31' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id, contentSha256 } = (await created.json()) as { id: string; contentSha256: string };
    expect(contentSha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect((await partner.api.post(`/api/compliance/controls/${id}/approval`)).status()).toBe(201);
  }
  const list = await compliance.api.post('/api/compliance/country-lists', {
    data: { countries: ['QZ'], source: 'End-to-end test fixture', effectiveFrom: isoDay() },
  });
  expect(list.status(), await list.text()).toBe(201);
  expect((await partner.api.post(`/api/compliance/country-lists/${((await list.json()) as { id: string }).id}/approval`)).status()).toBe(201);
});
