import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAccount, grantTestRole, setAccountStatus, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { testAppDatabaseUrl } from '../../test/database.js';
import { inbox } from '../../test/mailpit.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { ClientsModule } from '../clients/clients.module.js';
import { createDatabase } from '../database/database.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { MailOutbox } from '../mail/mail-outbox.js';
import { MattersModule } from './matters.module.js';
import { MattersRepository } from './matters.repository.js';

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

  const failAudit = (action: string) => {
    const service = app.get(AuditService);
    const record = service.record.bind(service);
    return vi.spyOn(service, 'record').mockImplementation((event, transaction) =>
      event.action === action ? Promise.reject(new Error('audit unavailable')) : record(event, transaction),
    );
  };
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
      const audit = failAudit('matter.opened');
      let response: request.Response;
      try {
        response = await as(token).post('/matters', matter({ conflictCheckId: check.body.id }));
      } finally {
        audit.mockRestore();
      }

      expect(response!.status).toBe(500);
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
      expect(events).toEqual([
        { action: 'matter.conflict_check_run', metadata: { checkId: response.body.id, names: 2, matches: 0, units: 1 } },
      ]);
      expect(JSON.stringify(events)).not.toContain(name);
    });

    it("finds another person's client spelt differently, showing name and reference only", async () => {
      const token2 = uniqueName();
      const someoneElse = await signedIn(await staffWith('fee_earner'));
      const theirs = (await as(someoneElse).post('/clients', { kind: 'individual', givenNames: `John ${token2}`, familyName: 'Smith' })).body;

      const response = await check([`Jon ${token2} Smyth`]);

      // Contains, not equals: "John <random> Smith" clients from earlier runs can score near the threshold too.
      expect(response.body.matches).toContainEqual({
        checkedName: `Jon ${token2} Smyth`,
        matchedName: `John ${token2} Smith`,
        relation: 'client',
        clientReference: theirs.reference,
        matterReference: null,
      });
    });

    describe('opening on a check', () => {
      it('opens the matter as awaiting clearance when the check found a possible match, and shows the team why', async () => {
        const existing = uniqueName();
        await as(token).post('/clients', { kind: 'organisation', legalName: `${existing} Holdings`, organisationType: 'company' });
        const parties = [{ role: 'opponent', kind: 'organisation', name: `${existing} Holdings Ltd` }];

        const opened = await open(token, { parties });

        expect(opened.body.status).toBe('awaiting_clearance');
        const shown = await as(await signedIn(partner)).get(`/matters/${opened.body.id}/conflict-check`);
        // Contains, not equals: the client's own random name can be near another test's now and then.
        expect(shown.body.matches).toContainEqual(expect.objectContaining({ checkedName: `${existing} Holdings Ltd`, relation: 'client' }));
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

    // Review M2: one name is one unit of the 60-an-hour allowance shared with client search.
    it('counts each name checked towards the hourly allowance', async () => {
      const twenty = () => Array.from({ length: 20 }, () => uniqueName());

      for (let checkNumber = 0; checkNumber < 3; checkNumber++) {
        expect((await check(twenty())).status).toBe(201);
      }

      expect((await check([uniqueName()])).status).toBe(429);
      expect((await as(token).get(`/clients/search?q=${uniqueName()}`)).status).toBe(429);
    });

    it('refuses a check that does not fit in what is left, whole, and allows a smaller one', async () => {
      for (let search = 0; search < 50; search++) {
        await as(token).get(`/clients/search?q=${uniqueName()}`);
      }
      const checksBefore = await db.selectFrom('conflict_checks').select('id').where('requested_by', '=', feeEarner.id).execute();

      expect((await check(Array.from({ length: 11 }, () => uniqueName()))).status).toBe(429);
      expect(await db.selectFrom('conflict_checks').select('id').where('requested_by', '=', feeEarner.id).execute()).toEqual(checksBefore);
      expect((await check(Array.from({ length: 10 }, () => uniqueName()))).status).toBe(201);
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
      const common = uniqueName();
      for (let created = 0; created < 55; created++) {
        await as(token).post('/clients', { kind: 'individual', givenNames: common, familyName: 'Smith' });
      }

      const response = await check([`${common} Smith`]);

      expect(response.body.matchCount).toBeGreaterThanOrEqual(55);
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

  describe('POST /matters/:matterId/conflict-clearance (step 8c)', () => {
    const REASON = { reason: 'Different company: other registration number and address' };
    let matterId: string;
    let reference: string;
    let partnerToken: string;

    const clear = (sessionToken: string, body: object = REASON) => as(sessionToken).post(`/matters/${matterId}/conflict-clearance`, body);

    beforeEach(async () => {
      const existing = uniqueName();
      await as(token).post('/clients', { kind: 'organisation', legalName: `${existing} Holdings`, organisationType: 'company' });
      const opened = await open(token, { parties: [{ role: 'opponent', kind: 'organisation', name: `${existing} Holdings Ltd` }] });
      ({ id: matterId, reference } = opened.body);
      expect(opened.body.status).toBe('awaiting_clearance');
      partnerToken = await signedIn(partner);
    });

    it('opens the matter, and shows the team who cleared it and why', async () => {
      expect((await clear(partnerToken)).status).toBe(204);

      expect((await as(token).get(`/matters/${matterId}`)).body.status).toBe('open');
      expect((await as(token).get(`/matters/${matterId}/conflict-check`)).body.clearance).toEqual({
        clearedBy: { accountId: partner.id, displayName: expect.any(String) },
        reason: REASON.reason,
        clearedAt: expect.any(String),
      });
    });

    it('records the clearance without its reason, and tells compliance by matter reference only', async () => {
      const holder = await staffWith('compliance');

      await clear(partnerToken);

      const events = await db
        .selectFrom('audit_events')
        .select(['actor_id', 'action', 'metadata'])
        .where('resource_id', '=', matterId)
        .where('action', '=', 'matter.conflict_cleared')
        .execute();
      expect(events).toEqual([{ actor_id: partner.id, action: 'matter.conflict_cleared', metadata: { clearanceId: expect.any(String) } }]);
      expect(JSON.stringify(events)).not.toContain('registration number');
      await expect
        .poll(async () => (await inbox(holder.email)).filter((email) => email.subject.includes(reference)), { timeout: 15_000 })
        .toHaveLength(1);
      const [email] = (await inbox(holder.email)).filter((message) => message.subject.includes(reference));
      expect(email?.subject).toBe(`Possible conflict cleared on ${reference}`);
      expect(email?.text).not.toMatch(/registration number|Holdings/);
    });

    it('is refused to a partner on the team who is not its supervising partner', async () => {
      const otherPartner = await staffWith('partner');
      await db.insertInto('matter_team').values({ matter_id: matterId, account_id: otherPartner.id, role: 'fee_earner', added_by: feeEarner.id }).execute();

      const response = await clear(await signedIn(otherPartner));

      expect(response.status).toBe(403);
      expect(response.body.message).toBe("Only the matter's supervising partner can clear a possible conflict");
      expect((await as(token).get(`/matters/${matterId}`)).body.status).toBe('awaiting_clearance');
    });

    it('is closed to fee earners, even on the team', async () => {
      expect((await clear(token)).status).toBe(403);
    });

    it('does not find a matter the partner is not on', async () => {
      expect((await clear(await signedIn(await staffWith('partner')))).status).toBe(404);
    });

    it('refuses a matter that is not awaiting clearance', async () => {
      await clear(partnerToken);

      expect((await clear(partnerToken)).status).toBe(409);
    });

    it.each<[string, object]>([
      ['a short reason', { reason: 'fine' }],
      ['a reason with a line break', { reason: 'Different company\nother address' }],
      ['an extra field', { ...REASON, status: 'open' }],
    ])('refuses %s', async (_case, body) => {
      expect((await clear(partnerToken, body)).status).toBe(400);
    });

    /*
     * Holding the clearance lock from another connection makes both requests
     * queue on it every time; the second then finds the matter already open.
     */
    it('answers two clearances sent at once with 204 and 409', async () => {
      const holder = createDatabase<Database>(testAppDatabaseUrl(), 1);
      const lockKey = sql`hashtextextended(${`app.conflict_clearance:${matterId}`}, 0)`;
      try {
        await sql`select pg_advisory_lock(${lockKey})`.execute(holder);
        const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(holder);
        const responses = Promise.all([clear(partnerToken).then((r) => r), clear(partnerToken).then((r) => r)]);
        await expect
          .poll(async () => {
            const blocked = await sql<{ count: string }>`
              select count(*) from pg_stat_activity where ${rows[0]?.pid}::int = any(pg_blocking_pids(pid))`.execute(db);
            return Number(blocked.rows[0]?.count);
          })
          .toBe(2);
        await sql`select pg_advisory_unlock(${lockKey})`.execute(holder);

        expect((await responses).map((response) => response.status).sort()).toEqual([204, 409]);
      } finally {
        await holder.destroy();
      }
    });
  });

  describe('team changes (step 8d)', () => {
    let matterId: string;
    let partnerToken: string;

    const teamOf = async (id: string, sessionToken: string) =>
      ((await as(sessionToken).get(`/matters/${id}`)).body.team as { accountId: string; role: string }[]).map((m) => [m.accountId, m.role]);
    const teamEvents = () =>
      db
        .selectFrom('audit_events')
        .select(['actor_id', 'action', 'metadata'])
        .where('resource_id', '=', matterId)
        .where('action', 'in', ['matter.team_member_added', 'matter.team_member_removed', 'matter.supervisor_changed'])
        .orderBy('id')
        .execute();
    const put = (sessionToken: string, accountId: string) =>
      request(app.getHttpServer()).put(`/matters/${matterId}/team/${accountId}`).set('Cookie', `__Host-session=${sessionToken}`);
    const remove = (sessionToken: string, accountId: string) =>
      request(app.getHttpServer()).delete(`/matters/${matterId}/team/${accountId}`).set('Cookie', `__Host-session=${sessionToken}`);

    beforeEach(async () => {
      matterId = (await open(token)).body.id;
      partnerToken = await signedIn(partner);
    });

    it('adds a fee earner, who can then open the matter and its client', async () => {
      const colleague = await staffWith('fee_earner');
      const colleagueToken = await signedIn(colleague);
      expect((await as(colleagueToken).get(`/matters/${matterId}`)).status).toBe(404);

      expect((await put(partnerToken, colleague.id)).status).toBe(204);

      expect((await as(colleagueToken).get(`/matters/${matterId}`)).status).toBe(200);
      expect((await as(colleagueToken).get(`/clients/${client.id}`)).status).toBe(200);
      expect(await teamEvents()).toContainEqual({
        actor_id: partner.id,
        action: 'matter.team_member_added',
        metadata: { accountId: colleague.id, role: 'fee_earner' },
      });
    });

    it('treats adding someone already on the team as done, without a second record', async () => {
      const before = (await teamEvents()).length;

      expect((await put(partnerToken, feeEarner.id)).status).toBe(204);
      expect(await teamEvents()).toHaveLength(before);
    });

    it('removes a fee earner, who loses the matter and the client at once', async () => {
      const colleague = await staffWith('fee_earner');
      await put(partnerToken, colleague.id);
      const colleagueToken = await signedIn(colleague);

      expect((await remove(partnerToken, colleague.id)).status).toBe(204);

      expect((await as(colleagueToken).get(`/matters/${matterId}`)).status).toBe(404);
      expect((await as(colleagueToken).get(`/clients/${client.id}`)).status).toBe(404);
      expect(await teamEvents()).toContainEqual({
        actor_id: partner.id,
        action: 'matter.team_member_removed',
        metadata: { accountId: colleague.id, role: 'fee_earner' },
      });
    });

    it('does not let the supervising partner be removed, only handed over', async () => {
      const response = await remove(partnerToken, partner.id);

      expect(response.status).toBe(409);
      expect(await teamOf(matterId, partnerToken)).toContainEqual([partner.id, 'supervising_partner']);
    });

    it('hands supervision to another partner, keeping the previous one on the team as a fee earner', async () => {
      const successor = await staffWith('partner');
      const successorToken = await signedIn(successor);

      const response = await as(partnerToken).post(`/matters/${matterId}/supervisor`, { accountId: successor.id });

      expect(response.status).toBe(204);
      expect(await teamOf(matterId, successorToken)).toEqual(
        expect.arrayContaining([
          [successor.id, 'supervising_partner'],
          [partner.id, 'fee_earner'],
          [feeEarner.id, 'fee_earner'],
        ]),
      );
      expect((await put(partnerToken, (await staffWith('fee_earner')).id)).status).toBe(403);
      expect((await remove(successorToken, partner.id)).status).toBe(204);
      expect(await teamEvents()).toContainEqual({
        actor_id: partner.id,
        action: 'matter.supervisor_changed',
        metadata: { from: partner.id, to: successor.id },
      });
    });

    it('hands supervision to a partner already on the team as a fee earner', async () => {
      const colleague = await staffWith('partner');
      await put(partnerToken, colleague.id);

      expect((await as(partnerToken).post(`/matters/${matterId}/supervisor`, { accountId: colleague.id })).status).toBe(204);
      expect(await teamOf(matterId, partnerToken)).toContainEqual([colleague.id, 'supervising_partner']);
    });

    it.each<[string, () => Promise<{ status: number }>]>([
      ['adding someone from accounts', async () => put(partnerToken, (await staffWith('accounts')).id)],
      ['adding a client account', async () => put(partnerToken, (await createTestAccount(db, 'client')).id)],
      ['handing over to a fee earner', async () =>
        as(partnerToken).post(`/matters/${matterId}/supervisor`, { accountId: (await staffWith('fee_earner')).id })],
    ])('refuses %s', async (_case, attempt) => {
      expect((await attempt()).status).toBe(400);
    });

    it("refuses team changes by a partner on the team who is not its supervising partner", async () => {
      const otherPartner = await staffWith('partner');
      await put(partnerToken, otherPartner.id);

      const response = await put(await signedIn(otherPartner), (await staffWith('fee_earner')).id);

      expect(response.status).toBe(403);
      expect(response.body.message).toBe("Only the matter's supervising partner can change its team");
    });

    it('is closed to fee earners, and not found by partners off the team', async () => {
      expect((await put(token, (await staffWith('fee_earner')).id)).status).toBe(403);
      expect((await put(await signedIn(await staffWith('partner')), feeEarner.id)).status).toBe(404);
    });
  });

  describe('POST /matter-supervision-takeovers (step 8e)', () => {
    const REASON = 'Supervising partner has left the firm';
    let matterId: string;
    let reference: string;
    let taker: TestAccount;
    let takerToken: string;

    const takeOver = (sessionToken: string, body: object = { matterReference: reference, reason: REASON }) =>
      as(sessionToken).post('/matter-supervision-takeovers', body);

    beforeEach(async () => {
      ({ id: matterId, reference } = (await open(token)).body);
      taker = await staffWith('partner');
      takerToken = await signedIn(taker);
    });

    describe('when the supervising partner can no longer act', () => {
      beforeEach(async () => {
        await setAccountStatus(db, partner.id, 'disabled');
      });

      it('makes the taker supervising partner, who can then see and manage the matter', async () => {
        expect((await as(takerToken).get(`/matters/${matterId}`)).status).toBe(404);

        expect((await takeOver(takerToken, { matterReference: reference.toLowerCase(), reason: REASON })).status).toBe(204);

        const team = (await as(takerToken).get(`/matters/${matterId}`)).body.team.map((m: { accountId: string; role: string }) => [m.accountId, m.role]);
        expect(team).toContainEqual([taker.id, 'supervising_partner']);
        expect(team).not.toContainEqual([partner.id, 'supervising_partner']);
        expect((await as(takerToken).post(`/matters/${matterId}/supervisor`, { accountId: (await staffWith('partner')).id })).status).toBe(204);
      });

      it('records the takeover without its reason, and tells compliance by matter reference only', async () => {
        const holder = await staffWith('compliance');

        await takeOver(takerToken);

        const events = await db
          .selectFrom('audit_events')
          .select(['actor_id', 'action', 'metadata'])
          .where('resource_id', '=', matterId)
          .where('action', '=', 'matter.supervision_taken_over')
          .execute();
        expect(events).toEqual([
          { actor_id: taker.id, action: 'matter.supervision_taken_over', metadata: { takeoverId: expect.any(String), from: partner.id } },
        ]);
        expect(JSON.stringify(events)).not.toContain('left the firm');
        await expect
          .poll(async () => (await inbox(holder.email)).filter((email) => email.subject.includes(reference)), { timeout: 15_000 })
          .toHaveLength(1);
        const [email] = (await inbox(holder.email)).filter((message) => message.subject.includes(reference));
        expect(email?.text).not.toContain('left the firm');
      });

      it.each<[string, () => object]>([
        ['a reference in the wrong form', () => ({ matterReference: 'M-1', reason: REASON })],
        ['a short reason', () => ({ matterReference: reference, reason: 'gone' })],
        ['a matter id instead of a reference', () => ({ matterId, reason: REASON })],
      ])('refuses %s', async (_case, body) => {
        expect((await takeOver(takerToken, body())).status).toBe(400);
      });

      it('is closed to fee earners', async () => {
        expect((await takeOver(token)).status).toBe(403);
      });
    });

    it('refuses while the supervising partner can still act, and records the attempt', async () => {
      const response = await takeOver(takerToken);

      expect(response.status).toBe(409);
      expect((await as(takerToken).get(`/matters/${matterId}`)).status).toBe(404);
      expect(
        await db
          .selectFrom('audit_events')
          .select(['actor_id', 'action', 'metadata'])
          .where('resource_id', '=', matterId)
          .where('action', '=', 'matter.supervision_takeover_refused')
          .execute(),
      ).toEqual([{ actor_id: taker.id, action: 'matter.supervision_takeover_refused', metadata: { reason: 'supervisor_can_act' } }]);
    });

    it('does not find a reference that does not exist', async () => {
      expect((await takeOver(takerToken, { matterReference: 'C-999999/999', reason: REASON })).status).toBe(404);
    });
  });

  describe('editing and closing (step 8f)', () => {
    const REASON = { reason: 'Completion took place on 1 October' };
    let matterId: string;
    let partnerToken: string;

    const patch = (sessionToken: string, body: object) =>
      request(app.getHttpServer()).patch(`/matters/${matterId}`).set('Cookie', `__Host-session=${sessionToken}`).send(body);
    const close = (sessionToken: string, body: object = REASON) => as(sessionToken).post(`/matters/${matterId}/close`, body);
    const eventsOf = (action: string) =>
      db.selectFrom('audit_events').select(['actor_id', 'metadata']).where('resource_id', '=', matterId).where('action', '=', action).execute();

    beforeEach(async () => {
      matterId = (await open(token)).body.id;
      partnerToken = await signedIn(partner);
    });

    describe('PATCH /matters/:matterId', () => {
      it('lets anyone on the team change the title and type, recording which fields changed', async () => {
        const response = await patch(token, { title: 'Sale of 12 High Street', matterType: 'commercial_property' });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ title: 'Sale of 12 High Street', matterType: 'commercial_property' });
        expect(await eventsOf('matter.updated')).toEqual([{ actor_id: feeEarner.id, metadata: { fields: 'matterType,title' } }]);
      });

      it('records nothing when the values are the same as before', async () => {
        await patch(token, { title: 'Purchase of 12 High Street' });

        expect(await eventsOf('matter.updated')).toEqual([]);
      });

      it.each<[string, object]>([
        ['nothing to change', {}],
        ['a status', { status: 'closed' }],
        ['a client', { clientId: '00000000-0000-7000-8000-000000000000' }],
        ['a title with a line break', { title: 'Sale\nof a house' }],
      ])('refuses %s', async (_case, body) => {
        expect((await patch(token, body)).status).toBe(400);
      });

      it('does not find, or change, a matter the caller is not on, and is closed to accounts staff', async () => {
        expect((await patch(await signedIn(await staffWith('partner')), { title: 'Changed by an outsider' })).status).toBe(404);
        expect((await patch(await signedIn(await staffWith('accounts')), { title: 'Changed by accounts' })).status).toBe(403);

        expect((await as(token).get(`/matters/${matterId}`)).body.title).toBe('Purchase of 12 High Street');
        expect(await eventsOf('matter.updated')).toEqual([]);
      });
    });

    describe('POST /matters/:matterId/close', () => {
      it('closes the matter, recording the closure without its reason', async () => {
        expect((await close(partnerToken)).status).toBe(204);

        expect((await as(token).get(`/matters/${matterId}`)).body.status).toBe('closed');
        const events = await eventsOf('matter.closed');
        expect(events).toEqual([{ actor_id: partner.id, metadata: { closureId: expect.any(String) } }]);
        expect(JSON.stringify(events)).not.toContain('Completion');
      });

      it('leaves a closed matter unchangeable: no edits, no team changes, no second closure', async () => {
        await close(partnerToken);

        expect((await patch(token, { title: 'Changed again' })).status).toBe(409);
        expect(
          (await request(app.getHttpServer()).put(`/matters/${matterId}/team/${(await staffWith('fee_earner')).id}`).set('Cookie', `__Host-session=${partnerToken}`))
            .status,
        ).toBe(409);
        expect((await as(partnerToken).post(`/matters/${matterId}/supervisor`, { accountId: (await staffWith('partner')).id })).status).toBe(409);
        expect((await close(partnerToken)).status).toBe(409);
      });

      it('refuses closure while an open task remains', async () => {
        await db
          .insertInto('tasks')
          .values({
            matter_id: matterId,
            title: 'Send the final report',
            description: null,
            due_on: null,
            priority: 'normal',
            assigned_to: feeEarner.id,
            created_by: feeEarner.id,
          })
          .execute();

        const response = await close(partnerToken);

        expect(response.status).toBe(409);
        expect(response.body.message).toMatch(/open task/i);
        expect((await as(token).get(`/matters/${matterId}`)).body.status).toBe('open');
        expect(await eventsOf('matter.closed')).toEqual([]);
      });

      it('is refused to a partner on the team who is not its supervising partner, and closed to fee earners', async () => {
        const otherPartner = await staffWith('partner');
        await request(app.getHttpServer()).put(`/matters/${matterId}/team/${otherPartner.id}`).set('Cookie', `__Host-session=${partnerToken}`);

        expect((await close(await signedIn(otherPartner))).status).toBe(403);
        expect((await close(token)).status).toBe(403);
        expect((await as(token).get(`/matters/${matterId}`)).body.status).toBe('open');
      });

      it.each<[string, object]>([
        ['no reason', {}],
        ['a short reason', { reason: 'done' }],
      ])('refuses %s', async (_case, body) => {
        expect((await close(partnerToken, body)).status).toBe(400);
      });
    });
  });

  describe('compliance access with a reason (step 8g)', () => {
    const REASON = 'Quarterly file review of property matters';
    let matterId: string;
    let reference: string;
    let officer: TestAccount;
    let officerToken: string;

    const access = (sessionToken: string, body: object = { matterReference: reference, reason: REASON }) =>
      as(sessionToken).post('/matter-compliance-accesses', body);

    beforeEach(async () => {
      ({ id: matterId, reference } = (await open(token, { parties: [{ role: 'opponent', kind: 'individual', name: `Opponent ${uniqueName()}` }] })).body);
      officer = await staffWith('compliance');
      officerToken = await signedIn(officer);
    });

    it('shows compliance the matter, read-only, by reference', async () => {
      const response = await access(officerToken);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: matterId, reference, team: expect.any(Array), parties: [expect.objectContaining({ role: 'opponent' })] });
    });

    it('grants nothing lasting: compliance still cannot open the matter or its client directly', async () => {
      await access(officerToken);

      expect((await as(officerToken).get(`/matters/${matterId}`)).status).toBe(403);
      expect((await as(officerToken).get(`/clients/${client.id}`)).status).toBe(403);
    });

    it('records each access without its reason, and tells the supervising partner', async () => {
      await access(officerToken);
      await access(officerToken);

      const events = await db
        .selectFrom('audit_events')
        .select(['actor_id', 'metadata'])
        .where('resource_id', '=', matterId)
        .where('action', '=', 'matter.accessed_with_reason')
        .execute();
      expect(events).toEqual([
        { actor_id: officer.id, metadata: { accessId: expect.any(String) } },
        { actor_id: officer.id, metadata: { accessId: expect.any(String) } },
      ]);
      expect(JSON.stringify(events)).not.toContain('Quarterly');
      await expect
        .poll(async () => (await inbox(partner.email)).filter((email) => email.subject === `Compliance opened ${reference}`), { timeout: 15_000 })
        .toHaveLength(2);
    });

    it('lists the accesses, with their reasons, to the supervising partner only', async () => {
      await access(officerToken);

      const listed = await as(await signedIn(partner)).get(`/matters/${matterId}/compliance-accesses`);

      expect(listed.status).toBe(200);
      expect(listed.body.accesses).toEqual([
        { id: expect.any(String), accessedBy: { accountId: officer.id, displayName: expect.any(String) }, reason: REASON, accessedAt: expect.any(String) },
      ]);
      expect((await as(token).get(`/matters/${matterId}/compliance-accesses`)).status).toBe(403);
      const otherPartner = await staffWith('partner');
      await request(app.getHttpServer())
        .put(`/matters/${matterId}/team/${otherPartner.id}`)
        .set('Cookie', `__Host-session=${await signedIn(partner)}`);
      expect((await as(await signedIn(otherPartner)).get(`/matters/${matterId}/compliance-accesses`)).status).toBe(403);
    });

    it.each<[string, () => object]>([
      ['a short reason', () => ({ matterReference: reference, reason: 'audit' })],
      ['a matter id instead of a reference', () => ({ matterId, reason: REASON })],
    ])('refuses %s', async (_case, body) => {
      expect((await access(officerToken, body())).status).toBe(400);
    });

    it('does not find a reference that does not exist', async () => {
      expect((await access(officerToken, { matterReference: 'C-999999/999', reason: REASON })).status).toBe(404);
    });

    describe('hourly limit (review M4)', () => {
      it('refuses the 31st access in an hour, records it once, and alerts the other compliance holders and administrators', async () => {
        const colleague = await staffWith('compliance');
        const administrator = await staffWith('administrator');
        for (let accessNumber = 0; accessNumber < 30; accessNumber++) {
          expect((await access(officerToken)).status).toBe(200);
        }

        const refused = await access(officerToken);
        await access(officerToken);

        expect(refused.status).toBe(429);
        expect(refused.headers['retry-after']).toBe('3600');
        expect(
          await db
            .selectFrom('audit_events')
            .select(['action', 'metadata'])
            .where('actor_id', '=', officer.id)
            .where('action', '=', 'matter.compliance_access_limited')
            .execute(),
        ).toEqual([{ action: 'matter.compliance_access_limited', metadata: { limit: 30 } }]);
        for (const recipient of [colleague, administrator]) {
          await expect
            .poll(async () => (await inbox(recipient.email)).filter((email) => email.subject === 'Compliance access limit reached'), { timeout: 15_000 })
            .toHaveLength(1);
        }
        await app.get(MailOutbox).drain();
        expect((await inbox(officer.email)).filter((email) => email.subject === 'Compliance access limit reached')).toEqual([]);
      });

      it('limits each person separately', async () => {
        for (let accessNumber = 0; accessNumber < 30; accessNumber++) {
          await access(officerToken);
        }

        expect((await access(await signedIn(await staffWith('compliance')))).status).toBe(200);
      });

      // Without the per-person lock, accesses in flight together would all pass the count first.
      it('lets exactly 30 of 35 accesses sent at once through', async () => {
        const statuses = (await Promise.all(Array.from({ length: 35 }, () => access(officerToken)))).map((r) => r.status);

        expect(statuses.filter((status) => status === 200)).toHaveLength(30);
        expect(statuses.filter((status) => status === 429)).toHaveLength(5);
      });
    });

    it.each(['partner', 'fee_earner', 'administrator'] as const)('is closed to %s', async (role) => {
      expect((await access(await signedIn(await staffWith(role)))).status).toBe(403);
    });

    // The read goes through the access record: an access to one matter cannot read another.
    it('reads a matter only through an access to that same matter', async () => {
      const otherMatterId = (await open(token)).body.id;
      await access(officerToken);
      const { id: accessId } = await db
        .selectFrom('matter_compliance_accesses')
        .select('id')
        .where('matter_id', '=', matterId)
        .executeTakeFirstOrThrow();
      const repository = app.get(MattersRepository);

      expect(await repository.findByComplianceAccess(otherMatterId, accessId)).toBeUndefined();
      expect(await repository.findByComplianceAccess(matterId, accessId)).toMatchObject({ id: matterId });
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
