import { randomInt, randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { FinanceModule } from './finance.module.js';

@Module({ imports: [FinanceModule] })
class LedgerTestModule {}

describe('Finance ledger API', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let accounts: TestAccount;
  let compliance: TestAccount;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let accountsToken: string;
  let matterId: string;
  let otherMatterId: string;
  let today: string;

  const uniqueName = () => randomUUID().replaceAll('-', '').slice(0, 16);
  const uniqueAccountNumber = () => randomInt(10_000_000, 100_000_000).toString();
  const cookie = (token: string) => `__Host-session=${token}`;
  const signedIn = (account: TestAccount) => sessions.start(account, 'authenticated', {});
  const as = (token: string) => {
    const server = request(app.getHttpServer());
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie(token)),
      post: (path: string, body: object) => server.post(path).set('Cookie', cookie(token)).send(body),
    };
  };

  async function staffWith(...roles: StaffRole[]): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) await grantTestRole(db, account.id, role);
    return account;
  }

  async function openMatter(existingClient?: string): Promise<{ clientId: string; matterId: string }> {
    const clientId = existingClient ?? (await db.transaction().execute(async (trx) => {
      const client = await trx.insertInto('clients').values({ kind: 'individual', created_by: feeEarner.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({
        client_id: client.id, given_names: 'Morgan', family_name: uniqueName(),
        address_line1: '14 Money Street', town: 'York', postcode: 'YO1 1AA', country: 'GB',
      }).execute();
      return client.id;
    }));
    const check = await db.insertInto('conflict_checks').values({ client_id: clientId, requested_by: feeEarner.id, names: [uniqueName()] }).returning('id').executeTakeFirstOrThrow();
    const matter = await db.transaction().execute(async (trx) => {
      const row = await trx.insertInto('matters').values({
        client_id: clientId, title: 'Ledger API matter', matter_type: 'other',
        opened_by: feeEarner.id, conflict_check_id: check.id,
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('matter_team').values([
        { matter_id: row.id, account_id: feeEarner.id, role: 'fee_earner', added_by: feeEarner.id },
        { matter_id: row.id, account_id: partner.id, role: 'supervising_partner', added_by: feeEarner.id },
      ]).execute();
      return row;
    });
    return { clientId, matterId: matter.id };
  }

  const bankBody = (overrides: object = {}) => ({
    kind: 'client', name: `Client account ${uniqueName()}`, sortCode: '12-34-56',
    accountNumber: uniqueAccountNumber(), openedOn: today, ...overrides,
  });

  async function createBank(overrides: object = {}) {
    return as(accountsToken).post('/finance/bank-accounts', bankBody(overrides));
  }

  beforeAll(async () => {
    app = await createTestApp(LedgerTestModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
  });

  afterAll(async () => app.close());

  beforeEach(async () => {
    today = (await sql<{ today: string }>`select (clock_timestamp() at time zone 'Europe/London')::date::text as today`.execute(db)).rows[0]!.today;
    accounts = await staffWith('accounts');
    compliance = await staffWith('compliance');
    partner = await staffWith('partner');
    feeEarner = await staffWith('fee_earner');
    accountsToken = await signedIn(accounts);
    const matter = await openMatter();
    matterId = matter.matterId;
    otherMatterId = (await openMatter(matter.clientId)).matterId;
  });

  it('creates and lists only safe bank fields while ciphertext and audit stay private', async () => {
    const name = `Private bank ${uniqueName()}`;
    const accountNumber = uniqueAccountNumber();
    const created = await createBank({ name, accountNumber });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ kind: 'client', name, lastFour: accountNumber.slice(-4), openedOn: today, closedOn: null });
    expect(JSON.stringify(created.body)).not.toContain(accountNumber);
    expect(JSON.stringify(created.body)).not.toContain('12-34-56');
    expect(JSON.stringify(created.body)).not.toContain('ciphertext');

    const stored = await db.selectFrom('bank_accounts').selectAll().where('id', '=', created.body.id).executeTakeFirstOrThrow();
    expect(stored.ciphertext.toString('utf8')).not.toContain(accountNumber);
    expect(stored.fingerprint).toHaveLength(32);
    const event = await db.selectFrom('audit_events').selectAll().where('action', '=', 'finance.bank_account_created').where('resource_id', '=', created.body.id).executeTakeFirstOrThrow();
    expect(JSON.stringify(event.metadata)).not.toContain(name);
    expect(JSON.stringify(event.metadata)).not.toContain(accountNumber.slice(-4));

    const listed = await as(await signedIn(compliance)).get('/finance/bank-accounts');
    expect(listed.status).toBe(200);
    expect(listed.body.bankAccounts).toContainEqual(created.body);
    expect((await as(await signedIn(partner)).get('/finance/bank-accounts')).status).toBe(403);
  });

  it('refuses non-Accounts writers, unknown input, malformed details and duplicate accounts', async () => {
    expect((await as(await signedIn(partner)).post('/finance/bank-accounts', bankBody())).status).toBe(403);
    expect((await createBank({ unexpected: true })).status).toBe(400);
    expect((await createBank({ sortCode: '123456' })).status).toBe(400);
    expect((await createBank({ accountNumber: '1234' })).status).toBe(400);
    const details = { sortCode: '65-43-21', accountNumber: uniqueAccountNumber() };
    expect((await createBank(details)).status).toBe(201);
    expect((await createBank({ ...details, name: `Duplicate ${uniqueName()}` })).status).toBe(409);
    expect((await as(await signedIn(compliance)).post('/finance/receipts', {})).status).toBe(403);
  });

  it('closes a bank account permanently without returning or auditing its details', async () => {
    const bank = await createBank();
    const closed = await as(accountsToken).post(`/finance/bank-accounts/${bank.body.id}/close`, {
      closedOn: today, reason: 'The firm moved to a different account',
    });
    expect(closed.status).toBe(201);
    expect(closed.body.closedOn).toBe(today);
    expect((await as(accountsToken).post(`/finance/bank-accounts/${bank.body.id}/close`, {
      closedOn: today, reason: 'Again',
    })).status).toBe(409);
    const event = await db.selectFrom('audit_events').select('metadata').where('action', '=', 'finance.bank_account_closed').where('resource_id', '=', bank.body.id).executeTakeFirstOrThrow();
    expect(JSON.stringify(event.metadata)).not.toContain('different account');
  });

  it('records exact receipts and allocation corrections in derived ledgers and cash books', async () => {
    const bank = await createBank();
    const receipt = await as(accountsToken).post('/finance/receipts', {
      bankAccountId: bank.body.id, matterId, receivedOn: today, amount: '100.03',
      reference: `BANK-${uniqueName()}`, purpose: 'Funds on account',
    });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    expect(receipt.body).toMatchObject({ kind: 'client_receipt', side: 'client', matterId, amount: '100.03' });

    const allocated = await as(accountsToken).post('/finance/allocations', {
      side: 'client', sourceMatterId: matterId, targetMatterId: otherMatterId,
      amount: '40.01', reason: 'Part of the receipt belonged to the other matter',
    });
    expect(allocated.status).toBe(201);
    expect(allocated.body).toMatchObject({ kind: 'client_allocation', amount: '40.01' });

    const source = await as(await signedIn(compliance)).get(`/finance/matters/${matterId}/ledger`);
    expect(source.status).toBe(200);
    expect(source.body).toMatchObject({ clientBalance: '60.02', businessBalance: '0.00' });
    expect(source.body.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'client_receipt', amount: '100.03' }),
      expect.objectContaining({ kind: 'client_allocation', direction: 'debit', amount: '40.01' }),
    ]));
    const target = await as(accountsToken).get(`/finance/matters/${otherMatterId}/ledger`);
    expect(target.body.clientBalance).toBe('40.01');
    expect(target.body.entries).toContainEqual(expect.objectContaining({
      kind: 'client_allocation', matterId: otherMatterId, relatedMatterId: matterId,
    }));
    const cash = await as(accountsToken).get(`/finance/bank-accounts/${bank.body.id}/cash-book`);
    expect(cash.body).toMatchObject({ balance: '100.03', bankAccount: { id: bank.body.id, lastFour: bank.body.lastFour } });
    expect(cash.body.entries).toHaveLength(1);
    const partnerSession = await signedIn(partner);
    expect((await as(partnerSession).get(`/finance/matters/${matterId}/ledger`)).status).toBe(403);
    expect((await as(partnerSession).get(`/finance/matters/${matterId}/ledger/export`)).status).toBe(403);

    const ledgerExport = await as(await signedIn(compliance)).get(`/finance/matters/${matterId}/ledger/export`);
    expect(ledgerExport.status).toBe(200);
    expect(ledgerExport.headers).toMatchObject({
      'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
    });
    expect(ledgerExport.headers['content-disposition']).toMatch(/^attachment; filename="matter-ledger-[a-f0-9-]+\.csv"$/);
    expect(ledgerExport.text).toContain('"Amount GBP"');
    expect(ledgerExport.text).toContain('"100.03"');
    const cashExport = await as(accountsToken).get(`/finance/bank-accounts/${bank.body.id}/cash-book/export`);
    expect(cashExport.status).toBe(200);
    expect(cashExport.text).toContain('"Matter id"');
    expect(await db.selectFrom('audit_events').select('id').where('action', '=', 'finance.matter_ledger_exported').where('resource_id', '=', matterId).executeTakeFirst()).toBeDefined();
    expect(await db.selectFrom('audit_events').select('id').where('action', '=', 'finance.cash_book_exported').where('resource_id', '=', bank.body.id).executeTakeFirst()).toBeDefined();
  });

  it('returns live UI capabilities without granting finance access to other staff', async () => {
    expect((await as(accountsToken).get('/finance/access')).body).toEqual({
      canManageBilling: true, canRecordClientMoney: true, canRequestPayment: true,
      canApprovePayment: true, canReconcile: true, canSignOffReconciliation: false,
    });
    expect((await as(await signedIn(compliance)).get('/finance/access')).body).toEqual({
      canManageBilling: false, canRecordClientMoney: false, canRequestPayment: false,
      canApprovePayment: false, canReconcile: false, canSignOffReconciliation: true,
    });
    expect((await as(await signedIn(partner)).get('/finance/access')).status).toBe(403);
  });

  it('returns conflicts for invalid receipt/allocation state and keeps private text out of audit', async () => {
    const bank = await createBank();
    const reference = `BANK-${uniqueName()}`;
    const purpose = `Private purpose ${uniqueName()}`;
    expect((await as(accountsToken).post('/finance/receipts', {
      bankAccountId: bank.body.id, matterId, receivedOn: today, amount: '10.00', reference, purpose,
    })).status).toBe(201);
    expect((await as(accountsToken).post('/finance/receipts', {
      bankAccountId: bank.body.id, matterId, receivedOn: today, amount: '10.00', reference, purpose,
    })).status).toBe(409);
    expect((await as(accountsToken).post('/finance/allocations', {
      side: 'client', sourceMatterId: matterId, targetMatterId: otherMatterId,
      amount: '10.01', reason: 'Too much',
    })).status).toBe(409);
    expect((await as(accountsToken).post('/finance/receipts', {
      bankAccountId: bank.body.id, matterId, receivedOn: today, amount: '0.00', reference: uniqueName(), purpose,
    })).status).toBe(400);
    const events = await db.selectFrom('audit_events').select('metadata').where('action', '=', 'finance.client_money_received').where('actor_id', '=', accounts.id).execute();
    expect(JSON.stringify(events)).not.toContain(reference);
    expect(JSON.stringify(events)).not.toContain(purpose);
  });

  it('shows signed business balances for bills, credits and business receipts', async () => {
    const businessBank = await createBank({ kind: 'business', sortCode: '22-33-44' });
    expect((await as(accountsToken).post('/finance/receipts', {
      bankAccountId: businessBank.body.id, matterId, receivedOn: today, amount: '0.50',
      reference: uniqueName(), purpose: 'Small business receipt',
    })).status).toBe(201);
    const ledger = await as(accountsToken).get(`/finance/matters/${matterId}/ledger`);
    expect(ledger.body.businessBalance).toBe('-0.50');
  });

  it('paginates ledger and cash-book entries 100 at a time', async () => {
    const bank = await createBank();
    for (let index = 0; index < 101; index += 1) {
      await sql`select app.record_finance_receipt(
        ${bank.body.id}, ${matterId}, ${today}::date, 1::bigint,
        ${`PAGE-${uniqueName()}-${index}`}, 'Paging receipt', ${accounts.id}
      )`.execute(db);
    }
    const firstLedger = await as(accountsToken).get(`/finance/matters/${matterId}/ledger`);
    expect(firstLedger.body.entries).toHaveLength(100);
    expect(firstLedger.body.next).toEqual(expect.any(String));
    const secondLedger = await as(accountsToken).get(`/finance/matters/${matterId}/ledger?before=${firstLedger.body.next}`);
    expect(secondLedger.body.entries).toHaveLength(1);
    const firstCash = await as(accountsToken).get(`/finance/bank-accounts/${bank.body.id}/cash-book`);
    expect(firstCash.body.entries).toHaveLength(100);
    expect((await as(accountsToken).get(`/finance/bank-accounts/${bank.body.id}/cash-book?before=${firstCash.body.next}`)).body.entries).toHaveLength(1);
    const exported = await as(accountsToken).get(`/finance/bank-accounts/${bank.body.id}/cash-book/export`);
    expect(exported.status).toBe(200);
    expect(exported.text.match(/PAGE-/g)).toHaveLength(101);
  });

  it('rolls back a receipt when its audit record fails', async () => {
    const bank = await createBank();
    const audit = app.get(AuditService);
    const record = audit.record.bind(audit);
    const failure = vi.spyOn(audit, 'record').mockImplementation((event, transaction) =>
      event.action === 'finance.client_money_received' ? Promise.reject(new Error('audit unavailable')) : record(event, transaction),
    );
    const reference = `ROLLBACK-${uniqueName()}`;
    let response: request.Response;
    try {
      response = await as(accountsToken).post('/finance/receipts', {
        bankAccountId: bank.body.id, matterId, receivedOn: today, amount: '10.00',
        reference, purpose: 'Must roll back',
      });
    } finally {
      failure.mockRestore();
    }
    expect(response!.status).toBe(500);
    expect(await db.selectFrom('finance_transactions').select('id').where('reference', '=', reference).executeTakeFirst()).toBeUndefined();
  });
});
