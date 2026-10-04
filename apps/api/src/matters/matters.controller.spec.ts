import { randomUUID } from 'node:crypto';
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
  let clientName: { givenNames: string; familyName: string };

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
  /** Runs a conflict check for the matter's client and other parties, then opens it. */
  async function open(sessionToken: string, overrides: { clientId?: string; parties?: { role: string; kind: string; name: string }[] } & object = {}) {
    const clientId = overrides.clientId ?? client.id;
    const names = (overrides.parties ?? []).map((party) => party.name);
    const check = await as(sessionToken).post('/conflict-checks', { clientId, names: names.length > 0 ? names : [uniqueName()] });
    return as(sessionToken).post('/matters', matter({ conflictCheckId: check.body.id, ...overrides }));
  }
  const PLACEHOLDER_CHECK = { conflictCheckId: '00000000-0000-7000-8000-000000000000' };
  const uniqueName = () => randomUUID().replaceAll('-', '').slice(0, 16);

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
    clientName = { givenNames: uniqueName(), familyName: uniqueName() };
    client = (await as(token).post('/clients', { kind: 'individual', ...clientName })).body;
  });

  describe('POST /matters', () => {
    it("opens a matter numbered after the client, with the opener and the supervising partner on the team", async () => {
      const opened = await open(token);

      expect(opened.status).toBe(201);
      expect(opened.body).toEqual({ id: expect.any(String), reference: `${client.reference}/001`, status: 'open' });
      const found = await as(token).get(`/matters/${opened.body.id}`);
      expect(found.body).toMatchObject({
        reference: `${client.reference}/001`,
        title: 'Purchase of 12 High Street',
        matterType: 'residential_property',
        status: 'open',
        client: { id: client.id, reference: client.reference, kind: 'individual', name: `${clientName.givenNames} ${clientName.familyName}` },
      });
      expect(found.body.team.map((member: { accountId: string; role: string }) => [member.accountId, member.role])).toEqual([
        [partner.id, 'supervising_partner'],
        [feeEarner.id, 'fee_earner'],
      ]);
    });

    it('numbers the next matter for the same client', async () => {
      await open(token);

      expect((await open(token)).body.reference).toBe(`${client.reference}/002`);
    });

    it('records the opening and every team member, without the title', async () => {
      const opened = await open(token);

      const events = await db
        .selectFrom('audit_events')
        .select(['actor_id', 'action', 'metadata'])
        .where('resource_id', '=', opened.body.id)
        .orderBy('id')
        .execute();
      expect(events).toEqual([
        {
          actor_id: feeEarner.id,
          action: 'matter.opened',
          metadata: { clientId: client.id, matterType: 'residential_property', status: 'open', conflictCheckId: expect.any(String) },
        },
        { actor_id: feeEarner.id, action: 'matter.team_member_added', metadata: { accountId: partner.id, role: 'supervising_partner' } },
        { actor_id: feeEarner.id, action: 'matter.team_member_added', metadata: { accountId: feeEarner.id, role: 'fee_earner' } },
      ]);
      expect(JSON.stringify(events)).not.toContain('High Street');
    });

    it('lets a partner supervise their own matter, alone on the team', async () => {
      const partnersClient = (await as(await signedIn(partner)).post('/clients', { kind: 'individual', givenNames: uniqueName(), familyName: uniqueName() })).body;

      const opened = await open(await signedIn(partner), { clientId: partnersClient.id });

      const found = await as(await signedIn(partner)).get(`/matters/${opened.body.id}`);
      expect(found.body.team).toEqual([{ accountId: partner.id, displayName: expect.any(String), role: 'supervising_partner' }]);
    });

    it('does not find a client the opener cannot see', async () => {
      const other = await signedIn(await staffWith('fee_earner'));

      expect((await as(other).post('/matters', matter(PLACEHOLDER_CHECK))).status).toBe(404);
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
      expect((await open(token, await body())).status).toBe(400);
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
      expect((await open(token, overrides)).status).toBe(400);
      expect(await mattersOf(client.id)).toEqual([]);
    });

    it('opens nothing when the audit record cannot be written', async () => {
      const check = await as(token).post('/conflict-checks', { clientId: client.id, names: [uniqueName()] });
      vi.spyOn(app.get(AuditService), 'record').mockRejectedValueOnce(new Error('audit unavailable'));

      expect((await as(token).post('/matters', matter({ conflictCheckId: check.body.id }))).status).toBe(500);
      expect(await mattersOf(client.id)).toEqual([]);
    });

    it.each(['administrator', 'accounts', 'compliance'] as const)('is closed to %s', async (role) => {
      expect((await as(await signedIn(await staffWith(role))).post('/matters', matter(PLACEHOLDER_CHECK))).status).toBe(403);
    });
  });

  describe('conflict checks', () => {
    const check = (names: string[], sessionToken = token, clientId = client.id) =>
      as(sessionToken).post('/conflict-checks', { clientId, names });

    it("checks the names and the client's own name, recording counts but not names", async () => {
      const name = `Opponent ${uniqueName()}`;

      const response = await check([name]);

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ names: [`${clientName.givenNames} ${clientName.familyName}`, name], matches: [], matchCount: 0 });
      const events = await db
        .selectFrom('audit_events')
        .select(['action', 'metadata'])
        .where('actor_id', '=', feeEarner.id)
        .where('action', '=', 'matter.conflict_check_run')
        .execute();
      expect(events).toEqual([{ action: 'matter.conflict_check_run', metadata: { checkId: response.body.id, names: 2, matches: 0 } }]);
      expect(JSON.stringify(events)).not.toContain(name);
    });

    it("finds another person's client spelt differently, showing name and reference only", async () => {
      const token2 = uniqueName();
      const someoneElse = await signedIn(await staffWith('fee_earner'));
      const theirs = (await as(someoneElse).post('/clients', { kind: 'individual', givenNames: `John ${token2}`, familyName: 'Smith' })).body;

      const response = await check([`Jon ${token2} Smyth`]);

      expect(response.body.matches).toEqual([
        { checkedName: `Jon ${token2} Smyth`, matchedName: `John ${token2} Smith`, relation: 'client', clientReference: theirs.reference, matterReference: null },
      ]);
    });

    describe('opening on a check', () => {
      it('opens the matter as awaiting clearance when the check found a possible match, and shows the team why', async () => {
        const existing = uniqueName();
        await as(token).post('/clients', { kind: 'organisation', legalName: `${existing} Holdings`, organisationType: 'company' });
        const parties = [{ role: 'opponent', kind: 'organisation', name: `${existing} Holdings Ltd` }];

        const opened = await open(token, { parties });

        expect(opened.body.status).toBe('awaiting_clearance');
        const shown = await as(await signedIn(partner)).get(`/matters/${opened.body.id}/conflict-check`);
        expect(shown.body.matches).toEqual([expect.objectContaining({ checkedName: `${existing} Holdings Ltd`, relation: 'client' })]);
        expect((await as(await signedIn(await staffWith('partner'))).get(`/matters/${opened.body.id}/conflict-check`)).status).toBe(404);
      });

      it('records the other parties with the matter', async () => {
        const name = `Opponent ${uniqueName()}`;

        const opened = await open(token, { parties: [{ role: 'opponent', kind: 'individual', name }] });

        expect((await as(token).get(`/matters/${opened.body.id}`)).body.parties).toEqual([
          { id: expect.any(String), role: 'opponent', kind: 'individual', name },
        ]);
      });

      it('refuses a party who was not in the check', async () => {
        const checked = await check([`Checked ${uniqueName()}`]);

        const response = await as(token).post(
          '/matters',
          matter({ conflictCheckId: checked.body.id, parties: [{ role: 'opponent', kind: 'individual', name: `Unchecked ${uniqueName()}` }] }),
        );

        expect(response.status).toBe(400);
        expect(response.body.message).toBe('Every other party must have been in the conflict check');
        expect(await mattersOf(client.id)).toEqual([]);
      });

      it.each<[string, () => Promise<string>]>([
        ['made by someone else', async () => {
          const colleague = await staffWith('fee_earner');
          await db.insertInto('matter_team').values({ matter_id: (await open(token)).body.id, account_id: colleague.id, role: 'fee_earner', added_by: feeEarner.id }).execute();
          return (await check([uniqueName()], await signedIn(colleague))).body.id;
        }],
        ['for another client', async () => {
          const other = (await as(token).post('/clients', { kind: 'individual', givenNames: uniqueName(), familyName: uniqueName() })).body;
          return (await check([uniqueName()], token, other.id)).body.id;
        }],
        ['already used', async () => {
          const used = (await check([uniqueName()])).body.id;
          await as(token).post('/matters', matter({ conflictCheckId: used }));
          return used;
        }],
        ['that does not exist', async () => '00000000-0000-7000-8000-000000000000'],
      ])('refuses a check %s', async (_case, checkId) => {
        const id = await checkId();
        const before = (await mattersOf(client.id)).length;

        const response = await as(token).post('/matters', matter({ conflictCheckId: id }));

        expect(response.status).toBe(400);
        expect(response.body.message).toMatch(/conflict check must be your own/);
        expect(await mattersOf(client.id)).toHaveLength(before);
      });
    });

    it('counts towards the hourly search allowance', async () => {
      for (let search = 0; search < 60; search++) {
        await as(token).get(`/clients/search?q=${uniqueName()}`);
      }

      const response = await check([uniqueName()]);

      expect(response.status).toBe(429);
      expect(response.body.message).toBe('Too many client searches or conflict checks in the last hour. Try again later');
    });

    it('keeps the 50 strongest matches of a common name, and says how many there were', async () => {
      const response = await check(['Jane Doe']);

      expect(response.body.matchCount).toBeGreaterThan(50);
      expect(response.body.matches).toHaveLength(50);
    });

    it('does not check for a client the caller cannot see', async () => {
      expect((await check([uniqueName()], await signedIn(await staffWith('fee_earner')))).status).toBe(404);
    });

    it.each<[string, object]>([
      ['no names', { names: [] }],
      ['more than 20 names', { names: Array.from({ length: 21 }, () => uniqueName()) }],
      ['a name with a line break', { names: ['Jane\nDoe'] }],
      ['an extra field', { names: ['A B'], matches: [] }],
    ])('refuses %s', async (_case, body) => {
      expect((await as(token).post('/conflict-checks', { clientId: client.id, ...body })).status).toBe(400);
    });

    it.each(['administrator', 'accounts', 'compliance'] as const)('is closed to %s', async (role) => {
      expect((await check([uniqueName()], await signedIn(await staffWith(role)))).status).toBe(403);
    });
  });

  describe('seeing matters', () => {
    let matterId: string;

    beforeEach(async () => {
      matterId = (await open(token)).body.id;
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

      await open(token);

      expect((await as(partnerToken).get(`/clients/${client.id}`)).status).toBe(200);
    });

    it('keeps the client hidden from staff on no team', async () => {
      await open(token);

      expect((await as(await signedIn(await staffWith('partner'))).get(`/clients/${client.id}`)).status).toBe(404);
    });
  });
});
