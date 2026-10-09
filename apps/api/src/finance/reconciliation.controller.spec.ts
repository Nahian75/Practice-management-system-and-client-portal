import { randomInt, randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { AuditService } from '../audit/audit.service.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { FinanceModule } from './finance.module.js';

@Module({ imports: [FinanceModule] })
class ReconciliationTestModule {}

describe('bank statement and reconciliation API', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let accounts: TestAccount;
  let compliance: TestAccount;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let accountsToken: string;
  let complianceToken: string;
  let partnerToken: string;
  let bankAccountId: string;
  let matterId: string;
  let statementDate: string;
  let reference: string;
  let testDay = 10;
  const unique = () => randomUUID().replaceAll('-', '').slice(0, 16);
  const cookie = (token: string) => `__Host-session=${token}`;

  async function staffWith(...roles: StaffRole[]) {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) await grantTestRole(db, account.id, role);
    return account;
  }

  async function setupMatter() {
    return db.transaction().execute(async (trx) => {
      const client = await trx.insertInto('clients').values({ kind: 'individual', created_by: feeEarner.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({
        client_id: client.id, given_names: 'Statement', family_name: unique(), address_line1: '1 Reconcile Road',
        town: 'Bristol', postcode: 'BS1 1AA', country: 'GB',
      }).execute();
      const check = await trx.insertInto('conflict_checks').values({ client_id: client.id, requested_by: feeEarner.id, names: [unique()] }).returning('id').executeTakeFirstOrThrow();
      const matter = await trx.insertInto('matters').values({ client_id: client.id, title: 'Statement API', matter_type: 'other', opened_by: feeEarner.id, conflict_check_id: check.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('matter_team').values([
        { matter_id: matter.id, account_id: feeEarner.id, role: 'fee_earner', added_by: feeEarner.id },
        { matter_id: matter.id, account_id: partner.id, role: 'supervising_partner', added_by: feeEarner.id },
      ]).execute();
      return matter.id;
    });
  }

  function api(token: string) {
    const server = request(app.getHttpServer());
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie(token)),
      post: (path: string, body: object) => server.post(path).set('Cookie', cookie(token)).send(body),
      import: (csv: string, overrides: Partial<Record<'openingBalance' | 'closingBalance' | 'fileName', string>> = {}) =>
        server.post('/finance/statement-imports').set('Cookie', cookie(token))
          .field('bankAccountId', bankAccountId).field('periodStart', statementDate)
          .field('periodEnd', statementDate).field('openingBalance', overrides.openingBalance ?? '0.00')
          .field('closingBalance', overrides.closingBalance ?? '100.00')
          .attach('file', Buffer.from(csv), { filename: overrides.fileName ?? 'statement.csv', contentType: 'text/csv' }),
    };
  }

  const csv = () => `date,amount,reference,description\r\n${statementDate},100.00,${reference},Client receipt\r\n`;

  beforeAll(async () => {
    app = await createTestApp(ReconciliationTestModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
  });
  afterAll(async () => app.close());
  afterEach(async () => {
    if (bankAccountId) {
      await sql`select app.close_bank_account(
        ${bankAccountId}, ${statementDate}::date, 'Test fixture complete', ${accounts.id}
      )`.execute(db);
    }
  });

  beforeEach(async () => {
    testDay += 1;
    statementDate = (await sql<{ date: string }>`select ((clock_timestamp() at time zone 'Europe/London')::date - ${testDay}::integer)::text as date`.execute(db)).rows[0]!.date;
    accounts = await staffWith('accounts');
    compliance = await staffWith('compliance');
    partner = await staffWith('partner');
    feeEarner = await staffWith('fee_earner');
    accountsToken = await sessions.start(accounts, 'authenticated', {});
    complianceToken = await sessions.start(compliance, 'authenticated', {});
    partnerToken = await sessions.start(partner, 'authenticated', {});
    matterId = await setupMatter();
    const bank = await api(accountsToken).post('/finance/bank-accounts', {
      kind: 'client', name: `Client ${unique()}`, sortCode: '12-34-56',
      accountNumber: randomInt(10_000_000, 100_000_000).toString(), openedOn: statementDate,
    });
    expect(bank.status).toBe(201);
    bankAccountId = bank.body.id;
    reference = unique();
  });

  it('runs import, exact matching, fixed preparation and separate Compliance sign-off', async () => {
    const receipt = await api(accountsToken).post('/finance/receipts', {
      bankAccountId, matterId, receivedOn: statementDate, amount: '100.00', reference, purpose: 'Funds on account',
    });
    expect(receipt.status).toBe(201);
    const imported = await api(accountsToken).import(csv());
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    expect(imported.body).toMatchObject({ openingBalance: '0.00', closingBalance: '100.00', rowCount: 1 });
    expect(imported.body).not.toHaveProperty('fileHash');
    const matched = await api(accountsToken).post(`/finance/statement-rows/${imported.body.rows[0].id}/matches`, {
      financeTransactionId: receipt.body.id,
    });
    expect(matched.status).toBe(201);
    const prepared = await api(accountsToken).post('/finance/reconciliations', {
      asOf: statementDate, statementImportIds: [imported.body.id], explanations: {},
    });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(201);
    expect(prepared.body).toMatchObject({
      bankBalance: '100.00', cashbookBalance: '100.00', clientLedgerBalance: '100.00',
      bankCashbookDifference: '0.00', cashbookClientDifference: '0.00', items: [], signOff: null,
    });
    expect((await api(accountsToken).get(`/finance/reconciliations/${prepared.body.id}/export`)).status).toBe(200);
    expect((await api(accountsToken).post(`/finance/reconciliations/${prepared.body.id}/sign-off`, {})).status).toBe(403);
    const signed = await api(complianceToken).post(`/finance/reconciliations/${prepared.body.id}/sign-off`, {});
    expect(signed.status).toBe(201);
    expect(signed.body.signOff.signedOffBy).toBe(compliance.id);
    const exported = await api(complianceToken).get(`/finance/reconciliations/${prepared.body.id}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(exported.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(exported.text).toContain('"Client account reconciliation"');
    expect(exported.text).toContain('"100.00"');
    const actions = await db.selectFrom('audit_events').select('action').where('resource_id', 'in', [imported.body.id, matched.body.id, prepared.body.id]).execute();
    expect(actions.map((item) => item.action)).toEqual(expect.arrayContaining([
      'finance.bank_statement_imported', 'finance.bank_transaction_matched',
      'finance.reconciliation_prepared', 'finance.reconciliation_signed_off', 'finance.reconciliation_exported',
    ]));
  });

  it('keeps mutation routes with Accounts and sign-off with Compliance, and validates uploads strictly', async () => {
    expect((await api(partnerToken).import(csv())).status).toBe(403);
    expect((await api(complianceToken).import(csv())).status).toBe(403);
    const invalidHeader = await api(accountsToken).import(`Date,amount,reference,description\n${statementDate},100.00,${reference},Receipt`);
    expect(invalidHeader.status).toBe(400);
    const formula = await api(accountsToken).import(`date,amount,reference,description\n${statementDate},100.00,=CMD,Receipt`);
    expect(formula.status).toBe(400);
    expect((await api(partnerToken).get('/finance/statement-imports')).status).toBe(403);
    expect((await api(complianceToken).get('/finance/statement-imports')).status).toBe(200);
  });

  it('refuses duplicates and mismatches, records reversal history, and reports five-week status', async () => {
    const receipt = await api(accountsToken).post('/finance/receipts', {
      bankAccountId, matterId, receivedOn: statementDate, amount: '100.00', reference, purpose: 'Funds on account',
    });
    const imported = await api(accountsToken).import(csv());
    expect((await api(accountsToken).import(csv())).status).toBe(409);
    const wrong = await api(accountsToken).post(`/finance/statement-rows/${imported.body.rows[0].id}/matches`, { financeTransactionId: randomUUID() });
    expect(wrong.status).toBe(404);
    const matched = await api(accountsToken).post(`/finance/statement-rows/${imported.body.rows[0].id}/matches`, { financeTransactionId: receipt.body.id });
    const reversed = await api(accountsToken).post(`/finance/statement-matches/${matched.body.id}/reverse`, { reason: 'Selected in error' });
    expect(reversed.status).toBe(201);
    expect((await api(accountsToken).post(`/finance/statement-rows/${imported.body.rows[0].id}/matches`, { financeTransactionId: receipt.body.id })).status).toBe(201);
    const status = await api(accountsToken).get('/finance/reconciliations/status');
    expect(status.status).toBe(200);
    expect(status.body.bankAccounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ bankAccountId, lastStatementEnd: statementDate }),
    ]));
    expect(status.body.reconciliation.state).not.toBe('not_applicable');
  });

  it('rolls back an import when its audit record fails', async () => {
    const audit = app.get(AuditService);
    const record = audit.record.bind(audit);
    const failure = vi.spyOn(audit, 'record').mockImplementation((event, transaction) =>
      event.action === 'finance.bank_statement_imported'
        ? Promise.reject(new Error('audit unavailable'))
        : record(event, transaction),
    );
    let response: request.Response;
    try {
      response = await api(accountsToken).import(csv(), { fileName: 'rollback-statement.csv' });
    } finally {
      failure.mockRestore();
    }
    expect(response!.status).toBe(500);
    expect(await db.selectFrom('bank_statement_imports').select('id')
      .where('file_name', '=', 'rollback-statement.csv').executeTakeFirst()).toBeUndefined();
  });
});
