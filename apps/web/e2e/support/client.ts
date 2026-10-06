import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomName } from './checks';
import { apiSessionFor } from './session';
import { emailedToken, totp } from './staff';

export interface TestClient {
  email: string;
  displayName: string;
  password: string;
  backupCode: string;
}

/** A client account, its live portal link and one open matter, all made through the API. */
export async function clientWithMatter(request: APIRequestContext) {
  const partner = await apiSessionFor(request, ['partner']);
  const feeEarner = await apiSessionFor(request);
  const familyName = randomName();
  const email = `e2e-portal-${randomUUID()}@example.com`;
  const displayName = `Jane ${familyName}`;
  const created = await feeEarner.api.post('/api/clients', {
    data: { kind: 'individual', givenNames: 'Jane', familyName, email },
  });
  expect(created.status()).toBe(201);
  const clientId = ((await created.json()) as { id: string }).id;
  const check = await feeEarner.api.post('/api/conflict-checks', { data: { clientId, names: [randomName()] } });
  expect(check.status()).toBe(201);
  const title = `Advice ${randomName()}`;
  const opened = await feeEarner.api.post('/api/matters', {
    data: {
      clientId,
      title,
      matterType: 'litigation',
      supervisingPartnerId: partner.accountId,
      conflictCheckId: ((await check.json()) as { id: string }).id,
    },
  });
  expect(opened.status()).toBe(201);
  const matter = { ...((await opened.json()) as { id: string; reference: string }), title };

  const granted = await feeEarner.api.post(`/api/clients/${clientId}/portal-access`, { data: {} });
  expect(granted.status()).toBe(201);
  const linkId = ((await granted.json()) as { id: string }).id;
  const token = await emailedToken(email, '/accept-invitation');
  const password = `quiet-client-${randomUUID()}`;
  const passwordStep = await request.post('/api/auth/invitations/password', { data: { token, password } });
  expect(passwordStep.status()).toBe(200);
  const { twoFactor } = (await passwordStep.json()) as { twoFactor: { secret: string } };
  const completed = await request.post('/api/auth/invitations/complete', { data: { token, code: totp(twoFactor.secret) } });
  expect(completed.status()).toBe(200);
  const { backupCodes } = (await completed.json()) as { backupCodes: string[] };
  const backupCode = backupCodes[0];
  if (!backupCode) {
    throw new Error('The client account was given no backup codes');
  }

  return {
    client: { email, displayName, password, backupCode } satisfies TestClient,
    clientId,
    linkId,
    matter,
    partner,
    feeEarner,
  };
}

/** Signs a client in through the page and expects the portal to be their destination. */
export async function signInClient(page: Page, client: TestClient): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(client.email);
  await page.getByLabel('Password').fill(client.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Security code').fill(client.backupCode);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/portal$/);
}

/** Signs a client into this browser context through the API, leaving routing out of the fixture. */
export async function clientSession(api: APIRequestContext, client: TestClient): Promise<void> {
  expect((await api.post('/api/auth/sign-in', { data: { email: client.email, password: client.password } })).status()).toBe(200);
  expect((await api.post('/api/auth/two-factor', { data: { code: client.backupCode } })).status()).toBe(200);
}
