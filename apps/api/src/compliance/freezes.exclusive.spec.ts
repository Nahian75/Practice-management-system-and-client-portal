import { randomBytes, randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestAccount } from '../../test/accounts.js';
import { clearMatterForTests, createAmlStaff, createTeamMatter, ensureAmlFramework, londonDates } from '../../test/aml.js';
import { createTestApp } from '../../test/create-test-app.js';
import { testOwnerDatabaseUrl } from '../../test/database.js';
import { sanctionsCsv } from '../../test/sanctions.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { createDatabase } from '../database/database.js';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import { ComplianceModule } from './compliance.module.js';

@Module({ imports: [ComplianceModule] })
class FreezesTestModule {}

describe('frozen funds and sanctions licences', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let owner: Kysely<Database>;
  let sessions: SessionsService;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let accounts: TestAccount;
  let complianceToken: string;
  let accountsToken: string;
  let feeToken: string;
  let today: string;
  let inAMonth: string;

  const cookie = (token: string) => `__Host-session=${token}`;
  const api = (token: string) => {
    const server = request(app.getHttpServer());
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie(token)),
      post: (path: string, body: object) => server.post(path).set('Cookie', cookie(token)).send(body),
    };
  };

  /** A cleared, funded matter with payment evidence, for a client who will later match a designation. */
  async function fundedMatter() {
    const { matterId, clientId } = await createTeamMatter(db, feeEarner, partner);
    const family = `Farnsworth${randomUUID().slice(0, 6).replace(/[0-9]/g, 'q')}`;
    await db.updateTable('client_individuals').set({ given_names: 'Zebedee', family_name: family }).where('client_id', '=', clientId).execute();
    await clearMatterForTests(db, matterId);
    const bankId = (await sql<{ id: string }>`select app.create_bank_account('client', ${`Client ${randomUUID().slice(0, 8)}`}, '5678',
      ${randomUUID()}::uuid, ${randomBytes(32)}, 1::smallint, ${randomBytes(12)}, ${randomBytes(20)}, ${randomBytes(16)},
      ${today}::date, ${accounts.id}) as id`.execute(db)).rows[0]!.id;
    await receipt(bankId, matterId, '20000');
    const evidenceId = await db.transaction().execute(async (trx) => {
      const document = await trx.insertInto('documents').values({ matter_id: matterId, title: 'Authority', category: 'evidence', created_by: feeEarner.id })
        .returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('document_versions').values({ document_id: document.id, file_name: 'authority.pdf', media_type: 'application/pdf',
        size_bytes: 10, sha256: randomBytes(32), storage_key: randomUUID(), key_version: 1, key_nonce: randomBytes(12),
        wrapped_key: randomBytes(32), key_tag: randomBytes(16), uploaded_by: feeEarner.id }).execute();
      return document.id;
    });
    return { matterId, clientId, bankId, evidenceId, family };
  }
  const receipt = (bankId: string, matterId: string, amount: string) => sql`select app.record_finance_receipt(
    ${bankId}, ${matterId}, ${today}::date, ${amount}::bigint, ${randomUUID().slice(0, 12)}, 'Funds on account', ${accounts.id})`.execute(db);
  const requestPayment = (fixture: { bankId: string; matterId: string; evidenceId: string }, amount: string) => sql`
    select app.create_client_payment_request('refund', ${fixture.bankId}, null, ${fixture.matterId}, null, ${fixture.evidenceId},
      'Refund surplus funds', ${amount}::bigint, ${randomUUID()}::uuid, 1::smallint, ${randomBytes(12)}, ${randomBytes(64)},
      ${randomBytes(16)}, ${accounts.id})`.execute(db);
  const allowed = (matterId: string, action: string) => owner.transaction().execute((trx) =>
    sql`select app.assert_aml_gate(${matterId}, ${action})`.execute(trx)).then(() => true, () => false);

  /** Activates a list naming this client, screens it and confirms the match. */
  async function confirmDesignation(clientId: string, family: string) {
    const csv = sanctionsCsv('31-Dec-2099', [{ uniqueId: `TST-${randomUUID().slice(0, 6)}`, names: ['Zebedee', family.toUpperCase()] }]);
    expect((await request(app.getHttpServer()).post('/compliance/sanctions/lists').set('Cookie', cookie(complianceToken))
      .attach('file', Buffer.from(csv), 'list.csv')).status).toBe(201);
    expect((await api(complianceToken).post(`/compliance/sanctions/clients/${clientId}/screenings`, {})).body.state).toBe('possible_match');
    const candidate = (await api(complianceToken).get('/compliance/sanctions/candidates')).body.candidates
      .find((item: { clientId: string }) => item.clientId === clientId);
    return api(complianceToken).post(`/compliance/sanctions/candidates/${candidate.candidateId}/resolution`,
      { outcome: 'confirmed', reasoning: 'Name, date of birth and nationality match the designation.' });
  }
  const licence = (clientId: string, overrides: Record<string, unknown> = {}) => api(complianceToken).post('/compliance/sanctions/licences', {
    clientId, authority: 'ofsi', kind: 'specific', reference: `INT/2099/${randomUUID().slice(0, 6)}`, permittedActions: ['money'],
    moneyLimitPence: '10000', effectiveFrom: today, expiresOn: inAMonth,
    conditions: 'Payment of reasonable legal fees only; report each payment within 14 days.', ...overrides });

  beforeAll(async () => {
    app = await createTestApp(FreezesTestModule);
    db = app.get(DATABASE);
    owner = createDatabase<Database>(testOwnerDatabaseUrl(), 2);
    sessions = app.get(SessionsService);
    await ensureAmlFramework(db);
    ({ today } = await londonDates(db));
    inAMonth = (await sql<{ day: string }>`select (${today}::date + 30)::text as day`.execute(db)).rows[0]!.day;
  });
  afterAll(async () => {
    await owner.destroy();
    await app.close();
  });
  beforeEach(async () => {
    partner = await createAmlStaff(db, 'partner');
    feeEarner = await createAmlStaff(db, 'fee_earner');
    accounts = await createAmlStaff(db, 'accounts');
    const compliance = await createAmlStaff(db, 'compliance');
    [complianceToken, accountsToken, feeToken] = await Promise.all([
      sessions.start(compliance, 'authenticated', {}), sessions.start(accounts, 'authenticated', {}),
      sessions.start(feeEarner, 'authenticated', {}),
    ]);
  });

  it('freezes the balance on confirmation and tells Accounts only that funds are frozen', async () => {
    const fixture = await fundedMatter();
    const status = () => api(accountsToken).get(`/matters/${fixture.matterId}/money-status`);
    expect((await status()).body).toEqual({ status: 'allowed', licence: null });
    expect((await api(feeToken).get(`/matters/${fixture.matterId}/money-status`)).status).toBe(403);

    expect((await confirmDesignation(fixture.clientId, fixture.family)).body).toEqual({ state: 'confirmed' });
    expect((await status()).body).toEqual({ status: 'frozen', licence: null });
    await expect(requestPayment(fixture, '1000')).rejects.toMatchObject({ code: '23514' });

    const frozen = (await api(complianceToken).get(`/compliance/sanctions/frozen-funds?clientId=${fixture.clientId}`)).body.frozenFunds;
    expect(frozen).toEqual([expect.objectContaining({ matterId: fixture.matterId, amountPence: '20000', reason: 'balance_at_confirmation' })]);
  });

  it('still records a bank-confirmed receipt for a confirmed client, and freezes it', async () => {
    const fixture = await fundedMatter();
    await confirmDesignation(fixture.clientId, fixture.family);
    await expect(receipt(fixture.bankId, fixture.matterId, '5000')).resolves.toBeDefined();
    const frozen = (await api(complianceToken).get(`/compliance/sanctions/frozen-funds?clientId=${fixture.clientId}`)).body.frozenFunds;
    expect(frozen.map((item: { reason: string; amountPence: string }) => `${item.reason}:${item.amountPence}`).sort())
      .toEqual(['balance_at_confirmation:20000', 'receipt:5000']);
  });

  it('allows money under a licence only up to its limit, and not after revocation', async () => {
    const fixture = await fundedMatter();
    await confirmDesignation(fixture.clientId, fixture.family);
    const recorded = await licence(fixture.clientId);
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect((await api(accountsToken).get(`/matters/${fixture.matterId}/money-status`)).body)
      .toEqual({ status: 'allowed', licence: { id: recorded.body.id, limitPence: '10000', usedPence: '0', expiresOn: inAMonth } });

    await expect(requestPayment(fixture, '6000')).resolves.toBeDefined();
    await expect(requestPayment(fixture, '5000')).rejects.toMatchObject({ code: '23514' });
    await expect(requestPayment(fixture, '4000')).resolves.toBeDefined();
    await expect(requestPayment(fixture, '1')).rejects.toMatchObject({ code: '23514' });

    expect((await api(complianceToken).post(`/compliance/sanctions/licences/${recorded.body.id}/revocation`,
      { reason: 'OFSI varied the licence to exclude further payments.' })).status).toBe(201);
    expect((await api(accountsToken).get(`/matters/${fixture.matterId}/money-status`)).body.status).toBe('frozen');
  });

  it('lifts only the actions a licence names, and never a hold or a possible match', async () => {
    const fixture = await fundedMatter();
    await confirmDesignation(fixture.clientId, fixture.family);
    expect(await allowed(fixture.matterId, 'time')).toBe(false);
    await licence(fixture.clientId, { permittedActions: ['time'], moneyLimitPence: null });
    expect(await allowed(fixture.matterId, 'time')).toBe(true);
    expect(await allowed(fixture.matterId, 'documents')).toBe(false);
    expect(await allowed(fixture.matterId, 'money')).toBe(false);
    expect((await api(complianceToken).get(`/matters/${fixture.matterId}/aml-gate`)).body.state).toBe('held');

    await api(complianceToken).post('/compliance/holds', { matterId: fixture.matterId, reason: 'Separate concern under internal review now.' });
    expect(await allowed(fixture.matterId, 'time')).toBe(false);
  });

  it('records a licence only for a confirmed designation, with a limit exactly when money is licensed', async () => {
    const fixture = await fundedMatter();
    expect((await licence(fixture.clientId)).status).toBe(409);
    expect((await licence(fixture.clientId, { moneyLimitPence: null })).status).toBe(400);
    expect((await licence(fixture.clientId, { permittedActions: ['time'] })).status).toBe(400);
    expect((await licence(randomUUID())).status).toBe(404);
    expect((await api(accountsToken).post('/compliance/sanctions/licences', {})).status).toBe(403);
    await expect(sql`insert into app.aml_frozen_funds(client_id, matter_id, amount_pence, reason)
      values (${fixture.clientId}, ${fixture.matterId}, 1, 'balance_at_confirmation')`.execute(owner)).rejects.toMatchObject({ code: '42501' });
  });
});
