import { randomBytes, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearMatterForTests } from '../../test/aml.js';
import { createTestAccount, grantTestRole, revokeTestRole, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database, StaffRole } from '../database/schema.js';

describe('bank statement and reconciliation database rules', () => {
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let accounts: TestAccount;
  let compliance: TestAccount;
  let feeEarner: TestAccount;
  let partner: TestAccount;
  let bankId: string;
  let matterId: string;
  let today: string;
  // Keep these whole-ledger snapshot fixtures earlier than the controller suites,
  // which also exercise reconciliation against the shared test database.
  let testDay = 1_000;
  const unique = () => randomUUID().replaceAll('-', '').slice(0, 16);

  async function staffWith(...roles: StaffRole[]) {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) await grantTestRole(db, account.id, role);
    return account;
  }

  async function createMatter() {
    return db.transaction().execute(async (trx) => {
      const client = await trx.insertInto('clients').values({ kind: 'individual', created_by: feeEarner.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({
        client_id: client.id, given_names: unique(), family_name: unique(), address_line1: '1 Bank Street',
        town: 'London', postcode: 'SW1A 1AA', country: 'GB',
      }).execute();
      const check = await trx.insertInto('conflict_checks').values({ client_id: client.id, requested_by: feeEarner.id, names: [unique()] }).returning('id').executeTakeFirstOrThrow();
      const matter = await trx.insertInto('matters').values({ client_id: client.id, title: 'Reconciliation', matter_type: 'other', opened_by: feeEarner.id, conflict_check_id: check.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('matter_team').values([
        { matter_id: matter.id, account_id: feeEarner.id, role: 'fee_earner', added_by: feeEarner.id },
        { matter_id: matter.id, account_id: partner.id, role: 'supervising_partner', added_by: feeEarner.id },
      ]).execute();
      return matter.id;
    }).then(async (matterId) => {
      await clearMatterForTests(db, matterId);
      return matterId;
    });
  }

  async function createBank(kind: 'client' | 'business' = 'client') {
    return (await sql<{ id: string }>`select app.create_bank_account(
      ${kind}, ${`Statement ${unique()}`}, '1234', ${randomUUID()}::uuid, ${randomBytes(32)},
      1::smallint, ${randomBytes(12)}, ${randomBytes(20)}, ${randomBytes(16)}, ${today}::date, ${accounts.id}
    ) as id`.execute(db)).rows[0]!.id;
  }

  const row = (amount = '10000', reference = 'BANK-1') => [{
    occurred_on: today, amount_pence: amount, reference, description: 'Client receipt',
    fingerprint: randomBytes(32).toString('base64'),
  }];

  async function importStatement(rows = row(), opening = '0', closing = '10000', hash = randomBytes(32), actor = accounts.id, targetBank = bankId) {
    return (await sql<{ id: string }>`select app.create_bank_statement_import(
      ${targetBank}, ${today}::date, ${today}::date, ${opening}::bigint, ${closing}::bigint,
      'statement.csv', ${hash}, ${JSON.stringify(rows)}::jsonb, ${actor}
    ) as id`.execute(db)).rows[0]!.id;
  }

  async function receipt(reference = 'BANK-1') {
    return (await sql<{ id: string }>`select app.record_finance_receipt(
      ${bankId}, ${matterId}, ${today}::date, 10000::bigint, ${reference}, 'Funds on account', ${accounts.id}
    ) as id`.execute(db)).rows[0]!.id;
  }

  beforeAll(() => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 2);
    ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 2);
  });
  afterAll(async () => { await ownerDb.destroy(); await db.destroy(); });

  beforeEach(async () => {
    testDay += 1;
    today = (await sql<{ today: string }>`select ((clock_timestamp() at time zone 'Europe/London')::date - ${testDay}::integer)::text as today`.execute(db)).rows[0]!.today;
    accounts = await staffWith('accounts');
    compliance = await staffWith('compliance');
    feeEarner = await staffWith('fee_earner');
    partner = await staffWith('partner');
    matterId = await createMatter();
    bankId = await createBank();
  });

  it('imports a balanced statement through the narrow function and makes it immutable', async () => {
    const id = await importStatement();
    const imported = await db.selectFrom('bank_statement_imports').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(imported).toMatchObject({ bank_account_id: bankId, row_count: 1, closing_balance_pence: '10000' });
    await expect(sql`insert into bank_statement_imports (bank_account_id) values (${bankId})`.execute(db)).rejects.toThrow(/permission denied/i);
    await expect(sql`update bank_statement_imports set closing_balance_pence = 0 where id = ${id}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
    await expect(sql`delete from bank_statement_imports where id = ${id}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
  });

  it('refuses duplicate files, duplicate rows and bad totals', async () => {
    const rows = row();
    const hash = randomBytes(32);
    await expect(importStatement(row(), '0', '9999')).rejects.toThrow(/do not reconcile/i);
    await importStatement(rows, '0', '10000', hash);
    await expect(importStatement(row(), '0', '10000', hash)).rejects.toThrow(/duplicate|unique/i);
    await expect(importStatement(rows)).rejects.toThrow(/duplicate|unique/i);
  });

  it('requires a live Accounts importer', async () => {
    await expect(importStatement(row(), '0', '10000', randomBytes(32), feeEarner.id)).rejects.toThrow(/active accounts/i);
    await revokeTestRole(db, accounts.id, 'accounts');
    await expect(importStatement()).rejects.toThrow(/active accounts/i);
  });

  it('holds the Compliance role used by an in-progress finance check', async () => {
    const transactionId = await receipt();
    const statementId = await importStatement();
    const statementRow = await db.selectFrom('bank_statement_rows').select('id')
      .where('statement_import_id', '=', statementId).executeTakeFirstOrThrow();
    await sql`select app.match_bank_statement_row(${statementRow.id}, ${transactionId}, ${accounts.id})`.execute(db);
    const reconciliationId = (await sql<{ id: string }>`select app.prepare_client_account_reconciliation(
      ${today}::date, ${[statementId]}::uuid[], '{}'::jsonb, ${accounts.id}
    ) as id`.execute(db)).rows[0]!.id;
    let roleChecked!: () => void;
    let finishCheck!: () => void;
    const checked = new Promise<void>((resolve) => (roleChecked = resolve));
    const finish = new Promise<void>((resolve) => (finishCheck = resolve));
    const check = db.transaction().execute(async (trx) => {
      await sql`select app.sign_off_client_account_reconciliation(
        ${reconciliationId}, ${compliance.id}
      )`.execute(trx);
      roleChecked();
      await finish;
    });
    await checked;
    const revocation = revokeTestRole(db, compliance.id, 'compliance');
    const early = await Promise.race([
      revocation.then(() => 'finished'),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50)),
    ]);
    finishCheck();
    await Promise.all([check, revocation]);
    expect(early).toBe('waiting');
  });

  it('matches only exact posted bank facts, reverses by event, and permits a corrected rematch', async () => {
    const transactionId = await receipt();
    const statementId = await importStatement();
    const statementRow = await db.selectFrom('bank_statement_rows').select('id').where('statement_import_id', '=', statementId).executeTakeFirstOrThrow();
    const match = (await sql<{ id: string }>`select app.match_bank_statement_row(${statementRow.id}, ${transactionId}, ${accounts.id}) as id`.execute(db)).rows[0]!.id;
    await expect(sql`select app.match_bank_statement_row(${statementRow.id}, ${transactionId}, ${accounts.id})`.execute(db)).rejects.toThrow(/already matched/i);
    await sql`select app.reverse_bank_statement_match(${match}, 'Matched in error', ${accounts.id})`.execute(db);
    await expect(sql`select app.reverse_bank_statement_match(${match}, 'Again', ${accounts.id})`.execute(db)).rejects.toThrow(/already reversed/i);
    await expect(sql`select app.match_bank_statement_row(${statementRow.id}, ${transactionId}, ${accounts.id})`.execute(db)).resolves.toBeDefined();
    expect(await db.selectFrom('bank_statement_match_events').selectAll().where('statement_row_id', '=', statementRow.id).execute()).toHaveLength(3);
    const secondStatement = await importStatement([{ ...row()[0]!, description: 'Same bank transaction repeated' }]);
    const secondRow = await db.selectFrom('bank_statement_rows').select('id').where('statement_import_id', '=', secondStatement).executeTakeFirstOrThrow();
    await expect(sql`select app.match_bank_statement_row(${secondRow.id}, ${transactionId}, ${accounts.id})`.execute(db)).rejects.toThrow(/transaction is already matched/i);
  });

  it('refuses mismatched reference, amount, date or account', async () => {
    const transactionId = await receipt('POSTED-REF');
    const statementId = await importStatement(row('10000', 'OTHER-REF'));
    const statementRow = await db.selectFrom('bank_statement_rows').select('id').where('statement_import_id', '=', statementId).executeTakeFirstOrThrow();
    await expect(sql`select app.match_bank_statement_row(${statementRow.id}, ${transactionId}, ${accounts.id})`.execute(db)).rejects.toThrow(/account, amount, date and reference/i);
  });

  it('prepares a server-calculated fixed snapshot and requires separate active Compliance sign-off', async () => {
    const transactionId = await receipt();
    const statementId = await importStatement();
    const statementRow = await db.selectFrom('bank_statement_rows').select('id').where('statement_import_id', '=', statementId).executeTakeFirstOrThrow();
    await sql`select app.match_bank_statement_row(${statementRow.id}, ${transactionId}, ${accounts.id})`.execute(db);
    const reconciliationId = (await sql<{ id: string }>`select app.prepare_client_account_reconciliation(
      ${today}::date, ${[statementId]}::uuid[], '{}'::jsonb, ${accounts.id}
    ) as id`.execute(db)).rows[0]!.id;
    const snapshot = await db.selectFrom('client_account_reconciliations').selectAll().where('id', '=', reconciliationId).executeTakeFirstOrThrow();
    expect(snapshot).toMatchObject({ bank_balance_pence: '10000', cashbook_balance_pence: '10000', client_ledger_balance_pence: '10000' });
    const snapshotBalance = await db.selectFrom('client_account_reconciliation_balances')
      .select(['client_id', 'matter_id', 'balance_pence'])
      .where('reconciliation_id', '=', reconciliationId).executeTakeFirstOrThrow();
    expect(snapshotBalance).toEqual({ client_id: expect.any(String), matter_id: matterId, balance_pence: '10000' });
    expect(await db.selectFrom('client_account_reconciliation_items').selectAll().where('reconciliation_id', '=', reconciliationId).execute()).toEqual([]);
    await expect(sql`select app.sign_off_client_account_reconciliation(${reconciliationId}, ${accounts.id})`.execute(db)).rejects.toThrow(/active compliance/i);
    await grantTestRole(db, accounts.id, 'compliance');
    await expect(sql`select app.sign_off_client_account_reconciliation(${reconciliationId}, ${accounts.id})`.execute(db)).rejects.toThrow(/own reconciliation/i);
    await sql`select app.sign_off_client_account_reconciliation(${reconciliationId}, ${compliance.id})`.execute(db);
    await expect(sql`select app.sign_off_client_account_reconciliation(${reconciliationId}, ${compliance.id})`.execute(db)).rejects.toThrow(/duplicate|unique/i);
    await expect(sql`update client_account_reconciliations set bank_balance_pence = 0 where id = ${reconciliationId}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
    await expect(sql`update client_account_reconciliation_balances set balance_pence = 1 where reconciliation_id = ${reconciliationId}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
    await expect(sql`insert into client_account_reconciliation_balances (
      reconciliation_id, client_id, matter_id, balance_pence
    ) values (${reconciliationId}, ${snapshotBalance.client_id}, ${matterId}, 1)`.execute(db)).rejects.toThrow(/permission denied/i);
  });

  it('requires explanations for every unmatched item and each non-zero difference', async () => {
    const statementId = await importStatement();
    await expect(sql`select app.prepare_client_account_reconciliation(
      ${today}::date, ${[statementId]}::uuid[], '{}'::jsonb, ${accounts.id}
    )`.execute(db)).rejects.toThrow(/explanation/i);
    const statementRow = await db.selectFrom('bank_statement_rows').select('id').where('statement_import_id', '=', statementId).executeTakeFirstOrThrow();
    const explanations = {
      [`statement:${statementRow.id}`]: 'Receipt has not yet been posted',
      'difference:bank-cashbook': 'The unposted receipt explains this difference',
    };
    const id = (await sql<{ id: string }>`select app.prepare_client_account_reconciliation(
      ${today}::date, ${[statementId]}::uuid[], ${JSON.stringify(explanations)}::jsonb, ${accounts.id}
    ) as id`.execute(db)).rows[0]!.id;
    expect(await db.selectFrom('client_account_reconciliation_items').selectAll().where('reconciliation_id', '=', id).execute()).toHaveLength(2);
  });

  it('covers every open client bank but allows business statement monitoring separately', async () => {
    const secondClient = await createBank('client');
    const business = await createBank('business');
    const firstStatement = await importStatement();
    await importStatement(row(), '0', '10000', randomBytes(32), accounts.id, business);
    await expect(sql`select app.prepare_client_account_reconciliation(
      ${today}::date, ${[firstStatement]}::uuid[], '{}'::jsonb, ${accounts.id}
    )`.execute(db)).rejects.toThrow(/every open client/i);
    expect(secondClient).toBeTruthy();
  });
});
