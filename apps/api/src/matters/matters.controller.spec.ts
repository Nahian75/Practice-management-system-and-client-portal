import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAccount, grantTestRole, setAccountStatus, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { ClientsModule } from '../clients/clients.module.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { MattersModule } from './matters.module.js';

@Module({ imports: [ClientsModule, MattersModule] })
class ClientsAndMattersModule {}

describe('Matters', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let feeEarner: TestAccount;
  let token: string;
  let partner: TestAccount;
  let client: { id: string; reference: string };

  const as = (sessionToken: string) => {
    const server = request(app.getHttpServer());
    const cookie = `__Host-session=${sessionToken}`;
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie),
      post: (path: string, body?: object) => server.post(path).set('Cookie', cookie).send(body),
    };
  };
  const signedIn = (account: TestAccount) => sessions.start(account, 'authenticated', {});

  async function staffWith(...roles: StaffRole[]): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) {
      await grantTestRole(db, account.id, role);
    }
    return account;
  }

  const matter = (overrides: object = {}) => ({
    clientId: client.id,
    title: 'Purchase of 12 High Street',
    matterType: 'residential_property',
    supervisingPartnerId: partner.id,
    ...overrides,
  });
  const mattersOf = (clientId: string) => db.selectFrom('matters').select('id').where('client_id', '=', clientId).execute();

  beforeAll(async () => {
    app = await createTestApp(ClientsAndMattersModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    feeEarner = await staffWith('fee_earner');
    token = await signedIn(feeEarner);
    partner = await staffWith('partner');
    client = (await as(token).post('/clients', { kind: 'individual', givenNames: 'Jane', familyName: 'Doe' })).body;
  });

  describe('POST /matters', () => {
    it("opens a matter numbered after the client, with the opener and the supervising partner on the team", async () => {
      const opened = await as(token).post('/matters', matter());

      expect(opened.status).toBe(201);
      expect(opened.body).toEqual({ id: expect.any(String), reference: `${client.reference}/001`, status: 'open' });
      const found = await as(token).get(`/matters/${opened.body.id}`);
      expect(found.body).toMatchObject({
        reference: `${client.reference}/001`,
        title: 'Purchase of 12 High Street',
        matterType: 'residential_property',
        status: 'open',
        client: { id: client.id, reference: client.reference, kind: 'individual', name: 'Jane Doe' },
      });
      expect(found.body.team.map((member: { accountId: string; role: string }) => [member.accountId, member.role])).toEqual([
        [partner.id, 'supervising_partner'],
        [feeEarner.id, 'fee_earner'],
      ]);
    });

    it('numbers the next matter for the same client', async () => {
      await as(token).post('/matters', matter());

      expect((await as(token).post('/matters', matter())).body.reference).toBe(`${client.reference}/002`);
    });

    it('records the opening and every team member, without the title', async () => {
      const opened = await as(token).post('/matters', matter());

      const events = await db
        .selectFrom('audit_events')
        .select(['actor_id', 'action', 'metadata'])
        .where('resource_id', '=', opened.body.id)
        .orderBy('id')
        .execute();
      expect(events).toEqual([
        { actor_id: feeEarner.id, action: 'matter.opened', metadata: { clientId: client.id, matterType: 'residential_property', status: 'open' } },
        { actor_id: feeEarner.id, action: 'matter.team_member_added', metadata: { accountId: partner.id, role: 'supervising_partner' } },
        { actor_id: feeEarner.id, action: 'matter.team_member_added', metadata: { accountId: feeEarner.id, role: 'fee_earner' } },
      ]);
      expect(JSON.stringify(events)).not.toContain('High Street');
    });

    it('lets a partner supervise their own matter, alone on the team', async () => {
      const partnersClient = (await as(await signedIn(partner)).post('/clients', { kind: 'individual', givenNames: 'A', familyName: 'B' })).body;

      const opened = await as(await signedIn(partner)).post('/matters', matter({ clientId: partnersClient.id }));

      const found = await as(await signedIn(partner)).get(`/matters/${opened.body.id}`);
      expect(found.body.team).toEqual([{ accountId: partner.id, displayName: expect.any(String), role: 'supervising_partner' }]);
    });

    it('does not find a client the opener cannot see', async () => {
      const other = await signedIn(await staffWith('fee_earner'));

      expect((await as(other).post('/matters', matter())).status).toBe(404);
      expect(await mattersOf(client.id)).toEqual([]);
    });

    it.each<[string, () => Promise<object>]>([
      ['a fee earner as supervising partner', async () => matter({ supervisingPartnerId: (await staffWith('fee_earner')).id })],
      ['a disabled partner', async () => {
        const disabled = await staffWith('partner');
        await setAccountStatus(db, disabled.id, 'disabled');
        return matter({ supervisingPartnerId: disabled.id });
      }],
      ['someone from accounts as fee earner', async () => matter({ feeEarnerIds: [(await staffWith('accounts')).id] })],
      ['a client account as fee earner', async () => matter({ feeEarnerIds: [(await createTestAccount(db, 'client')).id] })],
      ['an account that does not exist', async () => matter({ feeEarnerIds: ['00000000-0000-7000-8000-000000000000'] })],
    ])('refuses %s, and opens nothing', async (_case, body) => {
      expect((await as(token).post('/matters', await body())).status).toBe(400);
      expect(await mattersOf(client.id)).toEqual([]);
    });

    it.each<[string, object]>([
      ['a reference', { reference: 'C-000001/001' }],
      ['a status', { status: 'open' }],
      ['an unknown matter type', { matterType: 'tax' }],
      ['the same fee earner twice', { feeEarnerIds: ['00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000001'] }],
      ['more than 20 fee earners', { feeEarnerIds: Array.from({ length: 21 }, (_, i) => `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`) }],
      ['a title with a line break', { title: 'Purchase\nof a house' }],
    ])('refuses %s in the body', async (_case, overrides) => {
      expect((await as(token).post('/matters', matter(overrides))).status).toBe(400);
      expect(await mattersOf(client.id)).toEqual([]);
    });

    it('opens nothing when the audit record cannot be written', async () => {
      vi.spyOn(app.get(AuditService), 'record').mockRejectedValueOnce(new Error('audit unavailable'));

      expect((await as(token).post('/matters', matter())).status).toBe(500);
      expect(await mattersOf(client.id)).toEqual([]);
    });

    it.each(['administrator', 'accounts', 'compliance'] as const)('is closed to %s', async (role) => {
      expect((await as(await signedIn(await staffWith(role))).post('/matters', matter())).status).toBe(403);
    });
  });

  describe('seeing matters', () => {
    let matterId: string;

    beforeEach(async () => {
      matterId = (await as(token).post('/matters', matter())).body.id;
    });

    it('is not found by a partner who is not on the team, with the same answer as a matter that does not exist', async () => {
      const outsider = await signedIn(await staffWith('partner'));

      const response = await as(outsider).get(`/matters/${matterId}`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual((await as(outsider).get('/matters/00000000-0000-7000-8000-000000000000')).body);
    });

    it('lists only matters you are on the team of', async () => {
      const outsider = await signedIn(await staffWith('fee_earner'));

      expect((await as(token).get('/matters')).body.matters.map((m: { id: string }) => m.id)).toEqual([matterId]);
      expect((await as(outsider).get('/matters')).body).toEqual({ matters: [], next: null });
    });

    it("lists a client's matters you are on the team of", async () => {
      const response = await as(await signedIn(partner)).get(`/clients/${client.id}/matters`);

      expect(response.status).toBe(200);
      expect(response.body.matters.map((m: { id: string }) => m.id)).toEqual([matterId]);
    });

    it("does not list a client's matters to someone who cannot see the client", async () => {
      expect((await as(await signedIn(await staffWith('partner'))).get(`/clients/${client.id}/matters`)).status).toBe(404);
    });
  });

  describe('client visibility through matter teams', () => {
    it('lets a team member open the client, who could not before', async () => {
      const partnerToken = await signedIn(partner);
      expect((await as(partnerToken).get(`/clients/${client.id}`)).status).toBe(404);

      await as(token).post('/matters', matter());

      expect((await as(partnerToken).get(`/clients/${client.id}`)).status).toBe(200);
    });

    it('keeps the client hidden from staff on no team', async () => {
      await as(token).post('/matters', matter());

      expect((await as(await signedIn(await staffWith('partner'))).get(`/clients/${client.id}`)).status).toBe(404);
    });
  });
});
