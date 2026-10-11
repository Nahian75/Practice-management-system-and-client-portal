import { expect, type APIRequestContext } from '@playwright/test';
import { randomName } from './checks';
import { clearMatter } from './compliance';

/**
 * A matter opened through the API by whoever `api` is signed in as, with a
 * clear conflict check: a new client, and no other parties. Unless `cleared`
 * is false, its compliance gate is also cleared, so time, documents, billing
 * and money can be used on it.
 */
export async function openMatter(
  api: APIRequestContext,
  supervisingPartnerId: string,
  feeEarnerIds: string[] = [],
  clientOverrides: Record<string, unknown> = {},
  cleared = true,
) {
  const client = await api.post('/api/clients', { data: { kind: 'individual', givenNames: randomName(), familyName: randomName(), ...clientOverrides } });
  const clientId = ((await client.json()) as { id: string }).id;
  const check = await api.post('/api/conflict-checks', { data: { clientId, names: [randomName()] } });
  const title = `Matter ${randomName()}`;
  const opened = await api.post('/api/matters', {
    data: {
      clientId,
      title,
      matterType: 'other',
      supervisingPartnerId,
      feeEarnerIds,
      conflictCheckId: ((await check.json()) as { id: string }).id,
    },
  });
  expect(opened.status()).toBe(201);
  const matter = (await opened.json()) as { id: string; reference: string; status: string };
  if (cleared) await clearMatter(matter.id, clientId);
  return { ...matter, title, clientId };
}
